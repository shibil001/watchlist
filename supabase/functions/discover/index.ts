// Supabase Edge Function: "discover" (the Discover tab).
//
//   GET  ?seeds=movie:603,tv:1396&liked=movie:11   -> { profile, picks, trending }
//          seeds = the titles you WATCHED (best rated first, at most 12): THE TASTE PROFILE. It decides everything.
//          liked = titles you added from Discover before (at most 8), a lighter signal.
//          picks    = a pool of up to 60 titles that fit that taste (any title: recommendations of your watched titles,
//                     and the best titles in your genres and languages). The app draws 5 a day from it.
//          trending = this week's trending films and series, each with its taste score (the app shows them twice:
//                     re-ranked by taste, and as they are).
//   POST {shown:[keys], added:[keys]}               -> counts what was on screen and what was added, for EVERYONE (table discover_votes).
//          Titles many people add (and do not just see) score higher in every pool.
//
// Deploy:  supabase functions deploy discover --no-verify-jwt        (needs secret TMDB_API_KEY and supabase/discover.sql run once)

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; t: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.t > windowMs) { hits.set(ip, { n: 1, t: now }); if (hits.size > 5000) hits.clear(); return false; }
    return ++h.n > max;
  };
}
const getLimited = limiter(20, 60_000), postLimited = limiter(12, 60_000);

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const int = (v: unknown) => (/^\d{1,9}$/.test(String(v ?? "")) ? Number(v) : 0);
const keyOk = (k: unknown) => typeof k === "string" && /^(movie|tv):\d{1,9}$/.test(k);
const parseKeys = (s: string | null, max: number) => (s || "").split(",").map((x) => x.trim()).filter(keyOk).slice(0, max);

async function tmdb(path: string, params: Record<string, string> = {}) {
  const u = new URL("https://api.themoviedb.org/3" + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("api_key", Deno.env.get("TMDB_API_KEY") || "");
  for (let tries = 0; tries < 3; tries++) {
    const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
    if (!r.ok) throw new Error("TMDB " + r.status);
    return await r.json();
  }
  throw new Error("TMDB busy");
}

// small answer cache (lives as long as this instance does)
const cache = new Map<string, { exp: number; v: unknown }>();
const cget = <T>(k: string): T | null => { const c = cache.get(k); if (!c) return null; if (c.exp < Date.now()) { cache.delete(k); return null; } return c.v as T; };
const cset = (k: string, v: unknown, ttl: number) => { if (cache.size > 600) cache.delete(cache.keys().next().value as string); cache.set(k, { exp: Date.now() + ttl, v }); };
async function cached<T>(k: string, ttl: number, f: () => Promise<T>): Promise<T> {
  const hit = cget<T>(k); if (hit) return hit;
  const v = await f(); cset(k, v, ttl); return v;
}

// ---------- genres: movie and series ids are brought to one set ----------
const GMAP: Record<number, number[]> = { 10759: [28, 12], 10765: [878, 14], 10768: [10752, 36], 10762: [16, 10751], 10766: [18] };
const common = (ids: number[]) => [...new Set((ids || []).flatMap((g) => GMAP[g] ?? [g]))];
const GNAME: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
  27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 53: "Thriller", 10752: "War", 37: "Western",
};
const TV_OF: Record<number, number> = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 }; // movie genre -> a series genre

// ---------- the taste profile ----------
type Seed = { title: string; key: string; kind: string; lang: string; genres: number[]; year: number; rating: number; w: number; recs: any[] };
async function loadSeed(key: string, w: number): Promise<Seed | null> {
  const [kind, id] = key.split(":");
  try {
    const r = await cached("seed:" + key, 6 * 3600_000, () => tmdb(`/${kind}/${id}`, { append_to_response: "recommendations" }));
    return {
      title: r.title || r.name || "", key, kind, lang: r.original_language || "", genres: common((r.genres || []).map((g: any) => g.id)),
      year: Number(String(r.release_date || r.first_air_date || "").slice(0, 4)) || 0, rating: r.vote_average || 0, w,
      recs: (r.recommendations?.results || []).slice(0, 14),
    };
  } catch { return null; }
}
type Profile = { gw: Map<number, number>; lw: Map<string, number>; year: number; tvShare: number; top3: number; seeds: Set<string> };
function profileOf(seeds: Seed[]): Profile {
  const gw = new Map<number, number>(), lw = new Map<string, number>();
  let wsum = 0, ysum = 0, yw = 0, tv = 0;
  for (const s of seeds) {
    wsum += s.w; if (s.kind === "tv") tv += s.w;
    for (const g of s.genres) gw.set(g, (gw.get(g) || 0) + s.w);
    if (s.lang) lw.set(s.lang, (lw.get(s.lang) || 0) + s.w);
    if (s.year) { ysum += s.year * s.w; yw += s.w; }
  }
  const norm = <K>(m: Map<K, number>) => { const mx = Math.max(0, ...m.values()) || 1; for (const [k, v] of m) m.set(k, v / mx); };
  norm(gw); norm(lw);
  const top3 = [...gw.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0) || 1;
  return { gw, lw, year: yw ? ysum / yw : 0, tvShare: wsum ? tv / wsum : 0, top3, seeds: new Set(seeds.map((s) => s.key)) };
}

