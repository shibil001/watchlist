// Supabase Edge Function: the shared "related films & series" list, now self-filling.
//
// Known title  -> the saved list for its franchise comes back at once (same list for every title in it).
// Unknown title -> learned once: Wikidata says which franchise it belongs to, the members are looked up on TMDB with
//                 the server key and saved as an "auto" franchise, and every member is recorded in `title_franchise`.
// Nothing found -> remembered in `title_nofranchise` for 30 days, so Wikidata is not asked again.
// Auto lists are re-learned and rebuilt weekly. Hand-written lists (source = 'manual') are never overwritten, and an auto
// list you edit in the Table Editor becomes a hand-written one (database trigger in related-auto.sql).
//
// Calls (GET):  ?name=<collection name>&ids=1,2,3     a movie collection (ids = its movies' TMDB ids)
//               ?type=movie|tv&id=123                 one title
//               add &warm=1                           learn/build in the background and answer at once (used when a title is added)
// Call  (POST): {franchise, type, id, note}           "Report missing titles"
//
// Deploy:  supabase functions deploy related --no-verify-jwt
// Needs:   TMDB_API_KEY secret, and supabase/related.sql + supabase/related-auto.sql run once.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const MANUAL_REFRESH_DAYS = 3;   // hand-written lists: rebuilt this often (new release dates)
const AUTO_REFRESH_DAYS = 7;     // auto lists: re-learned and rebuilt weekly
const NOFRANCHISE_DAYS = 30;     // "no franchise" is remembered this long
const LOCK_MS = 3 * 60_000;      // one build at a time per franchise
const REPORT_THRESHOLD = Number(Deno.env.get("REPORT_THRESHOLD")) || 50; // reports (from different people) before a missing title is added to an auto list
const MAX_TITLES = 80;           // an auto franchise holds at most this many titles

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const later = (p: Promise<unknown>) => {
  const q = p.catch(() => {});
  // @ts-ignore EdgeRuntime exists on Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(q);
};

// ---------- light per-IP limits ----------
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; t: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.t > windowMs) { hits.set(ip, { n: 1, t: now }); if (hits.size > 5000) hits.clear(); return false; }
    return ++h.n > max;
  };
}
const limited = limiter(30, 60_000);          // any request
const learnLimited = limiter(10, 10 * 60_000); // asking Wikidata (new titles only)
const reportLimited = limiter(5, 60_000);

// ---------- names ----------
const norm = (t: string) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const NUM: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
const tokens = (t: string) => new Set(norm(t).replace(/^marvel s /, "").split(" ").map((w) => NUM[w] || w).filter(Boolean));
const EXTRA = /\b(premiere|trailer|featurette|behind the scenes|making of|recap|special look|tv spot|interview)\b/i;
function score(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  let both = 0;
  x.forEach((w) => { if (y.has(w)) both++; });
  return both / (x.size + y.size - both || 1);
}
const collBase = (n: string) => norm(String(n || "").replace(/\s*(film\s+)?collection$/i, ""));

// ---------- TMDB ----------
async function tmdb(path: string, params: Record<string, string>) {
  const u = new URL("https://api.themoviedb.org/3" + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("api_key", Deno.env.get("TMDB_API_KEY") || "");
  for (let tries = 0; tries < 3; tries++) {
    const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 2000)); continue; }
    if (!r.ok) throw new Error("TMDB " + r.status);
    return await r.json();
  }
  throw new Error("TMDB busy");
}

// ---------- franchises ----------
// item = [type, title, year] or [type, title, year, tmdbId]  (t = series, m = movie). Auto lists carry the id.
type Item = [string, string, number] | [string, string, number, number];
type Franchise = { id: string; match: string[]; items: Item[]; source: string; learned_at?: string | null; name?: string | null };
const COLS = "id,match,items,source,learned_at,name";
const COLS_BASE = "id,match,items,source,learned_at"; // works even if related-series.sql (the name column) has not been run yet
// run a franchises query with the name column, and without it if that column does not exist yet
async function withName(q: (cols: string) => any): Promise<any> {
  const r = await q(COLS);
  return r.error ? await q(COLS_BASE) : r;
}

// hand-written franchises, matched by collection name (cached in memory for a few minutes)
let fr: { at: number; list: Franchise[] } | null = null;
async function manualFranchises(): Promise<Franchise[]> {
  if (fr && Date.now() - fr.at < 5 * 60_000) return fr.list;
  const { data, error } = await withName((c) => db.from("franchises").select(c).eq("source", "manual"));
  if (error) throw error;
  fr = { at: Date.now(), list: ((data || []) as Franchise[]).filter((f) => f.match && f.match.length) };
  return fr.list;
}
async function franchiseById(id: string): Promise<Franchise | null> {
  const { data } = await withName((c) => db.from("franchises").select(c).eq("id", id).maybeSingle());
  return (data as Franchise) || null;
}
const hashOf = (items: unknown) => {
  const s = JSON.stringify(items);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
};