// ---------- one title ----------
type Cand = { key: string; kind: string; id: number; title: string; poster_path: string | null; release_date: string; first_air_date: string; vote_average: number; vote_count: number; lang: string; genres: number[]; rec: number };
const slim = (kind: string, r: any): Cand | null => {
  if (!r || !r.id || r.adult || !r.poster_path) return null;
  return {
    key: kind + ":" + r.id, kind, id: r.id, title: r.title || r.name || "", poster_path: r.poster_path, release_date: r.release_date || "", first_air_date: r.first_air_date || "",
    vote_average: r.vote_average || 0, vote_count: r.vote_count || 0, lang: r.original_language || "", genres: common(r.genre_ids || (r.genres || []).map((g: any) => g.id)), rec: 0,
  };
};
type Crowd = { shown: number; added: number };
function taste(p: Profile, c: Cand, crowd?: Crowd): number {
  const genre = clamp(c.genres.reduce((s, g) => s + (p.gw.get(g) || 0), 0) / p.top3);
  const lang = p.lw.get(c.lang) ?? (c.lang === "en" ? 0.25 : 0.05);
  const rec = clamp(c.rec / 2);
  const quality = clamp((c.vote_average - 5.5) / 3) * Math.min(1, c.vote_count / 300);
  const y = Number(String(c.release_date || c.first_air_date).slice(0, 4)) || 0;
  const era = !p.year || !y ? 0.5 : clamp(1 - Math.max(0, Math.abs(y - p.year) - 8) / 30);
  const cr = crowd ? clamp(((crowd.added + 0.5) / (crowd.shown + 6)) / 0.25) : 0;
  return clamp(0.3 * genre + 0.22 * lang + 0.22 * rec + 0.14 * quality + 0.06 * era + 0.06 * cr);
}
const out = (p: Profile, c: Cand, crowd?: Crowd) => {
  const t = taste(p, c, crowd);
  const why = c.genres.filter((g) => GNAME[g]).sort((a, b) => (p.gw.get(b) || 0) - (p.gw.get(a) || 0)).slice(0, 2).map((g) => GNAME[g]);
  return {
    id: c.id, media_type: c.kind, title: c.title, poster_path: c.poster_path, release_date: c.release_date, first_air_date: c.first_air_date,
    vote_average: c.vote_average, lang: c.lang, taste: Math.round(t * 1000) / 1000, pct: Math.round(clamp(t * 1.15) * 100), why,
  };
};

async function crowdOf(keys: string[]): Promise<Map<string, Crowd>> {
  const m = new Map<string, Crowd>();
  try {
    for (let i = 0; i < keys.length; i += 100) {
      const { data } = await db.from("discover_votes").select("cand_key,shown,added").in("cand_key", keys.slice(i, i + 100));
      for (const r of data || []) m.set(r.cand_key, { shown: r.shown, added: r.added });
    }
  } catch { /* table missing: discover.sql not run */ }
  return m;
}

// ---------- Gemini: titles with the same taste, in your main language and a mix of others (answer saved 6 hours; no GEMINI_API_KEY = skipped) ----------
const LANG_NAME: Record<string, string> = { ml: "Malayalam", hi: "Hindi", ta: "Tamil", te: "Telugu", kn: "Kannada", bn: "Bengali", mr: "Marathi", pa: "Punjabi", en: "English", ko: "Korean", ja: "Japanese", fr: "French", es: "Spanish", de: "German", it: "Italian", zh: "Chinese", th: "Thai", tr: "Turkish", pt: "Portuguese", ru: "Russian", sv: "Swedish", da: "Danish", ar: "Arabic", ur: "Urdu", fa: "Persian", he: "Hebrew", id: "Indonesian", ms: "Malay", vi: "Vietnamese", tl: "Filipino", pl: "Polish", nl: "Dutch", el: "Greek", uk: "Ukrainian", ru: "Russian", si: "Sinhala", ne: "Nepali", no: "Norwegian", fi: "Finnish", cs: "Czech", hu: "Hungarian", ro: "Romanian", sw: "Swahili", af: "Afrikaans", cn: "Cantonese" };
async function geminiTitles(seeds: Seed[], topL: string[], n: number): Promise<{ title: string; year: number }[]> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key || !seeds.length) return [];
  const watched = seeds.slice(0, 10).map((s) => `${s.title}${s.year ? " (" + s.year + ")" : ""} [${LANG_NAME[s.lang] || s.lang}]`).join("; ");
  const main = LANG_NAME[topL[0]] || "";
  const prompt = `A viewer's recently watched titles (newest first): ${watched}.\nRecommend ${n} films and series they would love, chosen by story and emotional taste, not just genre. ` +
    (main ? `About half must be ${main}, and the other half a mix of other languages (for example ${["Hindi", "Tamil", "Korean", "English", "Japanese", "French", "Spanish"].filter((x) => x !== main).join(", ")}). ` : "Mix several languages. ") +
    `Mix famous and lesser-known titles. Never include the titles they already watched. Only real titles with the correct release year. Return ONLY a JSON array like [{"title":"...","year":2016}].`;
  for (const model of [Deno.env.get("GEMINI_MODEL") || "", "gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-flash-latest"].filter(Boolean)) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.6, responseMimeType: "application/json", maxOutputTokens: 2048 } }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const text = (j?.candidates?.[0]?.content?.parts || []).map((x: any) => x?.text || "").join("");
      const arr = JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
      const out = (Array.isArray(arr) ? arr : []).map((o: any) => ({ title: String(o?.title || "").slice(0, 120), year: Number(o?.year) || 0 })).filter((o: { title: string }) => o.title).slice(0, n);
      if (out.length) return out;
    } catch { /* next model */ }
  }
  return [];
}

async function build(seedKeys: string[], likedKeys: string[]) {
  const seeds = (await Promise.all([
    ...seedKeys.map((k, i) => loadSeed(k, Math.max(0.35, 1 - i * 0.05))),
    ...likedKeys.map((k) => loadSeed(k, 0.5)),
  ])).filter(Boolean) as Seed[];
  const p = profileOf(seeds);
  const pool = new Map<string, Cand>();
  const add = (kind: string, r: any, rec = 0) => {
    const c = slim(kind, r); if (!c || p.seeds.has(c.key)) return;
    const had = pool.get(c.key); if (had) { had.rec += rec; return; }
    c.rec = rec; pool.set(c.key, c);
  };
  for (const s of seeds) for (const r of s.recs) add(s.kind, r, s.w); // recommended after a title you watched
  // any title in your genres and languages: random pages, so every list is a little different
  const topG = [...p.gw.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 3);
  const topL = [...p.lw.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l).slice(0, 2);
  const kinds = p.tvShare >= 0.25 ? ["movie", "tv"] : ["movie"];
  const page = () => String(1 + Math.floor(Math.random() * 4));
  const jobs: Promise<void>[] = [];
  for (const kind of kinds) {
    const g = (ids: number[]) => ids.map((x) => (kind === "tv" ? TV_OF[x] ?? x : x)).join("|");
    const base = { sort_by: "popularity.desc", "vote_count.gte": "150", "vote_average.gte": "6.6", include_adult: "false" };
    const run = (extra: Record<string, string>) => jobs.push(tmdb(`/discover/${kind}`, { ...base, page: page(), ...extra }).then((d) => { for (const r of d.results || []) add(kind, r); }).catch(() => {}));
    const lowBar = (l: string): Record<string, string> => (l === "en" ? {} : { "vote_count.gte": "25", "vote_average.gte": "6.3" });
    for (const l of topL) run({ with_original_language: l, ...lowBar(l), ...(topG.length ? { with_genres: g(topG.slice(0, 2)) } : {}) });
    for (const l of topL) {
      run({ with_original_language: l, ...lowBar(l) });
      run({ with_original_language: l, ...lowBar(l), sort_by: "vote_average.desc", "vote_count.gte": l === "en" ? "400" : "40" });
    }
    if (topG.length) run({ with_genres: g(topG), "vote_count.gte": "500", "vote_average.gte": "7.2" }); // the best in your genres, any language
  }
  jobs.push(tmdb("/trending/movie/week").then((d) => { for (const r of (d.results || []).slice(0, 10)) add("movie", r); }).catch(() => {}));
  await Promise.all(jobs);
  // Gemini: the same taste, half in your main language, half a mix; each name is looked up on TMDB
  try {
    const titles = await cached("gem2:" + seedKeys.join(",") + "|" + likedKeys.join(","), 6 * 3600_000, () => geminiTitles(seeds, topL, 28));
    for (let i = 0; i < titles.length; i += 7) {
      await Promise.all(titles.slice(i, i + 7).map(async (t) => {
        for (const kind of kinds) {
          try {
            const dd = await tmdb(`/search/${kind}`, { query: t.title, ...(t.year ? { [kind === "tv" ? "first_air_date_year" : "year"]: String(t.year) } : {}) });
            const hit = (dd.results || []).find((x: any) => x.poster_path);
            if (hit) { add(kind, hit, 1); break; }
          } catch { /* skip this one */ }
        }
      }));
    }
  } catch { /* Gemini is a bonus */ }
  // what people of this app add most joins the pool too (only titles that fit the taste are kept)
  try {
    const { data } = await db.from("discover_votes").select("cand_key,shown,added").gte("added", 2).order("added", { ascending: false }).limit(12);
    await Promise.all((data || []).filter((r) => keyOk(r.cand_key) && !pool.has(r.cand_key) && !p.seeds.has(r.cand_key)).slice(0, 6).map(async (r) => {
      const [kind, id] = r.cand_key.split(":");
      try { add(kind, await cached("det:" + r.cand_key, 24 * 3600_000, () => tmdb(`/${kind}/${id}`))); } catch { /* skip */ }
    }));
  } catch { /* table missing */ }
  const crowd = await crowdOf([...pool.keys()]);
  const picks = [...pool.values()].map((c) => out(p, c, crowd.get(c.key))).sort((a, b) => b.taste - a.taste).slice(0, 100);

  const tr = (await globalTrending().catch(() => [] as Cand[])).filter((c) => !p.seeds.has(c.key)); // worldwide mix of languages, already in trending order
  const tc = await crowdOf(tr.map((c) => c.key));
  const trending = tr.map((c, i) => ({ ...out(p, c, tc.get(c.key)), rank: i }));

  const profile = {
    genres: topG.filter((g) => GNAME[g]).map((g) => GNAME[g]),
    langs: topL, n: seeds.length,
  };
  return { profile, picks, trending };
}