async function details(kind: string, id: number) {
  const r = await tmdb("/" + kind + "/" + id, {});
  return {
    id: r.id, media_type: kind, title: r.title || r.name, poster_path: r.poster_path || null,
    release_date: r.release_date || null, first_air_date: r.first_air_date || null, vote_average: r.vote_average || 0,
    runtime: r.runtime || 0, docu: (r.genres || []).some((g: any) => g.id === 99),
    genres: (r.genres || []).map((g: any) => ({ id: g.id })),
  };
}
// shorts, documentaries, "making of" extras and titles with no release date are not wanted in an auto list
const AFTER = [10764, 10767, 10763, 10766]; // TMDB genres: Reality, Talk, News, Soap
const isAfter = (r: any) => (r.genres || []).some((g: any) => AFTER.includes(g.id));
const junk = (r: any) => !(r.release_date || r.first_air_date) || (r.media_type === "movie" && r.runtime && r.runtime < 40) || r.docu || isAfter(r) || EXTRA.test(r.title || "");

const junkBase = (r: any) => !(r.release_date || r.first_air_date) || (r.media_type === "movie" && r.runtime && r.runtime < 40) || r.docu || EXTRA.test(r.title || "");

async function resolve(it: Item) {
  const [type, title, year] = it;
  const tv = type === "t";
  const wantId = (it as any)[3] as number | undefined;
  if (wantId) return await details(tv ? "tv" : "movie", wantId); // auto lists store the TMDB id: no guessing by name
  const q = title.replace(/\*/g, "");
  const yr = (r: any) => Number(String(r.first_air_date || r.release_date || "").slice(0, 4)) || 0;
  const pick = (results: any[]) => results
    .filter((r) => Math.abs(yr(r) - year) <= 1)
    .filter((r) => !EXTRA.test(r.title || r.name) || EXTRA.test(title))
    .map((r) => ({ r, sc: score(title, r.title || r.name) - (yr(r) === year ? 0 : 0.15) }))
    .filter((x) => x.sc >= 0.6)
    .sort((a, b) => b.sc - a.sc)[0]?.r;
  const d = await tmdb(tv ? "/search/tv" : "/search/movie", tv
    ? { query: q, first_air_date_year: String(year), include_adult: "false" }
    : { query: q, year: String(year), include_adult: "false" });
  let hit = pick(d.results || []);
  if (!hit) { // the year filter can be too strict: search again without it
    const d2 = await tmdb(tv ? "/search/tv" : "/search/movie", { query: q, include_adult: "false" });
    hit = pick(d2.results || []);
  }
  if (!hit) return null;
  return {
    id: hit.id, media_type: tv ? "tv" : "movie", title: hit.title || hit.name, poster_path: hit.poster_path || null,
    release_date: hit.release_date || null, first_air_date: hit.first_air_date || null, vote_average: hit.vote_average || 0,
  };
}

// remember which franchise each listed title belongs to (never moves a title that already has one)
async function mapTitles(franchiseId: string, titles: { type: string; id: number }[]) {
  const seen = new Set<string>();
  const rows = titles.filter((t) => t.id && (t.type === "movie" || t.type === "tv") && !seen.has(t.type + t.id) && seen.add(t.type + t.id))
    .map((t) => ({ tmdb_type: t.type, tmdb_id: t.id, franchise_id: franchiseId }));
  for (let i = 0; i < rows.length; i += 200) {
    await db.from("title_franchise").upsert(rows.slice(i, i + 200), { onConflict: "tmdb_type,tmdb_id", ignoreDuplicates: true });
  }
}

async function build(f: Franchise, hash: string, keepOld: boolean) {
  try {
    const auto = f.source === "auto";
    const out: any[] = [];
    let failed = 0;
    const failedItems: Item[] = [];
    for (let i = 0; i < f.items.length; i += 12) {
      const batch = await Promise.all(f.items.slice(i, i + 12).map((it) => resolve(it).catch(() => { failed++; failedItems.push(it); return null; })));
      out.push(...batch.filter(Boolean));
    }
    if (failedItems.length) { // retry the ones that errored (TMDB rate limit or a hiccup), one by one, before saving
      await new Promise((ok) => setTimeout(ok, 1500));
      for (const it of failedItems) { try { const r = await resolve(it); if (r) { out.push(r); failed--; } } catch { /* still failing */ } }
    }
    const seen = new Set<string>();
    let list = out.filter((r) => { const k = r.media_type + ":" + r.id; if (seen.has(k)) return false; seen.add(k); return true; });
    if (auto) { // after-shows go, unless the franchise itself is mostly talk/reality
      const afters = list.filter(isAfter).length;
      list = afters * 2 >= list.length ? list.filter((r) => !junkBase(r)) : list.filter((r) => !junk(r));
    }
    list = list.map(({ runtime: _r, docu: _d, ...rest }) => rest);
    // a bad run (TMDB down) must not wipe a good saved list
    if (keepOld && failed > f.items.length / 3) throw new Error("too many lookups failed");
    await db.from("related_cache").upsert({ franchise_id: f.id, list, built_at: new Date().toISOString(), building_at: null, items_hash: hash });
    await mapTitles(f.id, list.map((r: any) => ({ type: r.media_type, id: r.id })));
    return list;
  } catch (e) {
    await db.from("related_cache").update({ building_at: null }).eq("franchise_id", f.id);
    throw e;
  }
}