// ---------- trending v2: worldwide mix + "Trending in <country>" (regional v2) ----------
// "Trending" = what people are watching and searching NOW. Three signals, none of them a guess:
//   1. TMDB popularity (TMDB counts views, searches, list adds and votes every day), taken per language so English does not drown everything.
//   2. Gemini with live Google Search ("what are people in <country> searching and watching this week"). Every title it names is checked on TMDB (name + year).
//      Needs the GEMINI_API_KEY secret; without it this signal is skipped.
//   3. Titles people in that country added to a list in the last 7 days (table discover_region_adds).
// Which country: the person's choice (?country=IN), else Cloudflare's cf-ipcountry header, else the device language region (?hl=IN).
// Local (primary) film languages per country, TMDB/ISO 639-1 codes. Countries not listed still work: they use cinemas, streaming, home-made titles and Google.
const REGION_LANGS: Record<string, string[]> = {
  IN: ["ml", "hi", "ta", "te", "kn"], PK: ["ur", "pa"], BD: ["bn"], LK: ["si", "ta"], NP: ["ne"], AF: ["fa", "ps"], IR: ["fa"], IQ: ["ar"], IL: ["he"],
  AE: ["ar"], SA: ["ar"], QA: ["ar"], KW: ["ar"], OM: ["ar"], BH: ["ar"], YE: ["ar"], JO: ["ar"], LB: ["ar", "fr"], SY: ["ar"], PS: ["ar"],
  EG: ["ar"], LY: ["ar"], TN: ["ar", "fr"], DZ: ["ar", "fr"], MA: ["ar", "fr"], SD: ["ar"], KE: ["sw"], TZ: ["sw"], ET: ["am"], CM: ["fr"], SN: ["fr"], CI: ["fr"], NG: [], GH: [], ZA: ["af"],
  ID: ["id"], MY: ["ms", "zh", "ta"], SG: ["zh", "ms", "ta"], TH: ["th"], VN: ["vi"], PH: ["tl"], KH: ["km"], MM: ["my"], KR: ["ko"], JP: ["ja"], CN: ["zh"], HK: ["cn", "zh"], TW: ["zh"],
  TR: ["tr"], RU: ["ru"], UA: ["uk", "ru"], BY: ["ru"], KZ: ["ru", "kk"], KG: ["ru"], UZ: ["uz"], AZ: ["az"], AM: ["hy"], GE: ["ka"], CY: ["el", "tr"], GR: ["el"],
  DE: ["de"], AT: ["de"], CH: ["de", "fr", "it"], FR: ["fr"], BE: ["fr", "nl"], NL: ["nl"], IT: ["it"], ES: ["es"], PT: ["pt"], SE: ["sv"], NO: ["no"], DK: ["da"], FI: ["fi"], IS: ["is"],
  PL: ["pl"], CZ: ["cs"], SK: ["sk"], HU: ["hu"], RO: ["ro"], BG: ["bg"], RS: ["sr"], HR: ["hr"], BA: ["bs"], SI: ["sl"], AL: ["sq"], LT: ["lt"], LV: ["lv"], EE: ["et"],
  MX: ["es"], AR: ["es"], CL: ["es"], CO: ["es"], PE: ["es"], VE: ["es"], EC: ["es"], BO: ["es"], UY: ["es"], PY: ["es"], CR: ["es"], PA: ["es"], GT: ["es"], HN: ["es"], SV: ["es"], DO: ["es"], CU: ["es"], BR: ["pt"],
  CA: [], US: [], GB: [], IE: [], AU: [], NZ: [],
};
// Languages of the people who live and work in a country but are not its own: they get a small share of the row, never most of it.
const REGION_EXPAT: Record<string, string[]> = { AE: ["hi", "ml"], SA: ["hi", "ml"], QA: ["hi", "ml"], KW: ["hi", "ml"], OM: ["hi", "ml"], BH: ["hi", "ml"], SG: ["hi"], MY: ["hi"] };
// Global trending = worldwide titles + big international languages. Indian regional languages (Hindi, Malayalam, Tamil, Telugu, Kannada) are NOT here: they belong to "Trending in <country>".
const GLOBAL_LANGS = ["ko", "ja", "es", "fr", "tr", "ar", "th", "zh", "de", "pt"];
// Series: scripted series stay; reality, talk, game, news and soap shows are left out of both rows. Set SHOW_SERIES to false for films only.
const SHOW_SERIES = true;
const SKIP_TV = [10764, 10767, 10763, 10766]; // TMDB genres: Reality, Talk, News, Soap
const NO_TV_GENRES = { without_genres: SKIP_TV.join(",") };
const tvOk = (r: any) => SHOW_SERIES && !(r?.genre_ids || []).some((g: number) => SKIP_TV.includes(g));
const ccOf = (v: unknown) => { const s = String(v ?? "").trim().toUpperCase(); return /^[A-Z]{2}$/.test(s) && s !== "XX" && s !== "T1" ? s : ""; };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// an answer saved for everyone in the database (table discover_trend_cache) and in memory; without the table it is memory only
async function pcached<T>(key: string, ttl: number, f: () => Promise<T>): Promise<T> {
  const hit = cget<T>(key); if (hit) return hit;
  try {
    const { data } = await db.from("discover_trend_cache").select("body,updated_at").eq("k", key).maybeSingle();
    if (data && Date.now() - new Date(data.updated_at).getTime() < ttl) { cset(key, data.body, ttl); return data.body as T; }
  } catch { /* table missing */ }
  const v = await f();
  if (Array.isArray(v) && !v.length) return v; // an empty answer (a failed lookup) is never saved
  cset(key, v, ttl);
  try { await db.from("discover_trend_cache").upsert({ k: key, body: v as unknown as Record<string, unknown>, updated_at: new Date().toISOString() }); } catch { /* ignore */ }
  return v;
}

type GemTitle = { title: string; year: number; kind: string };
async function geminiTrending(country: string, langs: string[], topic = ""): Promise<GemTitle[]> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return [];
  let where = "all over the world";
  try { if (country) where = "in " + (new Intl.DisplayNames(["en"], { type: "region" }).of(country) || country); } catch { /* keep the world */ }
  const names = (country ? langs : ["English", "Korean", "Japanese", "Spanish", "French", "Turkish", "Arabic"]).map((l) => LANG_NAME[l] || l).join(", ");
  const prompt = topic === "anime"
    ? `Use Google Search. Which anime (Japanese animated series and films) are people all over the world watching and searching for the most this week? ` +
      `Give the 20 biggest right now, in order, the biggest first. Anime only: no live-action, no Western cartoons, no Chinese or Korean animation. ` +
      `Only real titles that are really trending this week, with the correct release year. Return ONLY a JSON array like [{"title":"...","year":2025,"type":"tv"}] where type is movie or tv.`
    : `Use Google Search. Which films and series are people ${where} watching and searching for the most this week (cinemas, streaming and TV)? ` +
    `Give the 20 biggest right now, in order, the biggest first. Films and scripted series only: no reality shows, talk shows, game shows, wrestling, news or soap operas. ${country ? `Mostly what people who live ${where} watch, including their own local-language films and series, and only titles that are legally released or streamed ${where}: leave out anything banned, censored or not available there. ` : "Pick titles that people in many countries are watching, not titles that are big in only one country. "}Include titles in these languages too, not only English: ${names}. ` +
    `Only real titles that are really trending this week, with the correct release year. Return ONLY a JSON array like [{"title":"...","year":2025,"type":"movie"}] where type is movie or tv.`;
  for (const model of [Deno.env.get("GEMINI_MODEL") || "", "gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-flash-latest"].filter(Boolean)) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2, maxOutputTokens: 2048 } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const text = (j?.candidates?.[0]?.content?.parts || []).map((x: any) => x?.text || "").join("");
      const a = text.indexOf("["), b = text.lastIndexOf("]");
      if (a < 0 || b <= a) continue;
      const arr = JSON.parse(text.slice(a, b + 1));
      const list = (Array.isArray(arr) ? arr : []).map((o: any) => ({
        title: String(o?.title || "").slice(0, 120), year: Number(o?.year) || 0,
        kind: /^(tv|series|show)/i.test(String(o?.type || "")) ? "tv" : "movie",
      })).filter((o: GemTitle) => o.title).slice(0, 20);
      if (list.length) return list;
    } catch { /* next model */ }
  }
  return [];
}

// each name Gemini gave is looked up on TMDB; a hit must have the same year (one year off is allowed), so a wrong guess is dropped
async function resolveTitles(list: GemTitle[]): Promise<Cand[]> {
  const res: Cand[] = [];
  for (let i = 0; i < list.length; i += 7) {
    const part = await Promise.all(list.slice(i, i + 7).map(async (t) => {
      for (const kind of t.kind === "tv" ? ["tv", "movie"] : ["movie", "tv"]) {
        try {
          const dd = await tmdb(`/search/${kind}`, { query: t.title });
          const hit = (dd.results || []).slice(0, 5).find((x: any) => x.poster_path && (kind !== "tv" || tvOk(x)) &&
            (!t.year || Math.abs((Number(String(x.release_date || x.first_air_date || "").slice(0, 4)) || 0) - t.year) <= 1));
          const c = hit ? slim(kind, hit) : null;
          if (c) return c;
        } catch { /* try the other kind */ }
      }
      return null;
    }));
    for (const c of part) if (c) res.push(c);
  }
  return res;
}