// ---------- learning: Wikidata + AniList (anime), every title checked against TMDB ----------
// Three sources are asked and their answers are merged, because none of them is complete alone:
//   Wikidata  films and series of any kind: franchise, "follows / followed by", spin-offs (found by the exact Wikidata id TMDB gives)
//   Wikipedia the "related shows / preceded by / followed by" fields of the article's infobox, two steps out (The Vampire Diaries -> The Originals -> Legacies)
//   AniList   anime only: prequel, sequel, side story, spin-off and alternative versions, each one matched back to TMDB
type Seed = { type: "movie" | "tv"; id: number; qid?: string };
type Member = { type?: "movie" | "tv"; id?: number; name?: string };
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function pool<T, R>(list: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
    while (next < list.length) { const i = next++; out[i] = await fn(list[i]).catch(() => null as unknown as R); }
  }));
  return out;
}

// what TMDB knows about one title: its name, year, Wikidata id, and whether it is anime
type Info = { title: string; original: string; year: number; qid: string; anime: boolean };
async function info(kind: "movie" | "tv", id: number): Promise<Info> {
  const r = await tmdb("/" + kind + "/" + id, { append_to_response: "external_ids" });
  return {
    title: String(r.title || r.name || ""), original: String(r.original_title || r.original_name || ""),
    year: Number(String(r.release_date || r.first_air_date || "").slice(0, 4)) || 0,
    qid: String(r.external_ids?.wikidata_id || ""),
    anime: (r.genres || []).some((g: any) => g.id === 16) && r.original_language === "ja",
  };
}

// ----- Wikidata -----
type WdRow = { fr: string; m: Member; frName?: string };
async function wikidata(seeds: Seed[]): Promise<WdRow[]> {
  const list = (t: string) => seeds.filter((s) => s.type === t).slice(0, 20).map((s) => '"' + s.id + '"').join(" ");
  const mv = list("movie"), tv = list("tv");
  const qids = seeds.map((s) => s.qid || "").filter((q) => /^Q\d+$/.test(q)).slice(0, 20).map((q) => "wd:" + q).join(" ");
  const src = [qids && `{ VALUES ?src { ${qids} } }`, mv && `{ VALUES ?mine { ${mv} } ?src wdt:P4947 ?mine }`, tv && `{ VALUES ?mine { ${tv} } ?src wdt:P4983 ?mine }`].filter(Boolean).join(" UNION ");
  if (!src) return [];
  // P8345 franchise, P179 series, P361 part of, P527 has part, P155/P156 follows/followed by, P2512 series spin-off
  const q = `SELECT DISTINCT ?fr ?frName ?m ?t ?label WHERE {
    ${src}
    { ?src (wdt:P8345|wdt:P179|wdt:P361) ?fr .
      { ?x (wdt:P8345|wdt:P179) ?fr } UNION { ?fr wdt:P527 ?x } UNION { ?x wdt:P361 ?fr } }
    UNION
    { ?src (wdt:P155|wdt:P156|wdt:P2512|^wdt:P2512)+ ?x . BIND(?src AS ?fr) }
    OPTIONAL { ?x wdt:P4947 ?m }
    OPTIONAL { ?x wdt:P4983 ?t }
    OPTIONAL { ?x wdt:P31/wdt:P279* ?cls . VALUES ?cls { wd:Q11424 wd:Q5398426 wd:Q1259759 wd:Q63952888 } }
    OPTIONAL { ?x rdfs:label ?label . FILTER(LANG(?label) = "en") }
    OPTIONAL { ?fr rdfs:label ?frName . FILTER(LANG(?frName) = "en") }
    FILTER(BOUND(?m) || BOUND(?t) || BOUND(?cls))
  } LIMIT 500`;
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), {
    headers: { Accept: "application/sparql-results+json", "User-Agent": "movie-watchlist-app/1.0 (shared related lists)" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error("Wikidata " + r.status);
  const rows = (await r.json()).results.bindings;
  const out: WdRow[] = [];
  for (const b of rows) {
    const frId = String(b.fr?.value || "").split("/").pop() || "";
    if (!/^Q\d+$/.test(frId)) continue;
    const frName = b.frName?.value ? String(b.frName.value).slice(0, 120) : undefined;
    if (b.m) out.push({ fr: frId, frName, m: { type: "movie", id: +b.m.value } });
    if (b.t) out.push({ fr: frId, frName, m: { type: "tv", id: +b.t.value } });
    if (!b.m && !b.t && b.label) out.push({ fr: frId, frName, m: { name: b.label.value } });
  }
  return out;
}

// titles Wikidata knows only by name: an exact name match on TMDB, or skipped
async function byName(name: string): Promise<Seed | null> {
  const d = await tmdb("/search/multi", { query: name, include_adult: "false" });
  const want = norm(name);
  const hit = (d.results || []).find((r: any) => (r.media_type === "movie" || r.media_type === "tv") && norm(r.title || r.name) === want);
  return hit ? { type: hit.media_type, id: hit.id } : null;
}

// Turns Wikidata rows into a clean member list: the title ids, plus up to 20 name-only titles looked up on TMDB.
async function members(rows: WdRow[], seeds: Seed[]): Promise<{ qid: string; name: string; list: Seed[] }> {
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.fr, (count.get(r.fr) || 0) + 1);
  const qid = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const name = rows.find((r) => r.fr === qid && r.frName)?.frName || "";
  const seen = new Set<string>();
  const list: Seed[] = [];
  const add = (s: Seed) => { const k = s.type + s.id; if (!seen.has(k)) { seen.add(k); list.push(s); } };
  seeds.forEach(add); // the titles that were asked about always belong to it
  for (const r of rows) if (r.m.id && r.m.type) add({ type: r.m.type, id: r.m.id });
  let names = 0;
  for (const r of rows) {
    if (!r.m.name || names >= 20 || list.length >= MAX_TITLES) continue;
    names++;
    try { const s = await byName(r.m.name); if (s) add(s); } catch { break; }
  }
  return { qid, name, list: list.slice(0, MAX_TITLES) };
}