// "Trending now": a worldwide MIX. Lists are taken one rank at a time from: Gemini (live Google Search), TMDB trending films and series, and TMDB's most popular
// films and series of each of 15 languages (Hindi, Malayalam, Tamil, Telugu, Kannada, Korean, Japanese, Spanish, French, Turkish, Arabic, Thai, Chinese, German, Portuguese).
async function globalTrending(): Promise<Cand[]> {
  return await pcached("glob3", 3 * 3600_000, async () => {
    const buckets: Cand[][] = [];
    const jobs: Promise<void>[] = [];
    const bucket = (kind: string, path: string, params: Record<string, string>, n: number) => {
      const i = buckets.push([]) - 1;
      jobs.push(tmdb(path, params).then((d) => { for (const r of (d.results || []).filter((x: any) => kind !== "tv" || tvOk(x)).slice(0, n)) { const c = slim(kind, r); if (c) buckets[i].push(c); } }).catch(() => {}));
    };
    const gi = buckets.push([]) - 1;
    jobs.push(pcached("gemglob2", 6 * 3600_000, async () => resolveTitles(await geminiTrending("", []))).then((l) => { buckets[gi] = l; }).catch(() => {}));
    bucket("movie", "/trending/movie/week", {}, 20);
    bucket("tv", "/trending/tv/week", {}, 20);
    const base = { sort_by: "popularity.desc", "vote_count.gte": "15", include_adult: "false" };
    for (const l of GLOBAL_LANGS) {
      bucket("movie", "/discover/movie", { ...base, with_original_language: l, "primary_release_date.gte": daysAgo(730) }, 15);
      bucket("tv", "/discover/tv", { ...base, ...NO_TV_GENRES, with_original_language: l, "air_date.gte": daysAgo(120) }, 15);
    }
    await Promise.all(jobs);
    const seen = new Set<string>(), res: Cand[] = [];
    for (let i = 0; res.length < 48; i++) {
      let any = false;
      for (const b of buckets) {
        if (i >= b.length) continue;
        any = true;
        if (!seen.has(b[i].key)) { seen.add(b[i].key); res.push(b[i]); }
      }
      if (!any) break;
    }
    return res.slice(0, 48);
  });
}

type RegCand = Cand & { pop: number; src: string; g: number };
// where a title can be watched, as a list of country codes (saved 24 h): a cinema, digital, disc or TV release that has happened, or any streaming/rent/buy provider
async function availableIn(c: RegCand, country: string): Promise<boolean> {
  try {
    const list = await cached<string[]>("avail2:" + c.key, 24 * 3600_000, async () => {
      const d: any = await tmdb(`/${c.kind}/${c.id}`, { append_to_response: c.kind === "movie" ? "release_dates,watch/providers" : "watch/providers" });
      const set = new Set<string>();
      const now = Date.now();
      for (const r of d?.release_dates?.results || []) {
        if ((r.release_dates || []).some((x: any) => [3, 4, 5, 6].includes(x.type) && new Date(x.release_date).getTime() <= now)) set.add(r.iso_3166_1);
      }
      const wp = d?.["watch/providers"]?.results || {};
      for (const cc of Object.keys(wp)) if (wp[cc]?.flatrate?.length || wp[cc]?.free?.length || wp[cc]?.ads?.length || wp[cc]?.rent?.length || wp[cc]?.buy?.length) set.add(cc);
      for (const cc of d?.origin_country || []) set.add(cc); // a series made in that country
      for (const pc of d?.production_countries || []) set.add(pc.iso_3166_1); // a film made in that country
      return [...set];
    });
    return list.includes(country);
  } catch { return false; }
}

async function regional(country: string) {
  const prim = REGION_LANGS[country] || [], expat = REGION_EXPAT[country] || [];
  const langs = [...prim, ...expat];
  const pool = new Map<string, RegCand>();
  const add = (kind: string, r: any, src: string) => {
    if (kind === "tv" && !tvOk(r)) return;
    const c = slim(kind, r) as RegCand | null; if (!c) return;
    const had = pool.get(c.key);
    if (had) { if (!had.src.includes(src)) had.src += "," + src; return; }
    c.pop = r.popularity || 0; c.src = src; c.g = 0; pool.set(c.key, c);
  };
  const jobs: Promise<void>[] = [];
  const run = (kind: string, path: string, params: Record<string, string>, src: string) =>
    jobs.push(tmdb(path, params).then((d) => { for (const r of (d.results || []).slice(0, 20)) add(kind, r, src); }).catch(() => {}));
  const base = { sort_by: "popularity.desc", "vote_count.gte": "5", include_adult: "false" };
  const stream = { ...base, watch_region: country, with_watch_monetization_types: "flatrate|free|ads" };
  run("movie", "/movie/now_playing", { region: country }, "cinema");
  run("movie", "/discover/movie", { ...base, region: country, "primary_release_date.gte": daysAgo(400), "primary_release_date.lte": daysAgo(0) }, "new");
  run("movie", "/discover/movie", { ...stream, "primary_release_date.gte": daysAgo(730) }, "stream");
  run("tv", "/discover/tv", { ...stream, ...NO_TV_GENRES, "air_date.gte": daysAgo(120) }, "stream");
  // home-made titles work for every country, even one with no language listed
  run("movie", "/discover/movie", { ...base, with_origin_country: country, "primary_release_date.gte": daysAgo(730), "primary_release_date.lte": daysAgo(0) }, "new");
  run("tv", "/discover/tv", { ...base, ...NO_TV_GENRES, with_origin_country: country, "air_date.gte": daysAgo(120) }, "new");
  for (const l of langs) {
    run("movie", "/discover/movie", { ...base, with_original_language: l, "primary_release_date.gte": daysAgo(730) }, "new");
    run("tv", "/discover/tv", { ...base, ...NO_TV_GENRES, with_original_language: l, "air_date.gte": daysAgo(120) }, "new");
  }
  const gemJob = pcached("gemreg3:" + country, 6 * 3600_000, async () => resolveTitles(await geminiTrending(country, langs))).catch(() => [] as Cand[]);
  await Promise.all(jobs);
  const gem = await gemJob;
  gem.forEach((c, i) => {
    const g = 1 - i / Math.max(gem.length, 1);
    const had = pool.get(c.key);
    if (had) { had.g = g; if (!had.src.includes("google")) had.src += ",google"; }
    else pool.set(c.key, { ...c, pop: 0, src: "google", g });
  });

  // what people in this country added to a list in the last 7 days
  const adds = new Map<string, number>();
  try {
    const { data } = await db.from("discover_region_adds").select("cand_key,added").eq("country", country).gte("day", daysAgo(7)).limit(1000);
    for (const r of data || []) if (keyOk(r.cand_key)) adds.set(r.cand_key, (adds.get(r.cand_key) || 0) + r.added);
  } catch { /* table missing: supabase/discover_region.sql not run */ }
  const top = [...adds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  await Promise.all(top.filter(([k]) => !pool.has(k)).map(async ([k]) => {
    const [kind, id] = k.split(":");
    try { add(kind, await cached("det:" + k, 24 * 3600_000, () => tmdb(`/${kind}/${id}`)), "added"); } catch { /* skip */ }
  }));
  for (const [k] of top) { const c = pool.get(k); if (c && !c.src.includes("added")) c.src += ",added"; }

  const maxPop = Math.max(1, ...[...pool.values()].map((c) => Math.log1p(c.pop)));
  const scored = [...pool.values()].map((c) => {
    const a = clamp((adds.get(c.key) || 0) / 5);                 // 5 adds in a week in this country = full marks
    const pop = Math.log1p(c.pop) / maxPop;                      // TMDB popularity (views, searches, list adds, votes)
    const local = prim.includes(c.lang) ? 1 : expat.includes(c.lang) ? 0.4 : 0; // the country's own languages count most
    const cin = c.src.includes("cinema") ? 1 : 0;
    return { c, s: 0.35 * c.g + 0.2 * a + 0.2 * pop + 0.2 * local + 0.05 * cin };
  }).sort((x, y) => y.s - x.s);

  // only titles that can really be watched in this country. Cinema and streaming lists are already for this country; every other title is checked on TMDB
  // (a cinema, digital, disc or TV release here, or a streaming/rent/buy provider here). A title with neither is left out.
  const verified = (c: RegCand) => c.src.includes("cinema") || c.src.includes("stream");
  const checked = new Map<string, boolean>();
  const toCheck = scored.filter(({ c }) => !verified(c)).slice(0, 72);
  for (let i = 0; i < toCheck.length; i += 8) {
    await Promise.all(toCheck.slice(i, i + 8).map(async ({ c }) => { checked.set(c.key, await availableIn(c, country)); }));
  }
  // Japan: anime has its own "Popular anime" row, so the Japan row leaves it out
  const isAnimeTitle = (c: RegCand) => c.lang === "ja" && c.genres.includes(16);
  const ok = scored.filter(({ c }) => (verified(c) || checked.get(c.key) === true) && !(country === "JP" && isAnimeTitle(c)));

  // the country's own languages lead; the languages of people living there as guests (Hindi, Malayalam in the Gulf) get at most a small share
  const isGuest = (c: RegCand) => !prim.includes(c.lang) && expat.includes(c.lang);
  const maxGuest = prim.length ? 8 : 14;
  const out: typeof ok = [], rest: typeof ok = [];
  let guests = 0;
  for (const r of ok) {
    if (out.length >= 36) break;
    if (isGuest(r.c)) { if (guests >= maxGuest) { rest.push(r); continue; } guests++; }
    out.push(r);
  }
  for (const r of rest) { if (out.length >= 12) break; out.push(r); } // only if the country has almost nothing of its own
  const ranked = out;
  const tag = (c: RegCand) => (c.src.includes("added") ? "Added this week" : c.src.includes("google") ? "Searched this week" : c.src.includes("cinema") ? "In cinemas" : c.src.includes("stream") ? "Popular on streaming" : "New and popular");
  return ranked.map(({ c }) => ({
    id: c.id, media_type: c.kind, title: c.title, poster_path: c.poster_path, release_date: c.release_date, first_air_date: c.first_air_date,
    vote_average: c.vote_average, lang: c.lang, pct: 0, why: [tag(c)],
  }));
}

// ---------- popular anime ----------
// Anime = animation (TMDB genre 16) made in Japanese. Series airing now and films from the last year, most popular first; this week's TMDB trending anime go to the front.
async function animeTrending() {
  const out: any[] = [], seen = new Set<string>();
  const push = (kind: string, r: any, why: string) => {
    const c = slim(kind, r); if (!c || seen.has(c.key)) return;
    seen.add(c.key);
    out.push({ id: c.id, media_type: kind, title: c.title, poster_path: c.poster_path, release_date: c.release_date, first_air_date: c.first_air_date, vote_average: c.vote_average, lang: c.lang, pct: 0, why: [why] });
  };
  const isAnime = (r: any) => r?.original_language === "ja" && (r?.genre_ids || []).includes(16);
  // what people are searching for right now (Gemini with live Google Search); every title is checked on TMDB and must be Japanese animation
  const gemJob = pcached("gemanime1", 6 * 3600_000, async () => resolveTitles(await geminiTrending("", [], "anime"))).catch(() => [] as Cand[]);
  const base = { sort_by: "popularity.desc", with_genres: "16", with_original_language: "ja", include_adult: "false" };
  const [trend, tv1, tv2, mov, tvAll] = await Promise.all([
    tmdb("/trending/tv/week").catch(() => ({ results: [] })),
    tmdb("/discover/tv", { ...base, "air_date.gte": daysAgo(120), "vote_count.gte": "10", page: "1" }).catch(() => ({ results: [] })),
    tmdb("/discover/tv", { ...base, "air_date.gte": daysAgo(120), "vote_count.gte": "10", page: "2" }).catch(() => ({ results: [] })),
    tmdb("/discover/movie", { ...base, "primary_release_date.gte": daysAgo(365), "primary_release_date.lte": daysAgo(0), "vote_count.gte": "20" }).catch(() => ({ results: [] })),
    tmdb("/discover/tv", { ...base, "vote_count.gte": "300", page: "1" }).catch(() => ({ results: [] })),
  ]);
  const gem = (await gemJob).filter((c) => c.lang === "ja" && c.genres.includes(16));
  for (const c of gem) { // slim() of a Cand is the same shape, so it goes through push as is
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.push({ id: c.id, media_type: c.kind, title: c.title, poster_path: c.poster_path, release_date: c.release_date, first_air_date: c.first_air_date, vote_average: c.vote_average, lang: c.lang, pct: 0, why: ["Searched this week"] });
  }
  for (const r of (trend.results || []).filter(isAnime)) push("tv", r, "Trending this week");
  const tv = [...(tv1.results || []), ...(tv2.results || [])], mv = mov.results || [];
  for (let i = 0; i < Math.max(tv.length, mv.length); i++) { // two series for every film
    if (tv[i * 2]) push("tv", tv[i * 2], "Popular anime");
    if (tv[i * 2 + 1]) push("tv", tv[i * 2 + 1], "Popular anime");
    if (mv[i]) push("movie", mv[i], "Anime film");
  }
  for (const r of (tvAll.results || []).slice(0, 8)) push("tv", r, "Fan favourite");
  return out.slice(0, 30);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const xff = (req.headers.get("x-forwarded-for") || "").split(",").map((x) => x.trim()).filter(Boolean);
  const ip = req.headers.get("cf-connecting-ip") || xff[xff.length - 1] || "unknown";

  if (req.method === "POST") {
    if (postLimited(ip)) return json({ error: "Too many requests" }, 429);
    try {
      const b = await req.json();
      const shown = (Array.isArray(b?.shown) ? b.shown : []).filter(keyOk).slice(0, 30) as string[];
      const added = (Array.isArray(b?.added) ? b.added : []).filter(keyOk).slice(0, 20) as string[];
      const radd = (Array.isArray(b?.radd) ? b.radd : []).filter(keyOk).slice(0, 10) as string[]; // titles added to a list, counted per country
      if (!shown.length && !added.length && !radd.length) return json({ error: "Bad request" }, 400);
      if (shown.length || added.length) await db.rpc("discover_vote", { p_shown: [...new Set(shown)], p_added: [...new Set(added)] });
      if (radd.length) {
        const c = ccOf(req.headers.get("cf-ipcountry")) || ccOf(b?.hl);
        if (c) await db.rpc("discover_region_add", { p_country: c, p_keys: [...new Set(radd)] });
      }
      return json({ ok: true });
    } catch { return json({ error: "Could not save" }, 500); }
  }
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (getLimited(ip)) return json({ error: "Too many requests" }, 429);

  const u = new URL(req.url).searchParams;
  if (u.get("mode") === "anime") { // ?mode=anime  ->  { items }
    try { return json({ items: await cached("anime2", 3 * 3600_000, animeTrending) }); } catch (e) { return json({ error: String(e) }, 502); }
  }
  if (u.get("mode") === "region") { // ?mode=region[&country=IN][&hl=IN]  ->  { country, by, items }
    const pick = ccOf(u.get("country")), hdr = ccOf(req.headers.get("cf-ipcountry")), hl = ccOf(u.get("hl"));
    const country = pick || hdr || hl;
    if (!country) return json({ country: "", by: "", items: [] });
    try { return json({ country, by: pick ? "choice" : hdr ? "network" : "language", items: await cached("reg5:" + country, 3 * 3600_000, () => regional(country)) }); }
    catch (e) { return json({ error: String((e as Error)?.message || e) }, 502); }
  }
  const seeds = parseKeys(u.get("seeds"), 12), liked = parseKeys(u.get("liked"), 8);
  try {
    // the same taste gives the same answer for 3 hours, so opening the tab twice costs nothing
    const ck = "disc5:" + seeds.join(",") + "|" + liked.join(",");
    return json(await cached(ck, 3 * 3600_000, () => build(seeds, liked)));
  } catch (e) { return json({ error: String((e as Error)?.message || e) }, 502); }
});