// ----- AniList (anime) -----
const AL_URL = "https://graphql.anilist.co";
const AL_FIELDS = "id type format title { romaji english } synonyms startDate { year } relations { edges { relationType node { id type } } }";
const AL_REL = new Set(["PREQUEL", "SEQUEL", "PARENT", "SIDE_STORY", "SPIN_OFF", "ALTERNATIVE"]); // how AniList says "same franchise"
const AL_MAX = 40; // at most this many AniList entries per franchise (some anime have hundreds of related entries)
async function alQuery(query: string, variables: Record<string, unknown>): Promise<any> {
  for (let tries = 0; tries < 3; tries++) {
    const r = await fetch(AL_URL, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 429) { await sleep(Math.min(10, Number(r.headers.get("retry-after")) || 3) * 1000); continue; }
    if (!r.ok) throw new Error("AniList " + r.status);
    const j = await r.json();
    if (j.errors) throw new Error("AniList error");
    return j.data;
  }
  throw new Error("AniList busy");
}
// "Attack on Titan Season 2" and "Attack on Titan: The Final Season" are the same TMDB series as "Attack on Titan"
const cleanTitle = (t: string) => norm(t)
  .replace(/\b(season|part|cour)\s*\d+\b/g, " ").replace(/\b\d+(st|nd|rd|th)\s+season\b/g, " ")
  .replace(/\b(the\s+)?final\s+season\b/g, " ").replace(/\s+/g, " ").trim();
const alNames = (n: any): string[] => [n.title?.english, n.title?.romaji, ...(n.synonyms || [])].filter(Boolean).map(cleanTitle).filter(Boolean);
const bestScore = (a: string[], b: string[]) => Math.max(0, ...a.flatMap((x) => b.map((y) => score(x, y))));

// the AniList entry for one TMDB title (by name, and the year within one)
async function alFind(inf: Info): Promise<any | null> {
  const want = [inf.title, inf.original].filter(Boolean).map(cleanTitle);
  if (!want.length) return null;
  const d = await alQuery(`query($s:String){Page(perPage:8){media(search:$s,type:ANIME){${AL_FIELDS}}}}`, { s: inf.title || inf.original });
  const hits = (d.Page.media as any[])
    .filter((n) => !inf.year || !n.startDate?.year || Math.abs(n.startDate.year - inf.year) <= 1)
    .map((n) => ({ n, sc: bestScore(want, alNames(n)) }))
    .filter((x) => x.sc >= 0.6).sort((a, b) => b.sc - a.sc);
  return hits.length ? hits[0].n : null;
}
// walk the relations outwards: prequel of a prequel, sequel of a sequel ... (one request per step)
async function alCrawl(root: any): Promise<any[]> {
  const seen = new Map<number, any>([[root.id, root]]);
  let level: number[] = [];
  const queue = (n: any) => { for (const e of n.relations?.edges || []) if (AL_REL.has(e.relationType) && e.node?.type === "ANIME" && !seen.has(e.node.id)) level.push(e.node.id); };
  queue(root);
  for (let depth = 0; depth < 6 && level.length && seen.size < AL_MAX; depth++) {
    const need = [...new Set(level)].filter((i) => !seen.has(i)).slice(0, AL_MAX - seen.size);
    level = [];
    if (!need.length) break;
    const d = await alQuery(`query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){${AL_FIELDS}}}}`, { ids: need });
    for (const m of d.Page.media as any[]) { seen.set(m.id, m); queue(m); }
  }
  return [...seen.values()];
}
// one AniList entry -> its TMDB title (or null). TV and ONA become series, MOVIE a film; OVAs and specials are skipped.
async function alToTmdb(n: any): Promise<Seed | null> {
  const movie = n.format === "MOVIE";
  if (!movie && n.format !== "TV" && n.format !== "ONA") return null;
  const names = alNames(n);
  const year = n.startDate?.year || 0;
  const yr = (r: any) => Number(String(r.first_air_date || r.release_date || "").slice(0, 4)) || 0;
  for (const q of [...new Set([n.title?.english, n.title?.romaji].filter(Boolean).map(cleanTitle).filter(Boolean))]) {
    const d = await tmdb(movie ? "/search/movie" : "/search/tv", { query: q, include_adult: "false" });
    const hit = ((d.results || []) as any[])
      .filter((r) => r.original_language === "ja")
      .filter((r) => !year || (movie ? Math.abs(yr(r) - year) <= 1 : !yr(r) || yr(r) <= year + 1)) // a later season may belong to an older series
      .map((r) => ({ r, sc: bestScore(names, [cleanTitle(r.title || r.name || ""), cleanTitle(r.original_title || r.original_name || "")]) }))
      .filter((x) => x.sc >= 0.6).sort((a, b) => b.sc - a.sc)[0]?.r;
    if (hit) return { type: movie ? "movie" : "tv", id: hit.id };
  }
  return null;
}
async function anilistMembers(inf: Info): Promise<{ name: string; root: number; list: Seed[] } | null> {
  const root = await alFind(inf);
  if (!root) return null;
  const nodes = await alCrawl(root);
  if (nodes.length < 2) return null;
  const seen = new Set<string>();
  const list = (await pool(nodes, 6, alToTmdb)).filter((s): s is Seed => !!s && !seen.has(s.type + s.id) && !!seen.add(s.type + s.id));
  return { name: inf.title, root: Math.min(...nodes.map((n) => n.id)), list };
}

// ----- Wikipedia (infobox links) -----
const WD_API = "https://www.wikidata.org/w/api.php";
const WP_API = "https://en.wikipedia.org/w/api.php";
const WEB_HEADERS = { "User-Agent": "movie-watchlist-app/1.0 (shared related lists)", Accept: "application/json" };
async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: WEB_HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}
// the links inside the infobox fields that name related, preceding and following titles
const IB_FIELDS = /^(related|preceded[_ ]by|followed[_ ]by|spin[_ ]?off|prequel|sequel)$/i;
function infoboxLinks(text: string): string[] {
  const start = text.search(/\{\{\s*infobox/i);
  if (start < 0) return [];
  let depth = 0, end = text.length; // the infobox ends where its braces close: the article text after it must not be read
  for (let i = start; i < text.length - 1; i++) {
    const two = text.slice(i, i + 2);
    if (two === "{{") { depth++; i++; } else if (two === "}}") { depth--; i++; if (depth === 0) { end = i + 1; break; } }
  }
  const out: string[] = [];
  for (const part of text.slice(start, end).split(/\n\s*\|/).slice(1)) {
    const eq = part.indexOf("=");
    if (eq < 0 || !IB_FIELDS.test(part.slice(0, eq).trim())) continue;
    for (const m of part.slice(eq + 1).matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      const t = m[1].trim();
      if (t && !/^(file|image|category|wikipedia|template|help|portal):/i.test(t)) out.push(t);
    }
  }
  return out;
}
async function leadWikitext(title: string): Promise<string> {
  const j = await getJson(`${WP_API}?action=query&format=json&formatversion=2&redirects=1&prop=revisions&rvprop=content&rvslots=main&rvsection=0&titles=${encodeURIComponent(title)}`);
  return String(j.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content || "");
}
// Wikipedia article titles -> TMDB titles, through the exact Wikidata item (no guessing by name)
async function titlesToSeeds(titles: string[]): Promise<Seed[]> {
  const qids: string[] = [];
  for (let i = 0; i < titles.length; i += 50) {
    const j = await getJson(`${WP_API}?action=query&format=json&formatversion=2&redirects=1&prop=pageprops&ppprop=wikibase_item&titles=${encodeURIComponent(titles.slice(i, i + 50).join("|"))}`);
    for (const p of j.query?.pages || []) if (/^Q\d+$/.test(p.pageprops?.wikibase_item || "")) qids.push(p.pageprops.wikibase_item);
  }
  if (!qids.length) return [];
  const q = `SELECT ?q ?m ?t WHERE { VALUES ?q { ${[...new Set(qids)].map((x) => "wd:" + x).join(" ")} } OPTIONAL { ?q wdt:P4947 ?m } OPTIONAL { ?q wdt:P4983 ?t } }`;
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { headers: { ...WEB_HEADERS, Accept: "application/sparql-results+json" }, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error("Wikidata " + r.status);
  const out: Seed[] = [];
  for (const b of (await r.json()).results.bindings) {
    if (b.m && +b.m.value) out.push({ type: "movie", id: +b.m.value });
    if (b.t && +b.t.value) out.push({ type: "tv", id: +b.t.value });
  }
  return out;
}
async function wikipedia(seeds: Seed[]): Promise<Seed[]> {
  const qids = seeds.map((s) => s.qid || "").filter((q) => /^Q\d+$/.test(q));
  if (!qids.length) return [];
  const j = await getJson(`${WD_API}?action=wbgetentities&format=json&props=sitelinks&sitefilter=enwiki&ids=${qids.join("|")}`);
  let frontier: string[] = qids.map((q) => j.entities?.[q]?.sitelinks?.enwiki?.title).filter(Boolean);
  const visited = new Set(frontier);
  const linked: string[] = [];
  for (let step = 0; step < 2 && frontier.length; step++) { // the title's own infobox, then the infoboxes of what it links to
    const pages = await pool(frontier.slice(0, 6), 3, async (t: string) => infoboxLinks(await leadWikitext(t)));
    const next: string[] = [];
    for (const links of pages) for (const t of links || []) if (!visited.has(t)) { visited.add(t); linked.push(t); next.push(t); }
    frontier = next;
  }
  return linked.length ? await titlesToSeeds(linked.slice(0, 30)) : [];
}

// ----- all sources, merged -----
type Found = { qid: string; name: string; list: Seed[]; alRoot: number; seedQid: string };
async function discover(seeds: Seed[]): Promise<Found> {
  const head = seeds.slice(0, 3);
  const infos = await Promise.all(head.map((s) => info(s.type, s.id).catch(() => null)));
  head.forEach((s, i) => { if (infos[i]?.qid) s.qid = infos[i]!.qid; }); // the exact Wikidata id: no guessing from the TMDB id
  const anime = infos.filter((x): x is Info => !!x && x.anime).slice(0, 2);
  const [wd, wp, al] = await Promise.allSettled([
    wikidata(seeds).then((rows) => members(rows, seeds)),
    wikipedia(head),
    Promise.all(anime.map((x) => anilistMembers(x))),
  ]);
  const out: Seed[] = [];
  const seen = new Set<string>();
  const add = (s: Seed) => { const k = s.type + s.id; if (!seen.has(k)) { seen.add(k); out.push({ type: s.type, id: s.id }); } };
  seeds.forEach(add);
  if (wd.status === "fulfilled") wd.value.list.forEach(add);
  if (wp.status === "fulfilled") wp.value.forEach(add);
  let alRoot = 0, alName = "";
  if (al.status === "fulfilled") for (const r of al.value) if (r) { r.list.forEach(add); alRoot = alRoot || r.root; alName = alName || r.name; }
  if (wd.status === "rejected" && out.length <= seeds.length) throw wd.reason; // Wikidata could not be asked and nothing else found anything: not an answer
  const wdv = wd.status === "fulfilled" ? wd.value : null;
  return { qid: wdv?.qid || "", name: wdv?.name || alName || infos[0]?.title || "", list: out.slice(0, MAX_TITLES), alRoot, seedQid: seeds[0]?.qid || "" };
}

const toItems = (list: Seed[]): Item[] => list.map((s) => [s.type === "tv" ? "t" : "m", "", 0, s.id] as Item);
const itemKey = (it: Item) => (it[0] === "t" ? "tv" : "movie") + (it as any)[3];

// These titles already belong to a learned list (found another way earlier): add what is new to it.
async function extendAuto(id: string, list: Seed[]): Promise<Franchise | null> {
  const f = await franchiseById(id);
  if (!f) return null;
  const have = new Set(f.items.map(itemKey));
  const added = list.filter((s) => !have.has(s.type + s.id));
  if (added.length && f.source === "auto") {
    const items = [...f.items, ...toItems(added)].slice(0, MAX_TITLES);
    await db.from("franchises").update({ items, items_auto_hash: hashOf(items) }).eq("id", id).eq("source", "auto");
  }
  await mapTitles(id, list);
  return await franchiseById(id);
}

// First time we meet these titles: ask the sources, save the franchise and who is in it. Returns null when there is none.
const learning = new Set<string>();
async function learn(seeds: Seed[]): Promise<Franchise | null> {
  const key = seeds.map((s) => s.type + s.id).sort().join(",");
  if (learning.has(key)) throw new Error("busy"); // someone is learning this title right now
  learning.add(key);
  try {
    const found = await discover(seeds);
    const { list } = found;
    const others = list.filter((m) => !seeds.some((s) => s.type === m.type && s.id === m.id));
    if (others.length === 0) { // a franchise of one: remember that for 30 days
      await db.from("title_nofranchise").upsert(seeds.map((s) => ({ tmdb_type: s.type, tmdb_id: s.id, checked_at: new Date().toISOString() })));
      return null;
    }
    // Do any of these titles already belong to a list? A hand-written list wins; then a learned one is extended
    // (so Naruto learned first and Shippuden learned later end up in the same franchise, not two).
    const ors = list.map((m) => `and(tmdb_type.eq.${m.type},tmdb_id.eq.${m.id})`).join(",");
    const { data: known } = await db.from("title_franchise").select("franchise_id").or(ors).limit(500);
    const count = new Map<string, number>();
    for (const k of known || []) count.set(k.franchise_id, (count.get(k.franchise_id) || 0) + 1);
    if (count.size) {
      const { data: man } = await withName((c) => db.from("franchises").select(c).in("id", [...count.keys()]).eq("source", "manual").limit(1));
      if (man && man.length) { await mapTitles(man[0].id, seeds); return man[0] as Franchise; }
      const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const ext = await extendAuto(best, list);
      if (ext) { await mapTitles(best, seeds); return ext; }
    }
    const id = found.qid ? "auto-" + found.qid : found.alRoot ? "auto-al" + found.alRoot : found.seedQid ? "auto-" + found.seedQid : "auto-" + seeds[0].type + seeds[0].id;
    const items = toItems(list);
    const row = { id, match: [], items, source: "auto", items_auto_hash: hashOf(items), learned_at: new Date().toISOString() };
    const ins = await db.from("franchises").upsert({ ...row, name: found.name || null }, { onConflict: "id", ignoreDuplicates: true }); // already known (someone else learned it): keep it
    if (ins.error) await db.from("franchises").upsert(row, { onConflict: "id", ignoreDuplicates: true }); // no name column yet
    await mapTitles(id, list);
    return await franchiseById(id);
  } finally { learning.delete(key); }
}

// Weekly: ask the sources again for an auto list and add new members (old ones stay unless the junk filter drops them).
async function relearn(f: Franchise) {
  const seeds: Seed[] = f.items.slice(0, 15).filter((it) => (it as any)[3]).map((it) => ({ type: it[0] === "t" ? "tv" : "movie", id: (it as any)[3] as number }));
  const { list } = await discover(seeds);
  const have = new Set(f.items.map(itemKey));
  const added = list.filter((s) => !have.has(s.type + s.id));
  const items = [...f.items, ...toItems(added)].slice(0, MAX_TITLES);
  const patch: Record<string, unknown> = { learned_at: new Date().toISOString() };
  if (added.length) { patch.items = items; patch.items_auto_hash = hashOf(items); }
  await db.from("franchises").update(patch).eq("id", f.id).eq("source", "auto"); // if you made it hand-written meanwhile, this does nothing
  await mapTitles(f.id, list);
  return added.length ? { ...f, items } : f;
}


// ---------- reports: people say which title is missing; enough reports add it to an auto list ----------
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
async function report(b: any, ip: string) {
  const type = b.type === "tv" ? "tv" : b.type === "movie" ? "movie" : "";
  const id = Number.isInteger(b.id) && b.id > 0 && b.id < 1e9 ? b.id : 0;
  const fid = String(b.franchise || "").slice(0, 80);
  if (!type || !id || !fid) throw new Error("bad_report");
  if (!(await franchiseById(fid))) throw new Error("unknown_franchise");
  let t: any;
  try { t = await details(type, id); } catch { throw new Error("not_listable"); } // it has to be a real title on TMDB (a made-up id fails here)
  if (junk(t)) throw new Error("not_listable"); // shorts, documentaries, "making of" extras and titles with no release date
  const reporter = await sha(ip + ":" + (Deno.env.get("REPORT_SALT") || "") + ":" + fid); // anonymous: one person counts once per franchise and title
  const { error } = await db.from("franchise_reports").upsert(
    { franchise_id: fid, missing_type: type, missing_id: id, missing_title: String(t.title || "").slice(0, 200), reporter },
    { onConflict: "franchise_id,missing_type,missing_id,reporter", ignoreDuplicates: true });
  if (error) throw new Error("not_saved"); // most likely related-reports.sql has not been run
  const { count } = await db.from("franchise_reports").select("id", { count: "exact", head: true })
    .eq("franchise_id", fid).eq("missing_type", type).eq("missing_id", id);
  if ((count || 0) >= REPORT_THRESHOLD) await addMissing(fid, type, t);
}
// Auto lists only: a hand-written list is never changed by reports (you see them in missing_title_votes instead).
async function addMissing(fid: string, type: string, t: any) {
  const f = await franchiseById(fid);
  if (!f || f.source !== "auto") return;
  if (f.items.some((it) => (it as any)[3] === t.id && (it[0] === "t") === (type === "tv"))) return;
  if (f.items.length >= MAX_TITLES) return;
  const year = Number(String(t.release_date || t.first_air_date || "").slice(0, 4)) || 0;
  const items = [...f.items, [type === "tv" ? "t" : "m", String(t.title || ""), year, t.id]] as Item[];
  await db.from("franchises").update({ items, items_auto_hash: hashOf(items) }).eq("id", fid).eq("source", "auto");
  await mapTitles(fid, [{ type, id: t.id }]); // the list is rebuilt the next time somebody opens it
}

// ---------- the answer ----------
async function serve(f0: Franchise): Promise<Record<string, unknown>> {
  let f = f0;
  const days = f.source === "auto" ? AUTO_REFRESH_DAYS : MANUAL_REFRESH_DAYS;
  const { data: row } = await db.from("related_cache").select("list,built_at,building_at,items_hash").eq("franchise_id", f.id).maybeSingle();
  const hash = () => hashOf(f.items);
  const have = !!(row && Array.isArray(row.list) && row.list.length && row.items_hash === hash());
  const fresh = have && row!.built_at && Date.now() - new Date(row!.built_at).getTime() < days * 86_400_000;
  if (fresh) return { franchise: f.id, name: f.name || "", list: row!.list, updated: row!.built_at };

  const locked = row?.building_at && Date.now() - new Date(row.building_at).getTime() < LOCK_MS;
  const old = row && Array.isArray(row.list) && row.list.length ? row.list : null;
  if (locked) return old ? { franchise: f.id, name: f.name || "", list: old, refreshing: true } : { franchise: f.id, name: f.name || "", building: true };

  await db.from("related_cache").upsert({ franchise_id: f.id, building_at: new Date().toISOString(), ...(row ? {} : { list: [] }) }, { ignoreDuplicates: false });
  const run = async () => {
    if (f.source === "auto" && (!f.learned_at || Date.now() - new Date(f.learned_at).getTime() > AUTO_REFRESH_DAYS * 86_400_000)) {
      try { f = await relearn(f); } catch { /* Wikidata busy: rebuild the list we have */ }
    }
    return await build(f, hash(), !!old);
  };
  if (old) { // serve the old copy now, rebuild in the background
    later(run());
    return { franchise: f.id, name: f.name || "", list: old, refreshing: true };
  }
  const list = await run();
  return { franchise: f.id, list, updated: new Date().toISOString() };
}

// A title Wikidata does not link (e.g. an anime series): match its TMDB name to a hand-written franchise.
// "Naruto Shippuden" -> match "naruto". Only a candidate: the caller checks the title is really in the built list.
async function byTitleName(seeds: Seed[]): Promise<Franchise | null> {
  const list = await manualFranchises();
  for (const s of seeds.slice(0, 3)) {
    let t: any;
    try { t = await details(s.type, s.id); } catch { continue; }
    const base = norm(t.title);
    const f = list.find((x) => x.match.some((k) => base === k || base.startsWith(k + " ")));
    if (f) return f;
  }
  return null;
}

// which franchise do these titles belong to? hand-written by name, then the learned titles, then ask Wikidata
async function find(name: string, seeds: Seed[], ip: string): Promise<Franchise | null> {
  if (name) {
    const base = collBase(name);
    const m = (await manualFranchises()).find((x) => x.match.some((k) => base === k || base.startsWith(k + " ")));
    if (m) return m;
  }
  if (!seeds.length) return null;
  const ors = seeds.map((s) => `and(tmdb_type.eq.${s.type},tmdb_id.eq.${s.id})`).join(",");
  const { data: hit } = await db.from("title_franchise").select("franchise_id").or(ors).limit(1);
  if (hit && hit.length) { const f = await franchiseById(hit[0].franchise_id); if (f) return f; }

  const cand = await byTitleName(seeds).catch(() => null);
  if (cand) {
    const a: any = await serve(cand);
    const inList = (r: any) => seeds.some((x) => x.id === r.id && x.type === r.media_type);
    if (!Array.isArray(a.list) || a.list.some(inList)) return cand; // still building: trust the name; else the title must be in the list
  }

  const since = new Date(Date.now() - NOFRANCHISE_DAYS * 86_400_000).toISOString();
  const { data: none } = await db.from("title_nofranchise").select("tmdb_id").or(ors).gt("checked_at", since);
  if (none && none.length >= seeds.length) return null; // every title was checked recently and has no franchise

  if (learnLimited(ip)) throw new Error("busy"); // too many new lookups from this address: say so, so nobody saves "no franchise"
  return await learn(seeds);
}

export { discover, anilistMembers, learn, wikidata, cleanTitle, infoboxLinks };
const int = (v: string | null) => (/^\d{1,9}$/.test(v || "") ? Number(v) : 0);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const xff = (req.headers.get("x-forwarded-for") || "").split(",").map((x) => x.trim()).filter(Boolean);
  const ip = req.headers.get("cf-connecting-ip") || xff[xff.length - 1] || "unknown";
  if (limited(ip)) return json({ error: "Too many requests" }, 429);

  if (req.method === "POST") { // "Report a missing title"
    if (reportLimited(ip)) return json({ error: "Too many requests" }, 429);
    try {
      await report(await req.json(), ip);
      return json({ ok: true });
    } catch (e) {
      const code = String((e as Error)?.message || "");
      const known = ["bad_report", "unknown_franchise", "not_listable", "not_saved"];
      return json({ error: known.includes(code) ? code : "failed" }, code === "not_saved" || !known.includes(code) ? 500 : 400);
    }
  }

  const u = new URL(req.url).searchParams;
  const name = u.get("name") || "";
  if (name.length > 120) return json({ error: "Bad name" }, 400);
  const seeds: Seed[] = [];
  const one = int(u.get("id"));
  if (one) seeds.push({ type: u.get("type") === "tv" ? "tv" : "movie", id: one });
  for (const x of (u.get("ids") || "").split(",").slice(0, 40)) { const n = int(x); if (n) seeds.push({ type: "movie", id: n }); }
  if (!name && !seeds.length) return json({ error: "Missing name or id" }, 400);

  const answer = async () => {
    try {
      const f = await find(name, seeds, ip);
      if (!f) return { franchise: null };
      return await serve(f);
    } catch (e) {
      if (String((e as Error)?.message) === "busy") return { franchise: null, busy: true }; // not an answer: the app tries again later
      throw e;
    }
  };

  if (u.get("warm") === "1") { // a title was just added: learn and build quietly, answer at once
    later(answer());
    return json({ ok: true });
  }
  try {
    return json(await answer());
  } catch (_e) {
    return json({ error: "Could not build the list" }, 502);
  }
});
