// Supabase Edge Function: "Similar taste" for a watched title.
//
//   GET  ?type=movie|tv&id=603     -> { weights, n, list }   a ranked pool of up to 50 titles, each with the reasons it was picked
//   POST {type, id, picked, shown} -> learns from one "Add selected" (picked = ticked keys, shown = every key that was on screen)
//
// How a list is made:
//   1. LANGUAGE  Tiers: 1 same language, 2 neighbouring languages (Malayalam -> Tamil, Telugu, Kannada; Turkish -> Arabic, Persian, Hebrew;
//                Thai -> Korean, Vietnamese, Japanese; Russian -> Ukrainian, Polish, Czech; Spanish -> Portuguese), 3 the rest of the country,
//                4 the world. With 20+ good titles in the language only that language is used. With fewer, the good ones in the
//                language are kept and the list is filled from the next tiers (each farther tier must score higher to get in).
//   2. CANDIDATES  Wikipedia "more like this" and Wikidata (same language + genre, same director / composer), TMDB recommendations, "what fans of those related titles also watch", rare shared keywords, Trakt and, for small
//                languages, the language's best titles in the same genres. Still too few: neighbouring languages, then worldwide.
//   3. TONE      How dark / intense a title is (genres, keywords, plot words, age rating U / UA / A) is compared: a comedy is pushed
//                far down for a violent thriller and the other way round. The same director / writer / composer counts too.
//   4. STORY     The best-looking candidates are read more closely: their Wikipedia article (plot, themes, reception) and the user
//                reviews on TMDB are added to the TMDB summary, and the texts are compared with the original's (TF-IDF cosine).
//      VIBE      The same text is read for how the film FEELS (slow-burn, twisty, emotional, dark, funny ...) and compared, and the
//                tone of the reviews and the stars reviewers gave make a small "audience" signal.
//   5a. CROWD    what people of this app ticked for this title (similar_votes) is a signal too; titles ticked 2+ times join the pool.
//   5. SIGNALS   Wikidata genre/subject/"based on", cast, era, IMDb / Rotten Tomatoes / Metacritic (OMDb, optional).
//   5b. WORLD    every title also gets a separate "Similar taste from world cinema" section: up to 6 strong matches in OTHER languages
//                (Korean, Japanese, French, Spanish, Hindi, Malayalam, English ...). They skip the language bar and must clear their own
//                checks: rating 7+, the main genres, a matching tone, and real likeness in plot / feel / rare subjects. They carry mix: true.
//   5c. ANGLES   (profile.ts) every title is read from five more angles, one by one: MOOD (melancholic, tense, bleak, eerie, warm ...), PACE (slow-burn, fast, steady),
//                LOOK (cinematography and style: lush, noir, neon, handheld, long takes ...), FORM (how it is told: twists, non-linear, ensemble, character study, true story ...) and
//                FEEL (what it does to you: devastating, thought-provoking, pulse-raising ...). They are counted in the plot, reception and reviews, then compared angle by angle.
//                Together with theme and plot they give a MATCH % and a "strong match" test (enough angles agree). A title that is not a strong match is pushed down, so the list is cut where it gets weak.
//   5d2. CROSS   every list also gets "the other kind": a film gets series, a series gets films. Found by shared keywords, core themes, genre (mapped between movie and TV genres), language and Wikipedia
//                "more like this"; they must pass the same strong-match test.
//   5d. PATTERN  the themes / tone / language most of the top matches share with the original, in plain words ("first love, LGBTQ love story, summer or seaside setting"). Shown above the list.
//   6. VARIETY   At most one title per franchise. The pool holds up to 50 titles; the app shows 10 and draws a new 10 every 24 hours.
//
// Saved in Supabase (table similar_raw) so the same title is never asked about twice: TMDB details and lists, Wikipedia + reviews,
// Wikidata tags and Trakt lists. A finished list is kept 7 days; after that the saved list is still shown at once and
// rebuilt in the background, so new releases come in every week.
// Letterboxd, IMDb and Rotten Tomatoes pages are not scraped (not allowed, and they block it). Only their scores via OMDb.
//
// Scoring: 25 numbers between 0 and 1 per title, a weighted sum through a logistic curve, minus the language / genre / tone
// penalty. The weights start from the defaults below and are LEARNED from
// "Add selected" (ticked = yes, the rest on screen = weak no), separately for each language group. The app also keeps a small
// personal adjustment on each device.
//
// Deploy:  supabase functions deploy similar --no-verify-jwt     (index.ts + logic.ts)
// Needs:   secret TMDB_API_KEY (already set for "related"), supabase/similar.sql run once.
// Optional: supabase secrets set OMDB_API_KEY=...   TRAKT_CLIENT_ID=...   (keys live ONLY as secrets, never in the app)
// Deploy files: index.ts + logic.ts + theme.ts + profile.ts + embed.ts
// OMDb quota: scores are saved per IMDb id and shared by every list, misses are remembered, calls are counted per day (see ratings()).

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  certOf, clamp, crewMatch, darkness, groupOf, maturityMatch, maturityOf, neighbours, selectPool, tierOf, TIER_LANG_X, TIER_PEN,
  POOL, toneMatch, pickWorld, WORLD, INDIA,
} from "./logic.ts";
import { themeProfile, themeMatch, themePen, coreThemes, themeKeywordIds, sharedThemes, type ThemeMatch } from "./theme.ts";
import { watchmodeOn, askWatchmode } from "./watchmode.ts";
import { heartOn, fetchHearts, heartMatch, heartText, heartWords, sharedHeartWords, suggestTitles, askFilmography, askAvailability, type Heart } from "./heart.ts";
import { docText, embedAll, cosine, embedX, embedOn } from "./embed.ts";
import { ANGLES, dna, describe, matchAngles, matchOf, craftMatch, type Angle, type Dna, type Match, type People } from "./profile.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const CACHE_VERSION = "v33";   // bump to make every saved list rebuild
const WEIGHTS_VERSION = 12;    // learned weights from an older feature set are ignored
const CACHE_DAYS = 7;         // a finished list is rebuilt weekly, so new releases come in
const STALE_DAYS = 21;        // between CACHE_DAYS and this age the saved list is still shown at once while a new one is built in the background
const RATINGS_DAYS = 90;      // IMDb / RT / Metacritic scores barely move: a saved score is reused this long, by every list
const MISS_DAYS = 14;         // a title OMDb does not know is remembered as "no score" and not asked about again for this long
const RESULTS = 60;           // titles kept per list (the app shows 15, up to 30 with "Show more", and draws a new set every 24 hours)
const OMDB_TOP = 30;          // only the best candidates are looked up on OMDb (its free plan is 1000 a day)
const OMDB_DAILY_CAP = 900;   // OMDb calls per UTC day, counted in the database for all lists together (free plan = 1000)
const MAX_DETAILS = 90;      // at most this many candidates are fetched in full
const CROSS_MAX = 8, CROSS_MIN = 0.4; // "the other kind": films for a series, series for a film
const ENRICH_TOP = 36;
const LITE_DETAILS = 50, LITE_ENRICH = 14; // "lite" build: used when the full one is killed for using too much CPU (HTTP 546)        // the best this many are read more closely (Wikipedia + reviews)
// How long each kind of saved raw input is reused (table similar_raw). Lists are kept a little under CACHE_DAYS, so a weekly rebuild sees fresh ones.
const RAW_DAYS = { info: 30, extra: 30, wd: 60, q: 6, trk: 6 };

// ---------- limits ----------
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; t: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.t > windowMs) { hits.set(ip, { n: 1, t: now }); if (hits.size > 5000) hits.clear(); return false; }
    return ++h.n > max;
  };
}
const limited = limiter(30, 60_000);
const buildLimited = limiter(30, 10 * 60_000); // a title is built in 3 parts (main, world, cross), so 10 titles per 10 minutes
const learnLimited = limiter(6, 60_000);

// ---------- scoring ----------
const FEATURES = ["kw", "story", "cast", "dir", "genre", "tone", "rec", "sim", "trk", "co", "agree", "wd", "quality", "era", "lang", "vibe", "recep", "crowd", "theme", "core", "mood", "pace", "look", "form", "feel"] as const;
type F = typeof FEATURES[number];
type Vec = Record<F, number>;
// kw     rare keywords in common         story  plot text similarity (TF-IDF)     cast   shared lead actors
// dir    same director / writer / composer                                         genre  genre overlap (main genres count double)
// tone   how dark / intense it is, and its age rating (U / UA / A), match the original
// rec    rank in TMDB "recommendations"  sim    rank in TMDB "similar"            trk    rank in Trakt "related"
// co     also recommended by the titles related to this one                        agree  found by several sources
// wd     Wikidata genre / subject / based-on in common                              quality TMDB + IMDb + Rotten Tomatoes
// era    release years close together    lang   same language (1), neighbour (0.5), same country (0.25)
// vibe   what reviewers and the Wikipedia reception say it FEELS like (slow-burn, twisty, emotional, dark, funny ...) matches the original
// recep  how warmly audiences write about it (tone of up to 12 TMDB reviews + their star ratings)
// theme  how much of the original's subject themes it has (theme.ts: ~45 themes from keywords + plot, plain rules)
// core   does it have the original's 1-2 core themes at all (also gates: none = penalty)
// mood   atmosphere (melancholic, tense, warm ...)      pace  slow-burn / fast / steady      look  cinematography and style (lush, noir, handheld ...)
// form   how it is told (twists, non-linear, ensemble, character study ...)      feel  what it does to the viewer (devastating, thought-provoking ...)   (all from profile.ts)
// crowd  what people of this app actually ticked for this original (table similar_votes): ticked often when shown = high
const BASE: Vec = { kw: .06, story: .10, cast: .03, dir: .05, genre: .06, tone: .05, rec: .03, sim: .01, trk: .01, co: .03, agree: .02, wd: .03, quality: .03, era: .01, lang: .02, vibe: .04, recep: .02, crowd: .05, theme: .15, core: .06, mood: .05, pace: .03, look: .04, form: .03, feel: .04 };
const SCALE = 8, BIAS = 3.2;      // z = SCALE * sum(w * x) - BIAS - penalty
const LR = 0.002;                 // learning rate (the app uses a larger one for its personal adjustment)
const REG = 0.02;                 // pull back toward the defaults after each update, so the weights cannot run away
const NEG_WEIGHT = 0.25;          // a title that was shown but not ticked is only a weak "no"
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const zOf = (w: Vec, x: Vec, pen = 0) => SCALE * FEATURES.reduce((s, f) => s + (w[f] || 0) * (x[f] || 0), 0) - BIAS - pen;

// the learned weights, one row per language group (south, north, eastasia, europe, en, other)
async function loadWeights(grp: string): Promise<{ w: Vec; n: number }> {
  try {
    const { data } = await db.from("similar_weights_g").select("w,n").eq("grp", grp).maybeSingle();
    if (data && data.w && (data.w as any).v === WEIGHTS_VERSION) return { w: { ...BASE, ...(data.w as Partial<Vec>) }, n: Number(data.n) || 0 };
  } catch { /* table missing: defaults */ }
  return { w: { ...BASE }, n: 0 };
}

// ---------- language ----------
// (tiers, neighbours and groups live in logic.ts)
const langName = (c: string) => { try { return new Intl.DisplayNames(["en"], { type: "language" }).of(c) || c; } catch { return c; } };

// ---------- helpers ----------
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
  }));
  return out;
}
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

// ---------- the rough inputs, kept in Supabase (table similar_raw) ----------
// k = what it is + which title, v = the answer as it came back (trimmed), t = when it was saved. A title is asked about once;
// every list that needs it reads it from here until it is older than its limit in RAW_DAYS.
async function rawGet(keys: string[], days: number): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (!keys.length) return out;
  const from = Date.now() - days * 864e5;
  try {
    for (let i = 0; i < keys.length; i += 100) {
      const { data } = await db.from("similar_raw").select("k,v,t").in("k", keys.slice(i, i + 100));
      for (const r of data || []) if (new Date(r.t).getTime() >= from) out.set(r.k, r.v);
    }
  } catch { /* table missing: ask live */ }
  return out;
}
async function rawPut(rows: { k: string; v: unknown }[]) {
  if (!rows.length) return;
  const t = new Date().toISOString();
  try { for (let i = 0; i < rows.length; i += 50) await db.from("similar_raw").upsert(rows.slice(i, i + 50).map((r) => ({ k: r.k, v: r.v, t }))); } catch { /* ignore */ }
}
function purgeRaw() { // saved inputs nobody has needed for 45 days go
  db.from("similar_raw").delete().lt("t", new Date(Date.now() - 45 * 864e5).toISOString()).not("k", "like", "heart1:%").then(() => {}, () => {});
}
async function sha1(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// a TMDB list (recommendations, similar, discover, search): the fields the scoring uses, at most 20 titles, saved
const slim = (r: any) => ({
  id: r.id, original_language: r.original_language, release_date: r.release_date, first_air_date: r.first_air_date, poster_path: r.poster_path,
  vote_count: r.vote_count, vote_average: r.vote_average, adult: r.adult, genre_ids: r.genre_ids, title: r.title, name: r.name,
});
async function tmdbList(path: string, params: Record<string, string> = {}): Promise<any[]> {
  const k = "q:" + await sha1(path + "?" + Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)).map(([a, b]) => a + "=" + b).join("&"));
  const hit = (await rawGet([k], RAW_DAYS.q)).get(k);
  if (hit) return hit as any[];
  const list = (((await tmdb(path, params)).results || []) as any[]).slice(0, 20).map(slim);
  await rawPut([{ k, v: list }]);
  return list;
}

// ---------- what we know about one title ----------
type Pair = [number, string];
type Crew = { d: Pair[]; w: Pair[]; m: Pair[]; p: Pair[] }; // directors (series: creators), writers, composers, directors of photography
type Info = {
  id: number; kind: string; title: string; poster_path: string | null; release_date: string; first_air_date: string;
  vote_average: number; vote_count: number; lang: string; adult: boolean; collection: number;
  genres: Pair[]; kws: Pair[]; cast: Pair[]; crew: Crew; cert: string; mat: number; imdb: string; text: string; runtime: number;
};
const INFO_V = "i3"; // part of the saved key: bump when the Info shape changes
async function info(kind: string, id: number): Promise<Info> {
  const r = await tmdb("/" + kind + "/" + id, { append_to_response: "keywords,credits,external_ids," + (kind === "tv" ? "content_ratings" : "release_dates") });
  const kwRaw: any[] = kind === "tv" ? (r.keywords?.results || []) : (r.keywords?.keywords || []);
  const kws = kwRaw.map((k) => [k.id, String(k.name || "").toLowerCase()] as Pair);
  const crewRaw: any[] = r.credits?.crew || [];
  const pairs = (list: any[], n: number): Pair[] => {
    const seen = new Set<number>(), out: Pair[] = [];
    for (const p of list) if (p?.id && !seen.has(p.id)) { seen.add(p.id); out.push([p.id, String(p.name || "")]); }
    return out.slice(0, n);
  };
  const crew: Crew = {
    d: kind === "tv" ? pairs(r.created_by || [], 3) : pairs(crewRaw.filter((c) => c.job === "Director"), 3),
    w: pairs(crewRaw.filter((c) => ["Screenplay", "Writer", "Story"].includes(c.job)), 3),
    m: pairs(crewRaw.filter((c) => ["Original Music Composer", "Music"].includes(c.job)), 2),
    p: pairs(crewRaw.filter((c) => c.job === "Director of Photography"), 2),
  };
  if (!crew.d.length) crew.d = pairs(crewRaw.filter((c) => c.job === "Director"), 3);
  const cert = certOf(kind, r);
  return {
    id: r.id, kind, title: r.title || r.name || "", poster_path: r.poster_path || null,
    release_date: r.release_date || "", first_air_date: r.first_air_date || "",
    vote_average: r.vote_average || 0, vote_count: r.vote_count || 0, lang: r.original_language || "",
    adult: !!r.adult, collection: r.belongs_to_collection?.id || 0,
    genres: (r.genres || []).map((g: any) => [g.id, g.name] as Pair),
    kws,
    cast: (r.credits?.cast || []).slice(0, 6).map((p: any) => [p.id, p.name] as Pair),
    crew, cert, mat: maturityOf(cert),
    imdb: r.external_ids?.imdb_id || r.imdb_id || "", runtime: Number(r.runtime || (r.episode_run_time || [])[0]) || 0,
    text: [r.overview || "", r.tagline || "", kws.filter(([, n]) => !STOP.has(n)).map(([, n]) => n).join(" ")].join(" "),
  };
}
// many titles at once: saved ones come from the database, only the missing ones are asked of TMDB (and saved)
async function infoMany(kind: string, ids: number[]): Promise<(Info | null)[]> {
  const keys = ids.map((id) => `info:${INFO_V}:${kind}:${id}`);
  const have = await rawGet(keys, RAW_DAYS.info);
  const got = await pool(ids, 8, async (id) => (have.get(`info:${INFO_V}:${kind}:${id}`) as Info | undefined) || await info(kind, id));
  await rawPut(ids.flatMap((id, i) => (!have.has(keys[i]) && got[i] ? [{ k: keys[i], v: got[i] }] : [])));
  return got;
}
const yearOf = (i: { release_date: string; first_air_date: string }) => Number((i.release_date || i.first_air_date || "").slice(0, 4)) || 0;

// keywords that say nothing about the story: format tags, moods, very generic words
const STOP = new Set([
  "based on novel or book", "sequel", "duringcreditsstinger", "aftercreditsstinger", "woman director", "based on comic", "based on true story",
  "independent film", "friendship", "love", "family", "remake", "reboot", "prequel", "based on tv series", "based on video game", "3d", "imax",
  "excited", "happy", "sad", "angry", "dark", "suspenseful", "romantic", "melancholy", "tense", "cheerful", "funny",
  "hopeful", "nostalgic", "playful", "sentimental", "admiring", "amused", "inspiring", "joyful", "exhilarated", "thrilling", "passionate", "dramatic",
  "intense", "sarcastic", "serious", "witty", "mysterious", "anxious", "bleak", "gloomy", "optimistic", "powerful", "emotional", "touching", "comedy",
  "drama", "action", "thriller", "horror", "film", "movie", "scene", "camera", "tv series", "miniseries", "anime", "cartoon", "short film",
]);

// ---------- story similarity: TF-IDF over the plot text ----------
const SW = new Set(("about after again against also been before being between both came come could does down during each even ever from have having here " +
  "into just like made make many more most much must only other over same should since some such than that their them then there these they this those " +
  "through under until very want were what when where which while with without would your his her him she you the and for are was not out one two who " +
  "how its has had can will film movie story finds find soon along around back become becomes begin begins life world man woman young new old").split(" "));
const stemOrig = new Map<string, string>();
function terms(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z]+/)) {
    if (w.length < 4 || SW.has(w)) continue;
    const s = w.replace(/(ing|ed|es|s|ly)$/, "");
    if (s.length < 3) continue;
    if (!stemOrig.has(s)) stemOrig.set(s, w);
    out.push(s);
  }
  // two-word phrases too ("first love", "coming age", "small town"): they carry the subject better than single words (idea from open-source TF-IDF recommenders)
  const n = out.length;
  for (let i = 0; i + 1 < n; i++) if (out[i] !== out[i + 1]) out.push(out[i] + "_" + out[i + 1]);
  return out;
}
function storyScores(seedText: string, texts: string[]): { score: number; words: string[] }[] {
  const docs = [seedText, ...texts].map(terms);
  const N = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const vec = (d: string[]) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of tf) { const wt = (1 + Math.log(c)) * Math.log((N + 1) / (df.get(t) || 1)); v.set(t, wt); norm += wt * wt; }
    return { v, norm: Math.sqrt(norm) || 1 };
  };
  const s = vec(docs[0]);
  return docs.slice(1).map((d) => {
    const c = vec(d);
    let dot = 0;
    const shared: [string, number][] = [];
    for (const [t, wt] of c.v) { const sw = s.v.get(t); if (sw) { dot += wt * sw; shared.push([t, wt * sw]); } }
    shared.sort((a, b) => b[1] - a[1]);
    return { score: dot / (s.norm * c.norm), words: shared.map(([t]) => stemOrig.get(t) || t).filter((w) => w.length >= 5 && !w.includes("_")).slice(0, 3) };
  });
}

// raw cosine values are small and bunched together, so blend the raw value with the title's rank among its rivals
function storyX(scores: number[]): number[] {
  const order = scores.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const pct = new Array(scores.length).fill(0);
  order.forEach(([, i], rank) => { pct[i] = scores.length > 1 ? rank / (scores.length - 1) : 0; });
  return scores.map((v, i) => clamp(0.5 * pct[i] + 0.5 * clamp(v / 0.3)));
}

// ---------- meaning: a small text-embedding model (embed.ts) reads each title as ONE text and compares it with the original ----------
// Cached per title in similar_raw (key emb1:kind:id), so a title is embedded once. Returns the cosine per title, or null when the model is not available.
// ---------- the HEART of a film (heart.ts): who it is about and what drives it. Asked once from Gemini, saved forever ----------
const heartKey = (k: string, id: number) => `heart1:${k}:${id}`;
type HeartItem = { kind: string; info: Info; text: string };
type HeartScore = { theme: number; core: number; h: Heart };
async function heartsOf(list: HeartItem[], dbgBox?: Record<string, unknown>): Promise<Map<string, Heart>> {
  const out = new Map<string, Heart>();
  if (!list.length) return out;
  const keys = list.map((x) => heartKey(x.kind, x.info.id));
  const have = await rawGet(keys, 400);
  const need: HeartItem[] = [];
  list.forEach((x, i) => { const h = have.get(keys[i]); if (h) out.set(keys[i], h as Heart); else need.push(x); });
  if (need.length && heartOn()) {
    const r = await fetchHearts(need.map((x) => ({
      id: x.info.id, title: x.info.title, year: (x.info.release_date || x.info.first_air_date || "").slice(0, 4),
      genres: x.info.genres.map(([, n]) => n).join(", "), keywords: x.info.kws.slice(0, 12).map(([, n]) => n).join(", "), plot: x.text.replace(/\s+/g, " ").slice(0, 1100),
    })));
    if (dbgBox) { dbgBox.heartAsked = ((dbgBox.heartAsked as number) || 0) + need.length; if (r.error) dbgBox.heartError = r.error; }
    const put: { k: string; v: unknown }[] = [];
    for (const x of need) { const h = r.map.get(x.info.id); if (h) { out.set(heartKey(x.kind, x.info.id), h); put.push({ k: heartKey(x.kind, x.info.id), v: h }); } }
    await rawPut(put);
  }
  return out;
}
// the heart match of every candidate with the original: theme (how much of its heart it shares) and core (does it share the main drive at all)
async function heartScores(seedItem: HeartItem, items: HeartItem[], dbgBox?: Record<string, unknown>): Promise<{ seed?: Heart; scores: Map<number, HeartScore> }> {
  const scores = new Map<number, HeartScore>();
  if (!heartOn()) return { scores };
  const all = await heartsOf([seedItem, ...items], dbgBox);
  const sh = all.get(heartKey(seedItem.kind, seedItem.info.id));
  if (!sh) return { scores };
  const got = items.filter((x) => all.has(heartKey(x.kind, x.info.id)));
  if (!got.length) return { seed: sh, scores };
  const st = storyX(storyScores(heartText(sh), got.map((x) => heartText(all.get(heartKey(x.kind, x.info.id))!))).map((v) => v.score));
  got.forEach((x, i) => {
    const h = all.get(heartKey(x.kind, x.info.id))!, m = heartMatch(sh, h);
    scores.set(x.info.id, { theme: clamp(0.5 * m.engine + 0.2 * m.rel + 0.15 * m.ending + 0.15 * st[i]), core: clamp(m.core), h });
  });
  return { seed: sh, scores };
}
// the heart replaces most of the keyword-theme result (the keyword result stays as a smaller part; it is all there is for a film without a heart)
const withHeart = (th: ThemeMatch, h?: HeartScore): ThemeMatch => !h ? th : {
  heart: true, has: true, theme: th.has ? clamp(0.3 * th.theme + 0.7 * h.theme) : h.theme, core: th.has ? clamp(0.25 * th.core + 0.75 * h.core) : h.core, anti: th.anti, core_ids: th.core_ids,
};

// films with the same heart, suggested by Gemini (saved), then looked up on TMDB. scope "world": only other languages.
async function heartPicks(kind: string, seed: Info, h: Heart | undefined, scope: "any" | "world", find: (p: string, params?: Record<string, string>) => Promise<any[]>, dbgBox: Record<string, unknown>): Promise<any[]> {
  if (!h || !heartOn()) return [];
  const key = `heartsug1:${kind}:${scope}:${seed.id}`;
  let titles = (await rawGet([key], 400)).get(key) as { title: string; year: number }[] | undefined;
  if (!titles) {
    const r = await suggestTitles({ title: seed.title, year: (seed.release_date || seed.first_air_date || "").slice(0, 4), kind, story: h.story, rel: h.rel, engine: h.engine, ending: h.ending }, scope, langName(seed.lang || "en"));
    if (r.error) dbgBox["sugError_" + scope] = r.error;
    titles = r.titles;
    if (titles.length) await rawPut([{ k: key, v: titles }]);
  }
  const yp = (y: number): Record<string, string> => (y ? (kind === "tv" ? { first_air_date_year: String(y) } : { year: String(y) }) : {});
  const res = await pool(titles, 6, async (t) => {
    let l = await find(`/search/${kind}`, { query: t.title, ...yp(t.year) });
    if (!l.length && t.year) l = await find(`/search/${kind}`, { query: t.title });
    return l.find((r) => r.id !== seed.id && r.poster_path) || null;
  });
  const out = res.filter(Boolean).filter((r: any) => scope !== "world" || !seed.lang || r.original_language !== seed.lang) as any[];
  dbgBox["sug_" + scope] = { asked: titles.length, found: out.length, titles: out.slice(0, 18).map((r: any) => r.title || r.name) };
  return out;
}

async function meaningScores(kind: string, seed: Info, seedPlot: string, list: { info: Info; plot: string }[]): Promise<number[] | null> {
  const docOf = (i: Info, plot: string) => docText([i.title + (i.release_date || i.first_air_date ? " (" + (i.release_date || i.first_air_date).slice(0, 4) + ")" : ""), i.genres.map(([, n]) => n).join(", "), i.lang, i.text, plot.slice(0, 700)]);
  const all = [seed, ...list.map((x) => x.info)];
  const keys = all.map((i) => `emb1:${kind}:${i.id}`);
  const have = await rawGet(keys, 60);
  const need = all.map((_, i) => i).filter((i) => !have.has(keys[i]));
  if (need.length) {
    const vs = await embedAll(need.map((i) => docOf(all[i], i === 0 ? seedPlot : list[i - 1].plot)));
    const put: { k: string; v: unknown }[] = [];
    need.forEach((i, n) => { if (vs[n]) { have.set(keys[i], vs[n]); put.push({ k: keys[i], v: vs[n] }); } });
    await rawPut(put);
  }
  const sv = have.get(keys[0]) as number[] | undefined;
  if (!sv) return null;
  return list.map((_, i) => { const v = have.get(keys[i + 1]) as number[] | undefined; return v ? cosine(sv, v) : -1; });
}

// ---------- real analysis text: the English Wikipedia article and the user reviews on TMDB ----------
const UA = "movie-watchlist-app/1.0 (similar taste)";
async function wikiTitles(kind: string, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  const prop = kind === "tv" ? "P4983" : "P4947";
  const q = `SELECT ?tid ?name WHERE {
    VALUES ?tid { ${ids.map((i) => `"${i}"`).join(" ")} }
    ?item wdt:${prop} ?tid .
    ?art schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?name .
  }`;
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), {
    headers: { Accept: "application/sparql-results+json", "User-Agent": UA }, signal: AbortSignal.timeout(9_000),
  });
  if (!r.ok) throw new Error("Wikidata " + r.status);
  for (const row of (await r.json()).results?.bindings || []) { const id = Number(row.tid?.value); if (id && row.name?.value) out.set(id, row.name.value); }
  return out;
}
async function wikiText(title: string): Promise<string> {
  const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&redirects=1&format=json&titles=" + encodeURIComponent(title), {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error("Wikipedia " + r.status);
  const pages = (await r.json()).query?.pages || {};
  const ex = String((Object.values(pages)[0] as any)?.extract || "");
  const grab = (names: string[], len: number) => {
    for (const n of names) { const m = ex.search(new RegExp("\\n" + n + "\\s*\\n", "i")); if (m >= 0) return ex.slice(m + n.length + 1, m + n.length + 1 + len); }
    return "";
  };
  return [ex.slice(0, 1200), grab(["Plot", "Synopsis", "Premise", "Storyline"], 2500), grab(["Themes and analysis", "Themes", "Analysis", "Style and themes", "Critical reception", "Reception"], 1500)].join(" ");
}
// id -> everything extra we could read about the title
//   text     Wikipedia + the first 3 reviews: compared for STORY (as before)
//   feel     Wikipedia (incl. reception) + up to 8 reviews: compared for VIBE
//   reviews  the review text alone, and rated = the star ratings (1-10) reviewers gave: used for audience tone (recep)
// The 8 reviews come from the same single TMDB call as before (it returns up to 20), so this costs no extra requests.
type Extra = { text: string; feel: string; reviews: string; rated: number[] };
// what is saved per title: the Wikipedia text (w), up to 8 reviews (r) and the stars they gave (s)
type RawExtra = { w: string; r: string[]; s: number[] };
const fromRaw = (x: RawExtra): Extra => ({
  text: x.w + " " + x.r.slice(0, 3).map((t) => t.slice(0, 700)).join(" "),
  feel: x.w + " " + x.r.join(" \n "),
  reviews: x.r.join(" \n "),
  rated: x.s,
});
async function enrich(kind: string, ids: number[]): Promise<Map<number, Extra>> {
  const out = new Map<number, Extra>();
  const keys = ids.map((id) => `extra2:${kind}:${id}`);
  const have = await rawGet(keys, RAW_DAYS.extra);
  const need: number[] = [];
  ids.forEach((id, i) => { const h = have.get(keys[i]); if (h) out.set(id, fromRaw(h as RawExtra)); else need.push(id); });
  if (!need.length) return out;
  let titles = new Map<number, string>();
  let wikiFailed = false;
  try { titles = await wikiTitles(kind, need); } catch { wikiFailed = true; /* Wikipedia is a bonus */ }
  const rows: { k: string; v: unknown }[] = [];
  await pool(need, 8, async (id) => {
    let wiki = "", rs: any[] = [], failed = wikiFailed;
    const t = titles.get(id);
    if (t) { try { wiki = await wikiText(t); } catch { failed = true; } }
    try {
      const rv = await tmdb(`/${kind}/${id}/reviews`);
      rs = ((rv.results || []) as any[]).filter((x) => x && x.content).slice(0, 8);
    } catch { failed = true; }
    const raw: RawExtra = {
      w: wiki, r: rs.map((x) => String(x.content).slice(0, 600)),
      s: rs.map((x) => Number(x.author_details?.rating)).filter((n) => n > 0 && n <= 10),
    };
    out.set(id, fromRaw(raw));
    if (!failed || wiki || rs.length) rows.push({ k: `extra2:${kind}:${id}`, v: raw }); // a title that only failed for now is asked again later
  });
  await rawPut(rows);
  return out;
}

// ---------- vibe: what reviewers say it feels like ----------
// Each pattern is one "feeling" people name when they talk about a film. A title's profile is how often reviewers (and the
// Wikipedia reception) use each one. Two titles with the same profile (say slow-burn + emotional + great performances) feel alike
// even when their plots share no words. Feelings that almost every title in the pool has count for less (idf).
const ASPECTS: RegExp[] = [
  /slow[- ]?burn|slow[- ]paced|slowly|deliberate|meditative|methodical|unhurried|patient/g,
  /fast[- ]paced|gripping|edge of (?:your|my) seat|relentless|breathless|non[- ]?stop|adrenaline|pulse[- ]pounding/g,
  /twist|unpredictable|shocking|mind[- ]?bending|jaw[- ]dropping|plot hole|surprising|reveal/g,
  /emotional|heartfelt|moving|tear|touching|heartbreaking|poignant|tearjerker|cried|cry/g,
  /\bdark\b|gritty|bleak|disturbing|grim|haunting|nihilis|brutal|unsettling|violent/g,
  /funny|hilarious|comedic|humou?r|witty|laugh|satir|parody|spoof/g,
  /feel[- ]good|heartwarming|uplifting|charming|wholesome|delightful|cosy|cozy|lighthearted/g,
  /thought[- ]provoking|philosoph|profound|layered|allegor|metaphor|existential|social commentary|subtext|symbolism/g,
  /performance|acting|portrayal|chemistry|\bcast\b|lead role|screen presence/g,
  /cinematograph|visuals?|visually|beautifully shot|stunning|score|soundtrack|background music|\bmusic\b/g,
  /realistic|grounded|authentic|\braw\b|true to life|naturalistic|slice of life|believable/g,
  /suspense|tense|tension|thriller|mystery|whodunit|investigat|detective|clues/g,
  /romance|romantic|love story|relationship|couple/g,
  /action|fight|chase|explosi|stunt|shootout|combat/g,
  /coming[- ]of[- ]age|nostalg|childhood|growing up|friendship|village/g,
  /heist|crime|gangster|mafia|revenge|vengeance|underworld|corrupt/g,
  /horror|scary|creepy|terrifying|supernatural|ghost|haunted|jump scare/g,
  /epic|sweeping|grand|spectacle|ambitious|large[- ]scale|world[- ]?building/g,
  /predictable|cliche|cliché|formulaic|generic|overlong|too long|drags/g, // what reviewers disliked also describes a film
];
const aspectVec = (text: string): number[] => {
  const t = text.toLowerCase();
  return ASPECTS.map((re) => (t.match(re) || []).length);
};
// cosine of the aspect profiles, damped counts (sqrt) and idf over the pool; seed first. 0.5 for everyone if the original has no profile.
function vibeX(seed: number[], pool_: number[][]): number[] {
  if (seed.reduce((a, b) => a + b, 0) < 3) return pool_.map(() => 0.5);
  const all = [seed, ...pool_];
  const N = all.length;
  const idf = ASPECTS.map((_, k) => Math.log((N + 1) / (all.filter((v) => v[k] > 0).length + 0.5)));
  const vec = (v: number[]) => { const w = v.map((c, k) => Math.sqrt(c) * idf[k]); return { w, n: Math.sqrt(w.reduce((s, x) => s + x * x, 0)) || 1 }; };
  const s = vec(seed);
  const cos = pool_.map((v) => { const c = vec(v); return c.w.reduce((d, x, k) => d + x * s.w[k], 0) / (s.n * c.n); });
  const order = cos.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const pct = new Array(cos.length).fill(0);
  order.forEach(([, i], r) => { pct[i] = cos.length > 1 ? r / (cos.length - 1) : 0; });
  return cos.map((v, i) => clamp(0.5 * pct[i] + 0.5 * clamp((v - 0.15) / 0.6)));
}

// ---------- audience tone: how warmly reviewers write about it (words + the stars they gave) ----------
const POS_RE = /\b(brilliant|masterpiece|excellent|great|amazing|superb|outstanding|loved|fantastic|beautiful|perfect|recommend|wonderful|stunning|gripping|powerful|captivating|impressive|must[- ]watch|well[- ]made|engaging|compelling|gem)\b/g;
const NEG_RE = /\b(boring|awful|terrible|disappointing|disappointed|weak|waste|dull|poor|mess|predictable|overrated|forgettable|cliche|cliché|annoying|worst|flawed|uneven|mediocre|bland|tedious)\b/g;
function receptionOf(e?: Extra): number {
  if (!e || (!e.reviews && !e.rated.length)) return 0.5; // nothing to read: neutral, neither helps nor hurts
  const t = e.reviews.toLowerCase();
  const p = (t.match(POS_RE) || []).length, n = (t.match(NEG_RE) || []).length;
  const words = 0.5 + 0.5 * (p - n) / (p + n + 4);
  if (!e.rated.length) return clamp(words);
  const stars = e.rated.reduce((a, b) => a + b, 0) / e.rated.length;
  return clamp(0.5 * words + 0.5 * clamp((stars - 4) / 5));
}

// ---------- Wikidata: genre, main subject, "based on" for a batch of TMDB ids ----------
type Tags = Map<string, number>; // label -> weight (genre 1, subject 2, based on 2)
async function wikidata(kind: string, ids: number[]): Promise<Map<number, Tags>> {
  const out = new Map<number, Tags>();
  if (!ids.length) return out;
  const prop = kind === "tv" ? "P4983" : "P4947";
  const q = `SELECT ?tid ?gL ?sL ?bL WHERE {
    VALUES ?tid { ${ids.map((i) => `"${i}"`).join(" ")} }
    ?item wdt:${prop} ?tid .
    OPTIONAL { ?item wdt:P136 ?g . ?g rdfs:label ?gL . FILTER(LANG(?gL) = "en") }
    OPTIONAL { ?item wdt:P921 ?s . ?s rdfs:label ?sL . FILTER(LANG(?sL) = "en") }
    OPTIONAL { ?item wdt:P144 ?b . ?b rdfs:label ?bL . FILTER(LANG(?bL) = "en") }
  }`;
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), {
    headers: { Accept: "application/sparql-results+json", "User-Agent": "movie-watchlist-app/1.0 (similar taste)" },
    signal: AbortSignal.timeout(9_000),
  });
  if (!r.ok) throw new Error("Wikidata " + r.status);
  const rows = (await r.json()).results?.bindings || [];
  for (const row of rows) {
    const id = Number(row.tid?.value);
    if (!id) continue;
    const t = out.get(id) || new Map<string, number>();
    if (row.gL) t.set(row.gL.value.toLowerCase(), Math.max(t.get(row.gL.value.toLowerCase()) || 0, 1));
    if (row.sL) t.set(row.sL.value.toLowerCase(), 2);
    if (row.bL) t.set(row.bL.value.toLowerCase(), 2);
    out.set(id, t);
  }
  return out;
}

// the same, with each title's tags saved (a title Wikidata knows nothing about is saved as empty, so it is not asked again)
async function wikidataC(kind: string, ids: number[]): Promise<Map<number, Tags>> {
  const out = new Map<number, Tags>();
  const keys = ids.map((id) => `wd:${kind}:${id}`);
  const have = await rawGet(keys, RAW_DAYS.wd);
  const need: number[] = [];
  ids.forEach((id, i) => { const h = have.get(keys[i]); if (h) out.set(id, new Map(h as [string, number][])); else need.push(id); });
  if (!need.length) return out;
  let got: Map<number, Tags> | null = null;
  try { got = await wikidata(kind, need); } catch { /* Wikidata is a bonus: use what is saved */ }
  if (got) {
    const rows = need.map((id) => { const t = got!.get(id) || new Map<string, number>(); out.set(id, t); return { k: `wd:${kind}:${id}`, v: [...t] }; });
    await rawPut(rows);
  }
  return out;
}

// ---------- OMDb: IMDb, Rotten Tomatoes, Metacritic ----------
// OMDb's free plan is 1000 calls a day, so every call is made to count:
//   - one saved score per IMDb id (table title_ratings) serves EVERY list: a title that shows up for many films is fetched once
//   - a title OMDb does not know is saved as "miss" so it is not asked about again for MISS_DAYS
//   - an expired score is only refreshed when there is quota left; otherwise the old score is still used
//   - calls are counted per UTC day in the database (omdb_reserve) and stop at OMDB_DAILY_CAP, or as soon as OMDb says "limit reached"
//   - the same title asked for twice at the same moment is one call
type Rating = { imdb: number | null; votes: number | null; rt: number | null; meta: number | null };
type Fetched = { imdb: string; v: Rating | null }; // v = null: OMDb does not know this title
class OmdbLimit extends Error {}
const inflight = new Map<string, Promise<Fetched>>();

async function fetchOmdb(key: string, imdb: string): Promise<Fetched> {
  const r = await fetch("https://www.omdbapi.com/?apikey=" + encodeURIComponent(key) + "&i=" + encodeURIComponent(imdb), { signal: AbortSignal.timeout(8_000) });
  const j = await r.json().catch(() => ({} as any)); // OMDb answers 401 with a JSON body when the limit is reached
  const err = String(j?.Error || "");
  if (/limit/i.test(err)) throw new OmdbLimit(err);
  if (j?.Response === "False") {
    if (/not found|incorrect imdb id|error getting data/i.test(err)) return { imdb, v: null };
    throw new Error("OMDb " + (err || r.status));
  }
  if (!r.ok) throw new Error("OMDb " + r.status);
  const num = (s: unknown) => { const n = parseFloat(String(s || "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
  const rt = (j.Ratings || []).find((x: any) => x.Source === "Rotten Tomatoes");
  return { imdb, v: { imdb: num(j.imdbRating), votes: num(j.imdbVotes), rt: rt ? num(rt.Value) : null, meta: num(j.Metascore) } };
}
function omdbOne(key: string, imdb: string): Promise<Fetched> {
  let p = inflight.get(imdb);
  if (!p) { p = fetchOmdb(key, imdb).finally(() => inflight.delete(imdb)); inflight.set(imdb, p); }
  return p;
}
// asks the database how many of n calls may still be made today (0 once the cap or an OMDb "limit reached" is hit)
async function omdbReserve(n: number): Promise<number> {
  try {
    const { data, error } = await db.rpc("omdb_reserve", { p_n: n, p_cap: OMDB_DAILY_CAP });
    if (!error && Number.isInteger(data)) return Math.max(0, Math.min(n, data as number));
  } catch { /* function missing: see below */ }
  return Math.min(n, 10); // supabase/similar.sql was not re-run: stay small instead of unguarded
}

// partial = some titles got no score only because the daily quota ran out (the list is then rebuilt sooner)
async function ratings(imdbIds: string[]): Promise<{ map: Map<string, Rating>; partial: boolean }> {
  const out = new Map<string, Rating>();
  const key = Deno.env.get("OMDB_API_KEY");
  const ids = [...new Set(imdbIds.filter(Boolean))]; // already in ranking order: the best titles get the quota first
  if (!key || !ids.length) return { map: out, partial: false };
  const freshFrom = Date.now() - RATINGS_DAYS * 864e5, missFrom = Date.now() - MISS_DAYS * 864e5;
  const settled = new Set<string>(); // already answered: no call needed
  try {
    let q: any = await db.from("title_ratings").select("imdb_id,imdb,votes,rt,meta,miss,fetched_at").in("imdb_id", ids);
    if (q.error) q = await db.from("title_ratings").select("imdb_id,imdb,votes,rt,meta,fetched_at").in("imdb_id", ids); // `miss` column not added yet
    for (const r of q.data || []) {
      const t = new Date(r.fetched_at).getTime();
      if (r.miss) { if (t >= missFrom) settled.add(r.imdb_id); continue; }
      out.set(r.imdb_id, { imdb: r.imdb, votes: r.votes, rt: r.rt, meta: r.meta }); // an expired score stays as the fallback
      if (t >= freshFrom) settled.add(r.imdb_id);
    }
  } catch { /* table missing: fetch live */ }
  const need = ids.filter((i) => !settled.has(i));
  if (!need.length) return { map: out, partial: false };

  const granted = await omdbReserve(need.length);
  const go = need.slice(0, granted);
  let stop = false;
  const fresh = await pool(go, 6, async (imdb) => {
    if (stop) return null;
    try { return await omdbOne(key, imdb); }
    catch (e) {
      if (e instanceof OmdbLimit) { stop = true; try { await db.rpc("omdb_block"); } catch { /* ignore */ } }
      throw e;
    }
  });
  const now = new Date().toISOString();
  const rows: any[] = [];
  for (const f of fresh) {
    if (!f) continue;
    if (f.v) out.set(f.imdb, f.v); else out.delete(f.imdb);
    rows.push({ imdb_id: f.imdb, imdb: f.v?.imdb ?? null, votes: f.v?.votes ?? null, rt: f.v?.rt ?? null, meta: f.v?.meta ?? null, miss: !f.v, fetched_at: now });
  }
  if (rows.length) {
    try {
      const { error } = await db.from("title_ratings").upsert(rows);
      if (error) await db.from("title_ratings").upsert(rows.filter((r) => !r.miss).map(({ miss: _m, ...r }) => r)); // `miss` column not added yet
    } catch { /* ignore */ }
  }
  const skipped = need.filter((i) => !go.includes(i) || fresh[go.indexOf(i)] === null);
  return { map: out, partial: skipped.some((i) => !out.has(i)) };
}

// ---------- Trakt: related titles (optional) ----------
async function traktRelated(kind: string, imdb: string): Promise<number[]> {
  const id = Deno.env.get("TRAKT_CLIENT_ID");
  if (!id || !imdb) return [];
  const r = await fetch(`https://api.trakt.tv/${kind === "tv" ? "shows" : "movies"}/${imdb}/related?limit=20`, {
    headers: { "trakt-api-key": id, "trakt-api-version": "2", "Content-Type": "application/json" }, signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error("Trakt " + r.status);
  return ((await r.json()) as any[]).map((x) => x?.ids?.tmdb).filter((n) => Number.isInteger(n));
}

async function traktC(kind: string, imdb: string): Promise<number[]> {
  if (!imdb || !Deno.env.get("TRAKT_CLIENT_ID")) return [];
  const k = `trk:${kind}:${imdb}`;
  const hit = (await rawGet([k], RAW_DAYS.trk)).get(k);
  if (hit) return hit as number[];
  const ids = await traktRelated(kind, imdb);
  await rawPut([{ k, v: ids }]);
  return ids;
}

// ---------- Wikipedia / Wikidata as a SOURCE OF CANDIDATES (not only for scoring) ----------
// 1. Wikipedia's own "more like this" search (CirrusSearch morelike:) on the film's article: the articles most alike in wording and subject.
// 2. Wikidata: films with the same original language AND a genre in common, best known first (most Wikipedia languages), plus films
//    by the same director or composer. Everything is mapped back to TMDB ids through Wikidata (TMDB id property), so the normal scoring takes over.
// OMDb has no "similar titles" call (only look-ups by id / title), so it stays a source of scores. Saved for RAW_DAYS.wd days.
const sparql = async (q: string, ms = 9_000) => {
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), {
    headers: { Accept: "application/sparql-results+json", "User-Agent": UA }, signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error("Wikidata " + r.status);
  return ((await r.json()).results?.bindings || []) as any[];
};
async function wikiCandidates(kind: string, seedId: number, target = kind): Promise<number[]> {
  const prop = kind === "tv" ? "P4983" : "P4947";          // how the ORIGINAL is found in Wikidata
  const tprop = target === "tv" ? "P4983" : "P4947";       // how the CANDIDATES are mapped back to TMDB ids (the other kind for the cross section)
  const out: number[] = [];
  const add = (n: unknown) => { const v = Number(n); if (Number.isInteger(v) && v > 0 && (target !== kind || v !== seedId) && !out.includes(v)) out.push(v); };
  // 1. morelike
  try {
    const title = (await wikiTitles(kind, [seedId])).get(seedId);
    if (title) {
      const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=40&srnamespace=0&srsearch=" + encodeURIComponent("morelike:" + title), {
        headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8_000),
      });
      const names: string[] = ((await r.json()).query?.search || []).map((x: any) => String(x.title || "")).filter(Boolean);
      if (names.length) {
        const vals = names.map((n) => `"${n.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"@en`).join(" ");
        const rows = await sparql(`SELECT ?tid ?n WHERE { VALUES ?n { ${vals} } ?art schema:name ?n ; schema:isPartOf <https://en.wikipedia.org/> ; schema:about ?item . ?item wdt:${tprop} ?tid . }`);
        const rank = new Map(names.map((n, i) => [n, i]));
        rows.sort((a, b) => (rank.get(a.n?.value) ?? 99) - (rank.get(b.n?.value) ?? 99)).forEach((x) => add(x.tid?.value));
      }
    }
  } catch { /* Wikipedia is a bonus */ }
  // 2. same genre (and, for the same kind, same language), and the same director / composer
  try {
    const rows = target === kind
      ? await sparql(`SELECT ?tid WHERE {
      ?seed wdt:${prop} "${seedId}" ; wdt:P364 ?lang ; wdt:P136 ?g .
      ?item wdt:P364 ?lang ; wdt:P136 ?g ; wdt:${tprop} ?tid ; wikibase:sitelinks ?sl .
    } ORDER BY DESC(?sl) LIMIT 40`, 9_000)
      : await sparql(`SELECT ?tid WHERE {
      ?seed wdt:${prop} "${seedId}" ; wdt:P136 ?g ; wdt:P921 ?s .
      ?item wdt:P136 ?g ; wdt:P921 ?s ; wdt:${tprop} ?tid ; wikibase:sitelinks ?sl .
    } ORDER BY DESC(?sl) LIMIT 30`, 9_000);
    rows.forEach((x) => add(x.tid?.value));
  } catch { /* slow or unavailable: skip */ }
  try {
    const rows = await sparql(`SELECT ?tid WHERE {
      ?seed wdt:${prop} "${seedId}" . { ?seed wdt:P57 ?p } UNION { ?seed wdt:P86 ?p } UNION { ?seed wdt:P170 ?p }
      { ?item wdt:P57 ?p } UNION { ?item wdt:P86 ?p } UNION { ?item wdt:P170 ?p }
      ?item wdt:${tprop} ?tid .
    } LIMIT 40`, 9_000);
    rows.forEach((x) => add(x.tid?.value));
  } catch { /* skip */ }
  return out.slice(0, 60);
}
async function wikiCandidatesC(kind: string, seedId: number, target = kind): Promise<number[]> {
  const k = target === kind ? `wc:${kind}:${seedId}` : `wc:${kind}:${seedId}:${target}`;
  const hit = (await rawGet([k], RAW_DAYS.wd)).get(k);
  if (hit) return hit as number[];
  const ids = await wikiCandidates(kind, seedId, target);
  if (ids.length) await rawPut([{ k, v: ids }]);
  return ids;
}

// ---------- the crowd: what people ticked for this original ----------
type Vote = { yes: number; shown: number };
async function loadVotes(kind: string, seedId: number): Promise<Map<string, Vote>> {
  const out = new Map<string, Vote>();
  try {
    const { data } = await db.from("similar_votes").select("cand_key,yes,shown").eq("seed_key", `${kind}:${seedId}`).limit(200);
    for (const r of data || []) out.set(r.cand_key, { yes: Number(r.yes) || 0, shown: Number(r.shown) || 0 });
  } catch { /* table missing: no crowd signal */ }
  return out;
}
// only good news counts: 0 with no votes, up to 1 when most people who saw it ticked it (smoothed, so 1 of 1 is not 1.0)
const crowdOf = (v?: Vote) => (v && v.shown > 0 ? clamp(((v.yes + 0.2) / (v.shown + 5) - 0.05) / 0.35) : 0);

// movie and TV use different genre ids for the same idea (Action is 28 for films but 10759 "Action & Adventure" for series ...).
// One OR-group per genre of the original, translated to the other kind; genres the other kind has no word for are dropped.
const G_TV: Record<number, number[]> = { 28: [10759], 12: [10759], 878: [10765], 14: [10765], 10752: [10768], 27: [9648, 10765], 53: [9648, 80], 10749: [18], 36: [18], 16: [16], 35: [35], 80: [80], 99: [99], 18: [18], 10751: [10751], 9648: [9648], 37: [37] };
const G_MOVIE: Record<number, number[]> = { 10759: [28, 12], 10765: [878, 14], 10768: [10752], 10762: [10751], 10766: [10749], 16: [16], 35: [35], 80: [80], 99: [99], 18: [18], 10751: [10751], 9648: [9648], 37: [37] };
function xGenres(ids: number[], to: string): number[][] {
  const map = to === "tv" ? G_TV : G_MOVIE, seen = new Set<string>(), out: number[][] = [];
  for (const g of ids) { const m = map[g]; if (m && !seen.has(m.join())) { seen.add(m.join()); out.push(m); } }
  return out.slice(0, 2);
}

// ---------- build one list ----------
type Out = {
  id: number; media_type: string; title: string; poster_path: string | null; release_date: string; first_air_date: string;
  vote_average: number; features: Vec; pen: number; why: string[]; score: number; imdb?: number; rt?: number;
  tier: number; lang: string; // tier: 1 same language ... 4 the world
  mix?: boolean;              // a world-cinema pick added to an English list
  cross?: boolean;            // "the other kind": a series on a film's list, a film on a series' list
  pct?: number; strong?: boolean; best?: string[]; // match % over all angles, whether enough angles agree, and the best reasons
};
type Cand = { sug?: number; cross?: boolean; info: Info; raw?: any; rec?: number; sim?: number; trk?: number; disc?: boolean; co: number; mix?: boolean; wiki?: number };
type Row = { c: Cand; x: Vec; pen: number; tier: number; tp: number; gate: number; m?: Match }; // tp: the theme part of pen, gate: extra push-down for a title that is not a strong match, m: its match across all angles
type BuildOut = { list: Out[]; partial: boolean; gemDown?: boolean; grp: string; w: Vec; n: number; pattern?: string[]; dna?: string[]; debug?: Record<string, unknown> };
type CacheEntry = { grp: string; items: Out[]; pattern?: string[]; dna?: string[] };

function qualityOf(c: Info, r: Rating | null | undefined, regional: boolean): number {
  const parts: number[] = [];
  const conf = clamp(Math.log(Math.max(c.vote_count, 1)) / Math.log(regional ? 600 : 5000));
  parts.push(clamp((c.vote_average - 5) / 3.5) * (0.5 + 0.5 * conf));
  if (r?.imdb) parts.push(clamp((r.imdb - 5) / 3.5));
  if (r?.rt != null) parts.push(clamp((r.rt - 40) / 50));
  if (r?.meta != null) parts.push(clamp((r.meta - 40) / 50));
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}
// "Death Race 2", "Death Race: Inferno" and "Death Race" are one franchise
const baseTitle = (t: string) => t.toLowerCase().split(/[:\u2013\u2014]/)[0].replace(/\b(part\s*)?([0-9]+|ii|iii|iv|v|vi)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

type Part = "all" | "main" | "world" | "cross"; // "main" = the list itself, "world" = other languages, "cross" = series <-> films; each part is its own request (own CPU budget)
async function build(kind: string, seedId: number, probe = 0, lite = false, part: Part = "all", stop = 0): Promise<BuildOut> {
  // ?debug=1&stop=N: build only up to step N and say how long each step took and how much memory was in use (to find what a HTTP 546 kills)
  const t0 = Date.now(), trace: Record<string, unknown>[] = [];
  const mark = (label: string) => {
    let heap = 0, rss = 0; try { const m = Deno.memoryUsage(); heap = Math.round(m.heapUsed / 1048576); rss = Math.round(m.rss / 1048576); } catch { /* not available */ }
    trace.push({ step: label, ms: Date.now() - t0, heapMB: heap, rssMB: rss });
    console.log("[similar]", kind, seedId, label, Date.now() - t0, "ms heap", heap, "MB rss", rss, "MB");
  };
  const halt = (n: number, label: string): BuildOut | null => { mark(label); return stop === n ? { list: [], partial: false, grp: "en", w: {} as Vec, n: 0, debug: { trace } } : null; };
  const embX = new Map<number, number>(); // title id -> 0..1 meaning match (embed.ts), set in the second pass and read by the list filter; one per build
  const seed = (await infoMany(kind, [seedId]))[0];
  { const h = halt(1, "1 seed loaded (embedding model " + (embedOn() ? "ON" : "off") + ")"); if (h) return h; }
  if (!seed) throw new Error("title not found");
  const grp = groupOf(seed.lang);
  const { w, n: wn } = await loadWeights(grp);
  const today = new Date().toISOString().slice(0, 10);
  const english = seed.lang === "en" || !seed.lang;
  const minVotes = english ? (kind === "tv" ? 100 : 200) : 25; // regional films have far fewer votes on TMDB
  const gTop = seed.genres.slice(0, 2).map(([i]) => i);       // the main genres
  const seedG = new Set(seed.genres.map(([i]) => i));
  const kwNames = (i: Info) => i.kws.map(([, k]) => k);
  let seedTh = themeProfile(kwNames(seed), seed.text);
  const seedDark = darkness(seed.genres.map(([g]) => g), seed.kws.map(([, k]) => k), seed.text, seed.mat);

  // 1. candidates: TMDB's own lists, then what the related titles recommend in turn (every list is saved, see tmdbList)
  const find = (p: string, params: Record<string, string> = {}) => tmdbList(p, params).catch(() => [] as any[]);
  const kwIds = seed.kws.filter(([, k]) => !STOP.has(k)).slice(0, 5).map(([i]) => i);
  const dBase = { sort_by: "vote_count.desc", "vote_count.gte": String(minVotes), include_adult: "false", ...(seed.lang ? { with_original_language: seed.lang } : {}) };
  const [recs, sims, byKw, trk] = await Promise.all([
    find(`/${kind}/${seedId}/recommendations`),
    find(`/${kind}/${seedId}/similar`),
    kwIds.length ? find(`/discover/${kind}`, { ...dBase, with_keywords: kwIds.join("|") }) : Promise.resolve([] as any[]),
    traktC(kind, seed.imdb).catch(() => [] as number[]),
  ]);
  // the original's core themes (theme.ts) -> TMDB keyword ids -> films about the same SUBJECT, best rated first (not only the most voted)
  const coreKw = coreThemes(seedTh).map((t) => themeKeywordIds(seed.kws, t)).filter((a) => a.length);
  const byTheme = (await Promise.all([
    ...coreKw.flatMap((ids) => [
      find(`/discover/${kind}`, { ...dBase, with_keywords: ids.join("|"), sort_by: "vote_average.desc", "vote_count.gte": String(minVotes * 2) }),
      find(`/discover/${kind}`, { ...dBase, with_keywords: ids.join("|") }),
    ]),
    ...(coreKw.length > 1 ? [find(`/discover/${kind}`, { ...dBase, with_keywords: coreKw.map((a) => a[0]).join(",") })] : []),
  ])).flat();
  const wk = await wikiCandidatesC(kind, seedId).catch(() => [] as number[]);
  const votes = await loadVotes(kind, seedId);
  { const h = halt(2, "2 candidate lists, Wikipedia, votes"); if (h) return h; }
  const cands = new Map<number, Cand>();
  const touch = (id: number, raw?: any) => { let c = cands.get(id); if (!c) { c = { info: null as unknown as Info, co: 0 }; cands.set(id, c); } if (raw && !c.raw) c.raw = raw; return c; };
  recs.slice(0, 20).forEach((r, i) => { touch(r.id, r).rec = i; });
  sims.slice(0, 20).forEach((r, i) => { touch(r.id, r).sim = i; });
  trk.slice(0, 20).forEach((id, i) => { touch(id).trk = i; });
  // titles people of this app ticked for this original (2 or more times) join the pool even if no source suggested them now
  for (const [k, v] of votes) { const [kd, idStr] = k.split(":"); if (kd === kind && v.yes >= 2) touch(Number(idStr)); }
  wk.forEach((id, i) => { touch(id).wiki = i; }); // Wikipedia "more like this" and Wikidata (same language + genre, same crew)
  byKw.slice(0, 20).forEach((r) => { touch(r.id, r).disc = true; });
  byTheme.slice(0, 120).forEach((r) => { touch(r.id, r).disc = true; });
  const hdbg: Record<string, unknown> = {};
  const seedH0 = heartOn() ? (await heartsOf([{ kind, info: seed, text: seed.text }], hdbg)).get(heartKey(kind, seedId)) : undefined;
  if (part === "all" || part === "main") (await heartPicks(kind, seed, seedH0, "any", find, hdbg)).forEach((r, i) => { touch(r.id, r).sug = i; });
  cands.delete(seedId);
  // "fans of the related titles also watch": the titles TMDB links to this one are asked for their own recommendations
  const sameLang = (r: any) => english || !r.original_language || r.original_language === seed.lang;
  const near = [...recs.slice(0, 10).filter(sameLang), ...sims.slice(0, 5).filter(sameLang)].map((r) => r.id);
  const nb = [...new Set(near.length ? near : [...recs.slice(0, 8), ...sims.slice(0, 4)].map((r) => r.id))].filter((id) => id !== seedId).slice(0, 12);
  const nbLists = await pool(nb, 6, (id) => find(`/${kind}/${id}/recommendations`));
  { const h = halt(3, "3 neighbour lists"); if (h) return h; }
  for (const l of nbLists) for (const r of (l || []).slice(0, 15)) { if (r.id === seedId) continue; touch(r.id, r).co++; }

  // 2. cheap pruning on what the lists already say: released, poster, enough votes, not a documentary
  const rawOk = (c: Cand) => {
    const r = c.raw; if (!r) return true;
    const d = r.release_date || r.first_air_date || "";
    return d && d <= today && !r.adult && r.poster_path && (r.vote_count || 0) >= minVotes && !(r.genre_ids || []).includes(99);
  };
  const preList = () => [...cands.entries()].filter(([id, c]) => id !== seedId && rawOk(c));
  let pre = preList();
  // a language other than English: also its best titles in the same main genres, by popularity and by rating
  if (!english && gTop.length) {
    const g = (await Promise.all([
      find(`/discover/${kind}`, { ...dBase, with_genres: gTop.join(",") }),
      find(`/discover/${kind}`, { ...dBase, with_genres: String(gTop[0]) }),
      find(`/discover/${kind}`, { ...dBase, with_genres: gTop.join(","), sort_by: "vote_average.desc", "vote_count.gte": String(minVotes * 2) }),
      // popular and recent ones: the lists above are ranked by votes, which leaves newer titles (a 2025 release) out of the top 20
      find(`/discover/${kind}`, { ...dBase, with_genres: gTop.join(","), sort_by: "popularity.desc" }),
      find(`/discover/${kind}`, { ...dBase, with_genres: String(gTop[0]), sort_by: "popularity.desc" }),
      find(`/discover/${kind}`, { ...dBase, with_genres: gTop.join(","), sort_by: "popularity.desc", [kind === "tv" ? "first_air_date.gte" : "primary_release_date.gte"]: (new Date().getFullYear() - 5) + "-01-01" }),
      find(`/discover/${kind}`, { ...dBase, with_genres: gTop.join(","), page: "2" }),
    ])).flat();
    g.slice(0, 120).forEach((r) => { touch(r.id, r).disc = true; });
    pre = preList();
  }
  // the closest language and the best-ranked first; farther languages only after them
  const langPen = (c: Cand) => (c.raw?.original_language ? [0, 0, 6, 12, 18][tierOf(seed.lang, c.raw.original_language)] : 0);
  const priority = (c: Cand) => Math.min(c.rec ?? 99, c.sim ?? 99, c.trk ?? 99, c.wiki !== undefined ? Math.min(c.wiki, 30) : 99, c.disc ? 40 : 99, c.sug !== undefined ? c.sug : 99) - c.co * 4 + langPen(c);
  const byPriority = (a: [number, Cand], b: [number, Cand]) => priority(a[1]) - priority(b[1]);
  pre.sort(byPriority);
  pre = pre.slice(0, lite ? LITE_DETAILS : MAX_DETAILS);

  // 3. details for the rest (saved ones come from the database)
  const got = await infoMany(kind, pre.map(([id]) => id));
  { const h = halt(4, "4 details of " + pre.length + " titles"); if (h) return h; }
  const all: Cand[] = [];
  pre.forEach(([, c], i) => { const g = got[i]; if (g) { c.info = g; all.push(c); } });

  // 4. hard filters on the full details 
  const passes = (c: Cand, mv = minVotes) => {
    const i = c.info, d = i.release_date || i.first_air_date;
    return !!d && d <= today && !i.adult && !!i.poster_path && i.vote_count >= mv && !!i.title && !i.genres.some(([g]) => g === 99) &&
      !(seed.collection && i.collection === seed.collection) && baseTitle(i.title) !== baseTitle(seed.title);
  };
  const list = all.filter(passes);
  if (!list.length) return { list: [], partial: false, grp, w, n: wn };

  // 5. first pass: every title gets its numbers (story from the TMDB summary only, plus Wikidata tags, tone, crew ...)
  const seedC = new Set(seed.cast.map(([i]) => i));
  const idsOf = (p: Pair[]) => p.map(([i]) => i);
  const seedCrew = { d: idsOf(seed.crew.d), w: idsOf(seed.crew.w), m: idsOf(seed.crew.m) };
  const seedAnim = seedG.has(16), seedFam = seedG.has(10751);
  const seedPeople: People = { ...seedCrew, p: idsOf(seed.crew.p) };
  const peopleOf = (i: Info): People => ({ d: idsOf(i.crew.d), w: idsOf(i.crew.w), m: idsOf(i.crew.m), p: idsOf(i.crew.p) });
  const neutral = (v: number) => (v < 0 ? 0.4 : v);
  // all angles of one title: fills the five feel angles, then the match % and the strong-match test. A title that is not a strong match is pushed down (gate).
  const judge = (r: Row, ang: Record<Angle, number>, th: ThemeMatch) => {
    r.x.mood = neutral(ang.mood); r.x.pace = neutral(ang.pace); r.x.look = neutral(ang.look); r.x.form = neutral(ang.form); r.x.feel = neutral(ang.feel);
    const shared = r.c.info.cast.filter(([p]) => seedC.has(p)).length;
    r.m = matchOf({ theme: r.x.theme, story: r.x.story, core: r.x.core, kw: r.x.kw, hasTheme: th.has, heart: !!th.heart }, ang, craftMatch(seedPeople, peopleOf(r.c.info), shared));
    r.gate = r.m.gate; // 0 strong, 0.35 cannot be judged / half agree, 0.9 clear disagreement (see profile.ts)
  };
  const gIdsOf = (i: Info) => i.genres.map(([g]) => g);
  let seedDna: Dna = dna(seed.text, seed.runtime, gIdsOf(seed));
  let seedExtra: Extra | undefined;
  let seedHeart: Heart | undefined;
  const heartById = new Map<number, Heart>();
  const scoreRows = async (cs: Cand[], ck: string = kind): Promise<Row[]> => { // ck: the kind of the candidates (the other kind for the cross section)
    // rare keywords count more: weight = ln((N + 1) / df) over this pool
    const N = cs.length + 1;
    const df = new Map<number, number>();
    for (const c of cs) for (const [k] of c.info.kws) df.set(k, (df.get(k) || 0) + 1);
    for (const [k] of seed.kws) df.set(k, (df.get(k) || 0) + 1);
    const idf = (k: number) => Math.log((N + 1) / Math.max(df.get(k) || 1, 1));
    const seedUseful = seed.kws.filter(([, k]) => !STOP.has(k));
    const seedIdfSum = seedUseful.reduce((s, [k]) => s + idf(k), 0);
    const seedK = new Set(seedUseful.map(([i]) => i));
    const story1 = storyX(storyScores(seed.text, cs.map((c) => c.info.text)).map((x) => x.score));
    let wdS = new Map<number, Tags>(), wdC = new Map<number, Tags>(); // the original's tags, and the candidates' (two maps: a movie and a series can share an id)
    try {
      if (ck === kind) { wdC = await wikidataC(kind, [seedId, ...cs.map((c) => c.info.id)]); wdS = wdC; }
      else { wdS = await wikidataC(kind, [seedId]); wdC = await wikidataC(ck, cs.map((c) => c.info.id)); }
    } catch { /* Wikidata is a bonus */ }
    const seedTags = wdS.get(seedId);
    const seedTagSum = seedTags ? [...seedTags.values()].reduce((a, b) => a + b, 0) : 0;
    return cs.map((c, idx) => {
      const i = c.info;
      const sharedK = i.kws.filter(([k]) => seedK.has(k));
      const kwMass = sharedK.reduce((s, [k]) => s + idf(k), 0);
      const cast = i.cast.filter(([p]) => seedC.has(p));
      // genre: the two main genres of the original count double
      const gIds = new Set(i.genres.map(([g]) => g));
      let gShared = 0, gTotal = 0;
      for (const [g] of seed.genres) { const wt = gTop.includes(g) ? 1.5 : 1; gTotal += wt; if (gIds.has(g)) gShared += wt; }
      for (const [g] of i.genres) if (!seedG.has(g)) gTotal += 0.25; // genres the original does not have dilute the match a little
      const rank = (v: number | undefined) => (v === undefined ? 0 : clamp(1 - v / 20));
      const nSrc = [c.rec !== undefined, c.sim !== undefined, c.trk !== undefined, !!c.disc, c.co > 0, c.wiki !== undefined].filter(Boolean).length;
      const tags = wdC.get(i.id);
      let tagMass = 0;
      if (seedTags && tags) for (const [t, wt] of seedTags) if (tags.has(t)) tagMass += wt;
      const tier = tierOf(seed.lang, i.lang);
      const tm = toneMatch(seedDark, darkness(i.genres.map(([g]) => g), i.kws.map(([, k]) => k), i.text, i.mat));
      // penalties: language tier, no main genre in common, animation vs live action, family vs adult, a clash of tone
      let pen = c.mix ? WORLD.pen : TIER_PEN[tier];
      if (seed.genres.length && !seed.genres.some(([g]) => gIds.has(g))) pen += 1.0; // no genre at all in common (a shared side genre is enough)
      if (gIds.has(16) !== seedAnim) pen += 2;
      if (gIds.has(10751) && !seedFam) pen += 1;
      const th = themeMatch(seedTh, themeProfile(kwNames(i), i.text));
      const tp = themePen(th);
      pen = Math.min(pen + tm.pen + tp, 7);
      const x: Vec = {
        kw: seedIdfSum > 0 ? clamp(kwMass / (0.25 * seedIdfSum)) : 0, // a couple of rare shared subjects (alien invasion, navy ...) give full credit
        story: story1[idx],
        cast: clamp(cast.length / 2),
        dir: crewMatch(seedCrew, { d: idsOf(i.crew.d), w: idsOf(i.crew.w), m: idsOf(i.crew.m) }),
        genre: gTotal ? gShared / gTotal : 0,
        tone: 0.7 * tm.x + 0.3 * maturityMatch(seed.mat, i.mat),
        rec: rank(c.rec), sim: rank(c.sim), trk: rank(c.trk),
        co: clamp(c.co / 4),
        agree: clamp((nSrc - 1) / 2),
        wd: seedTagSum > 0 ? clamp(tagMass / Math.min(seedTagSum, 4)) : 0,
        quality: qualityOf(i, null, !english),
        era: 1 - Math.min(Math.abs(yearOf(i) - yearOf(seed)), 40) / 40,
        lang: TIER_LANG_X[tier],
        vibe: 0, recep: 0, // filled in the second pass, for the titles that get read more closely
        crowd: crowdOf(votes.get(`${ck}:${i.id}`)),
        theme: th.has ? th.theme : 0.4, core: th.has ? th.core : 0.4, // no clear theme in the original: a neutral value for everyone
        mood: 0.4, pace: 0.4, look: 0.4, form: 0.4, feel: 0.4, // filled in the second pass (profile.ts); neutral until then
      };
      return { c, x, pen, tier, tp, gate: 0 };
    });
  };
  let rows = await scoreRows(list);
  { const h = halt(5, "5 first pass scored " + rows.length); if (h) return h; }
  const zr = (r: Row) => zOf(w, r.x, r.pen + r.gate);
  const score = (r: Row) => sigmoid(zr(r));
  rows.sort((a, b) => zr(b) - zr(a));

  // 5b. too few GOOD titles in the language (fewer than POOL.enough scoring POOL.good or more): keep those, and look in the
  //     neighbouring languages (Malayalam -> Tamil, Telugu, Kannada) and worldwide as well. They are scored like the rest.
  if (rows.filter((r) => r.tier === 1 && score(r) >= POOL.good).length < POOL.enough) {
    const base = { include_adult: "false", sort_by: "vote_average.desc" };
    const genres: Record<string, string> = gTop.length ? { with_genres: gTop.join(",") } : {};
    const jobs = neighbours(seed.lang).slice(0, 4).map((L) => find(`/discover/${kind}`, { ...base, "vote_count.gte": "40", with_original_language: L, ...genres }));
    // the rest of India (Hindi -> Malayalam, Tamil, Telugu, Kannada; Malayalam -> Hindi, Bengali ...): not next-door, but the same country
    if (INDIA.includes(seed.lang)) {
      const nbs = neighbours(seed.lang);
      INDIA.filter((L) => L !== seed.lang && !nbs.includes(L)).slice(0, 4).forEach((L) =>
        jobs.push(find(`/discover/${kind}`, { ...base, "vote_count.gte": "40", with_original_language: L, ...(gTop.length ? { with_genres: String(gTop[0]) } : {}) })));
    }
    jobs.push(find(`/discover/${kind}`, { ...base, "vote_count.gte": "1500", ...genres }));
    if (kwIds.length) jobs.push(find(`/discover/${kind}`, { ...base, "vote_count.gte": "800", with_keywords: kwIds.join("|") }));
    (await Promise.all(jobs)).flat().forEach((r) => { touch(r.id, r).disc = true; });
    const have = new Set(list.map((c) => c.info.id));
    const more = preList().filter(([id, c]) => !have.has(id) && !c.info).sort(byPriority).slice(0, 60);
    const gotMore = await infoMany(kind, more.map(([id]) => id));
    more.forEach(([, c], i) => { const g = gotMore[i]; if (g) { c.info = g; if (passes(c)) list.push(c); } });
    rows = await scoreRows(list);
    rows.sort((a, b) => zr(b) - zr(a));
  }

  { const h = halt(6, "6 after filling from other languages (5b), " + rows.length + " rows"); if (h) return h; }
  // 5c. "Similar taste from world cinema": strong matches in OTHER languages (WORLD in logic.ts), for every title. Scored with a small fixed
  //     penalty instead of the language penalty, the best ones read more closely (Wikipedia + reviews), then they must pass their own checks.
  let mixRows: Row[] = [];
  const dbg: Record<string, unknown> = { seedLang: seed.lang, genres: gTop };
  if (gTop.length && (part === "all" || part === "world")) {
    try {
      const base = { include_adult: "false", sort_by: "vote_average.desc", "vote_count.gte": kind === "tv" ? "300" : "600", "vote_average.gte": String(WORLD.minRating) };
      const langs = WORLD.langs.filter((L) => L !== seed.lang);
      const look = async (genres: string) => (await Promise.all(langs.map((L) =>
        find(`/discover/${kind}`, { ...base, with_genres: genres, with_original_language: L }).then((l) => l.slice(0, WORLD.perLang)),
      ))).flat();
      const lookKw = async () => (!coreKw.length ? [] : (await Promise.all(langs.map((L) =>
        find(`/discover/${kind}`, { ...base, with_keywords: coreKw[0].join("|"), with_original_language: L }).then((l) => l.slice(0, WORLD.perLang)),
      ))).flat());
      let found = (await look(gTop.join(","))).concat(await lookKw());
      dbg.foundBoth = found.length;
      if (found.length < 6 && gTop.length > 1) found = found.concat(await look(String(gTop[0])));
      dbg.found = found.length;
      if (heartOn()) found = (await heartPicks(kind, seed, seedH0, "world", find, hdbg)).concat(found);
      const ids = [...new Set(found.filter((r) => r.poster_path && r.id !== seedId).map((r) => r.id as number))].slice(0, 60);
      const infos = await infoMany(kind, ids);
      dbg.ids = ids.length; dbg.infos = infos.filter(Boolean).length;
      const mc: Cand[] = [];
      infos.forEach((g) => { if (g) { const c: Cand = { info: g, co: 0, mix: true, disc: true }; if (passes(c)) mc.push(c); } });
      dbg.passed = mc.length;
      if (mc.length) {
        mixRows = await scoreRows(mc);
        mixRows.sort((a, b) => zr(b) - zr(a));
        const mtop = mixRows.slice(0, 20);
        try {
          const extra = await enrich(kind, [seedId, ...mtop.map((r) => r.c.info.id)]);
          const seedX = extra.get(seedId);
          const s2 = storyX(storyScores(seed.text + " " + (seedX?.text || ""), mtop.map((r) => r.c.info.text + " " + (extra.get(r.c.info.id)?.text || ""))).map((x) => x.score));
          const v2 = vibeX(aspectVec(seed.text + " " + (seedX?.feel || "")), mtop.map((r) => aspectVec(r.c.info.text + " " + (extra.get(r.c.info.id)?.feel || ""))));
          const sd = dna(seed.text + " " + (seedX?.feel || ""), seed.runtime, gIdsOf(seed));
          const angs = matchAngles(sd, mtop.map((r) => dna(r.c.info.text + " " + (extra.get(r.c.info.id)?.feel || ""), r.c.info.runtime, gIdsOf(r.c.info))));
          const hs = await heartScores({ kind, info: seed, text: seed.text + " " + (seedX?.text || "") }, mtop.map((r) => ({ kind, info: r.c.info, text: r.c.info.text + " " + (extra.get(r.c.info.id)?.text || "") })), dbg);
          seedHeart = hs.seed || seedHeart; hs.scores.forEach((v, id) => heartById.set(id, v.h));
          mtop.forEach((r, k) => {
            r.x.story = s2[k]; r.x.vibe = v2[k]; r.x.recep = receptionOf(extra.get(r.c.info.id));
            const th = withHeart(themeMatch(seedTh, themeProfile(kwNames(r.c.info), r.c.info.text + " " + (extra.get(r.c.info.id)?.text || ""))), hs.scores.get(r.c.info.id));
            const tp = themePen(th); r.pen = Math.min(7, r.pen - r.tp + tp); r.tp = tp;
            r.x.theme = th.has ? th.theme : 1; r.x.core = th.has ? th.core : 1;
            judge(r, angs[k], th);
          });
        } catch { /* keep the first-pass values */ }
        mixRows = mtop;
      }
    } catch (e) { dbg.error = String((e as Error)?.message || e); /* world cinema is a bonus */ }
  } else dbg.error = gTop.length ? "world part skipped" : "original has no genres";

  // 6. second pass: read the best ones more closely (Wikipedia plot / themes / reception + TMDB user reviews)
  const sideOnly = part === "world" || part === "cross"; // these parts only need the main list roughly (to leave out what it already shows)
  const top = rows.slice(0, sideOnly ? 8 : lite ? LITE_ENRICH : ENRICH_TOP);
  // films Gemini suggested for their heart always get the close reading, even when the quick first pass ranked them low (it only sees keywords)
  if (!sideOnly) for (const r of rows.slice(top.length)) if (r.c.sug !== undefined && top.length < ENRICH_TOP + 20) top.push(r);
  try {
    const extra = await enrich(kind, [seedId, ...top.map((r) => r.c.info.id)]);
    { const h = halt(7, "7 Wikipedia + reviews read for " + top.length); if (h) return h; }
    const seedX = extra.get(seedId);
    seedExtra = seedX;
    seedDna = dna(seed.text + " " + (seedX?.feel || ""), seed.runtime, gIdsOf(seed));
    const angs = matchAngles(seedDna, top.map((r) => dna(r.c.info.text + " " + (extra.get(r.c.info.id)?.feel || ""), r.c.info.runtime, gIdsOf(r.c.info))));
    const seedDoc = seed.text + " " + (seedX?.text || "");
    let s2 = storyX(storyScores(seedDoc, top.map((r) => r.c.info.text + " " + (extra.get(r.c.info.id)?.text || ""))).map((x) => x.score));
    { const h = halt(10, "10 plot-word match (TF-IDF) done"); if (h) return h; }
    try { // meaning: the embedding match counts more than shared words (a quiet drama and a playful romcom share words, not meaning)
      const ms = await meaningScores(kind, seed, seedX?.text || "", top.slice(0, 40).map((r) => ({ info: r.c.info, plot: extra.get(r.c.info.id)?.text || "" })));
      if (ms) s2 = s2.map((v, k) => { if (ms[k] === undefined || ms[k] < 0) return v; const e = embedX(ms[k]); embX.set(top[k].c.info.id, e); return 0.35 * v + 0.65 * e; });
    } catch { /* the old story score stays */ }
    { const h = halt(11, "11 meaning match (embeddings) done"); if (h) return h; }
    // vibe: does it FEEL the same to the people who wrote about it (reviews + Wikipedia reception)?
    const v2 = vibeX(aspectVec(seed.text + " " + (seedX?.feel || "")), top.map((r) => aspectVec(r.c.info.text + " " + (extra.get(r.c.info.id)?.feel || ""))));
    { const h = halt(12, "12 review-feel match done"); if (h) return h; }
    seedTh = themeProfile(kwNames(seed), seedDoc); // the same themes, now also read from the Wikipedia plot
    const hs = await heartScores({ kind, info: seed, text: seedDoc }, top.map((r) => ({ kind, info: r.c.info, text: r.c.info.text + " " + (extra.get(r.c.info.id)?.text || "") })), dbg);
    seedHeart = hs.seed || seedHeart; hs.scores.forEach((v, id) => heartById.set(id, v.h));
    top.forEach((r, k) => {
      r.x.story = s2[k]; r.x.vibe = v2[k]; r.x.recep = receptionOf(extra.get(r.c.info.id));
      const th = withHeart(themeMatch(seedTh, themeProfile(kwNames(r.c.info), r.c.info.text + " " + (extra.get(r.c.info.id)?.text || ""))), hs.scores.get(r.c.info.id));
      const tp = themePen(th);
      r.pen = Math.min(7, r.pen - r.tp + tp); r.tp = tp;
      r.x.theme = th.has ? th.theme : 0.4; r.x.core = th.has ? th.core : 0.4;
      judge(r, angs[k], th);
    });
  } catch { /* keep the first-pass story values */ }
  { const h = halt(8, "8 second pass scored"); if (h) return h; }
  top.sort((a, b) => zr(b) - zr(a));

  // 7. IMDb / Rotten Tomatoes for the best ones, then the final order
  const { map: rat, partial } = await ratings(top.slice(0, sideOnly ? 0 : OMDB_TOP).map((r) => r.c.info.imdb));
  { const h = halt(9, "9 IMDb / RT ratings"); if (h) return h; }
  for (const r of top) r.x.quality = qualityOf(r.c.info, rat.get(r.c.info.imdb), !english);
  top.sort((a, b) => zr(b) - zr(a));

  // 8. one title per franchise, then the pool: the language first, the next tiers only to fill (see selectPool in logic.ts)
  const seen = new Set<string>();
  const uniq: Row[] = [];
  for (const r of top) {
    const i = r.c.info;
    const g = i.collection ? "c" + i.collection : "t:" + baseTitle(i.title);
    if (seen.has(g)) continue;
    seen.add(g);
    uniq.push(r);
  }
  const chosen = selectPool(uniq.filter((r) => !r.m || (r.m.pct >= 40 && (r.m.strong || !embX.has(r.c.info.id) || (embX.get(r.c.info.id) || 0) >= 0.4))).map((r) => ({ r, tier: r.tier, score: score(r) })), RESULTS).map((s) => s.r);
  // films Gemini suggested for the same heart: it picked them for the emotional match, which the keyword/plot angles under-rate.
  // They get a lower bar (SUG_MIN_PCT) and skip the strong test and the score floor; at most SUG_MAX are added after the normal list.
  { const SUG_MIN_PCT = 28, SUG_MAX = 8;
    uniq.filter((r) => r.c.sug !== undefined && !chosen.includes(r) && r.m && r.m.pct >= SUG_MIN_PCT)
      .sort((a, b) => score(b) - score(a)).slice(0, SUG_MAX).forEach((r) => chosen.push(r)); }
  // the world-cinema section: strong matches in other languages (max WORLD.max, one per franchise, none already in the list)
  const inList = new Set(chosen.map((r) => r.c.info.id));
  const worldPicks = pickWorld(mixRows.filter((r) => !inList.has(r.c.info.id) && !seen.has(r.c.info.collection ? "c" + r.c.info.collection : "t:" + baseTitle(r.c.info.title)))
    .map((r) => ({ r, score: score(r), pen: r.pen + r.gate, strong: r.m ? r.m.strong : undefined, genre: r.x.genre, tone: r.x.tone, rating: r.c.info.vote_average, story: r.x.story, vibe: r.x.vibe, kw: r.x.kw, theme: r.x.theme, core: r.x.core, pct: r.m?.pct }))).map((m) => m.r);
  chosen.push(...worldPicks);

  // 5e. THE OTHER KIND: a film's list also gets series, a series' list gets films. Found by the original's rare keywords, its core themes, its genres
  //     (translated to the other kind's genre ids), its language and Wikipedia "more like this"; read like the rest (Wikipedia + reviews) and they must
  //     pass the same strong-match test (enough angles agree) and a score floor. At most CROSS_MAX, one per franchise.
  const other = kind === "tv" ? "movie" : "tv";
  let crossPicks: Row[] = [];
  if (part === "all" || part === "cross") try {
    const oMin = english ? (other === "tv" ? 100 : 200) : 25;
    const lang: Record<string, string> = seed.lang ? { with_original_language: seed.lang } : {};
    const dOther = (extra: Record<string, string>) => find(`/discover/${other}`, { include_adult: "false", "vote_count.gte": String(oMin), sort_by: "vote_count.desc", ...extra });
    const jobs: Promise<any[]>[] = [];
    const byRating = (extra: Record<string, string>, mult: number) => dOther({ sort_by: "vote_average.desc", "vote_count.gte": String(oMin * mult), ...extra });
    if (kwIds.length) { jobs.push(byRating({ ...lang, with_keywords: kwIds.join("|") }, 2)); jobs.push(byRating({ with_keywords: kwIds.join("|") }, 4)); }
    for (const ids of coreKw) { jobs.push(byRating({ ...lang, with_keywords: ids.join("|") }, 2)); jobs.push(byRating({ with_keywords: ids.join("|") }, 4)); }
    for (const g of xGenres(seed.genres.map(([id]) => id), other)) {
      jobs.push(byRating({ ...lang, with_genres: g.join("|") }, 2));
      jobs.push(dOther({ ...lang, with_genres: g.join("|"), sort_by: "popularity.desc" }));
      jobs.push(byRating({ with_genres: g.join("|") }, 6));
    }
    const [lists, wkx] = await Promise.all([Promise.all(jobs), wikiCandidatesC(kind, seedId, other).catch(() => [] as number[])]);
    const cc = new Map<number, Cand>();
    for (const r of lists.flat()) if (r && r.id && !cc.has(r.id)) cc.set(r.id, { info: null as unknown as Info, raw: r, co: 0, disc: true });
    wkx.forEach((id, i) => { let c = cc.get(id); if (!c) { c = { info: null as unknown as Info, co: 0 }; cc.set(id, c); } c.wiki = i; });
    const plausible = ([, c]: [number, Cand]) => {
      const r = c.raw; if (!r) return true;
      const d = r.release_date || r.first_air_date || "";
      return !!d && d <= today && !r.adult && !!r.poster_path && (r.vote_count || 0) >= oMin && !(r.genre_ids || []).includes(99);
    };
    const pr = (c: Cand) => Math.min(c.wiki !== undefined ? Math.min(c.wiki, 30) : 99, 40) + langPen(c);
    const cand = [...cc.entries()].filter(plausible).sort((a, b) => pr(a[1]) - pr(b[1])).slice(0, 70);
    const infos = await infoMany(other, cand.map(([id]) => id));
    const mc: Cand[] = [];
    infos.forEach((g, k) => { if (g) { const c = cand[k][1]; c.info = g; c.cross = true; if (passes(c, oMin)) mc.push(c); } });
    dbg.crossCandidates = mc.length;
    if (mc.length) {
      const rowsX = await scoreRows(mc, other);
      rowsX.sort((a, b) => zr(b) - zr(a));
      const xt = rowsX.slice(0, 16);
      const extra = await enrich(other, xt.map((r) => r.c.info.id));
      const sx = seedExtra || (await enrich(kind, [seedId])).get(seedId);
      const txt = (r: Row) => r.c.info.text + " " + (extra.get(r.c.info.id)?.text || "");
      const s2 = storyX(storyScores(seed.text + " " + (sx?.text || ""), xt.map(txt)).map((x) => x.score));
      const v2 = vibeX(aspectVec(seed.text + " " + (sx?.feel || "")), xt.map((r) => aspectVec(r.c.info.text + " " + (extra.get(r.c.info.id)?.feel || ""))));
      const angs = matchAngles(seedDna, xt.map((r) => dna(r.c.info.text + " " + (extra.get(r.c.info.id)?.feel || ""), r.c.info.runtime, gIdsOf(r.c.info))));
      const hs = await heartScores({ kind, info: seed, text: seed.text + " " + (sx?.text || "") }, xt.map((r) => ({ kind: other, info: r.c.info, text: txt(r) })), dbg);
      seedHeart = hs.seed || seedHeart;
      xt.forEach((r, k) => {
        r.x.story = s2[k]; r.x.vibe = v2[k]; r.x.recep = receptionOf(extra.get(r.c.info.id));
        const th = withHeart(themeMatch(seedTh, themeProfile(kwNames(r.c.info), txt(r))), hs.scores.get(r.c.info.id));
        const tp = themePen(th); r.pen = Math.min(7, r.pen - r.tp + tp); r.tp = tp;
        r.x.theme = th.has ? th.theme : 0.4; r.x.core = th.has ? th.core : 0.4;
        judge(r, angs[k], th);
      });
      xt.sort((a, b) => zr(b) - zr(a));
      const seenX = new Set<string>();
      crossPicks = xt.filter((r) => r.m?.strong && score(r) >= CROSS_MIN).filter((r) => { const g = baseTitle(r.c.info.title); if (seenX.has(g)) return false; seenX.add(g); return true; }).slice(0, CROSS_MAX);
      dbg.crossScored = xt.map((r) => ({ t: r.c.info.title, pct: r.m?.pct, agree: r.m?.agree, known: r.m?.known, strong: r.m?.strong, score: +score(r).toFixed(2) }));
    }
  } catch (e) { dbg.crossError = String((e as Error)?.message || e); /* the other kind is a bonus */ }
  chosen.push(...crossPicks);
  // what connects them: themes, tone and language that most of the best matches share with the original (plain counting, no AI)
  const pattern: string[] = [];
  const top6 = chosen.filter((r) => !r.c.mix && !r.c.cross).slice(0, 6);
  if (top6.length >= 3) {
    if (seedHeart) pattern.push(...sharedHeartWords(seedHeart, top6.map((r) => heartById.get(r.c.info.id)).filter(Boolean) as Heart[]));
    pattern.push(...sharedThemes(seedTh, top6.map((r) => themeProfile(kwNames(r.c.info), r.c.info.text))));
    const dk = top6.map((r) => darkness(r.c.info.genres.map(([g]) => g), kwNames(r.c.info), r.c.info.text, r.c.info.mat));
    if (seedDark >= 0.55 && dk.filter((d) => d >= 0.5).length / dk.length >= 0.7) pattern.push("dark, intense tone");
    else if (seedDark <= 0.3 && dk.filter((d) => d <= 0.35).length / dk.length >= 0.7) pattern.push("light, warm tone");
    if (top6.filter((r) => r.c.info.lang === seed.lang).length / top6.length >= 0.7 && seed.lang) pattern.push(langName(seed.lang) + " cinema");
  }
  dbg.scored = mixRows.length; dbg.picked = worldPicks.length;
  dbg.rejected = mixRows.map((r) => ({ t: r.c.info.title, lang: r.c.info.lang, rating: r.c.info.vote_average, genre: +r.x.genre.toFixed(2), tone: +r.x.tone.toFixed(2), story: +r.x.story.toFixed(2), vibe: +r.x.vibe.toFixed(2), kw: +r.x.kw.toFixed(2), pen: +r.pen.toFixed(2), gate: +r.gate.toFixed(2), strong: r.m?.strong, pct: r.m?.pct, theme: +r.x.theme.toFixed(2), core: +r.x.core.toFixed(2) })).slice(0, 20);

  if (probe) { // ?debug=1&probe=<tmdb id>: what happened to one title
    const pr = rows.find((x) => x.c.info.id === probe);
    dbg.probe = {
      wasCandidate: cands.has(probe), detailed: all.some((c) => c.info.id === probe), passedFilters: list.some((c) => c.info.id === probe),
      scored: !!pr, inTop: top.some((x) => x.c.info.id === probe), inFinalList: chosen.some((x) => x.c.info.id === probe),
      ...(pr ? { tier: pr.tier, pen: +pr.pen.toFixed(2), score: +score(pr).toFixed(3), x: Object.fromEntries(FEATURES.map((f) => [f, +pr.x[f].toFixed(2)])) } : {}),
    };
  }
  const sel = part === "world" ? chosen.filter((r) => r.c.mix) : part === "cross" ? chosen.filter((r) => r.c.cross) : part === "main" ? chosen.filter((r) => !r.c.mix && !r.c.cross) : chosen;
  const result: Out[] = sel.map((r) => {
    const i = r.c.info, rt = rat.get(i.imdb);
    const why: string[] = [langName(i.lang) + (r.c.mix ? " · world cinema" : "") + (r.m ? " · " + r.m.pct + "% match" : "")]; // the app shows this line, then the reasons
    if (r.m && r.m.best.length) why.push(r.m.best.join(" · "));
    const pen = r.pen + r.gate; // the push-down for a title that is not a strong match is part of the penalty the app (and the learning) sees
    const x = Object.fromEntries(FEATURES.map((f) => [f, Math.round(r.x[f] * 1000) / 1000])) as Vec;
    return {
      id: i.id, media_type: r.c.cross ? other : kind, title: i.title, poster_path: i.poster_path, release_date: i.release_date, first_air_date: i.first_air_date,
      vote_average: i.vote_average, features: x, pen: Math.round(pen * 100) / 100, why, score: Math.round(sigmoid(zOf(w, x, pen)) * 1000) / 1000,
      tier: r.tier, lang: i.lang, ...(r.c.mix ? { mix: true } : {}), ...(r.c.cross ? { cross: true } : {}),
      ...(r.m ? { pct: r.m.pct, strong: r.m.strong, best: r.m.best } : {}),
      ...(rt?.imdb ? { imdb: rt.imdb } : {}), ...(rt?.rt != null ? { rt: rt.rt } : {}),
    };
  });
  const mainOut = result.filter((x) => !x.mix && !x.cross);
  dbg.strong = { main: mainOut.length, strong: mainOut.filter((x) => x.strong).length, top10: mainOut.slice(0, 10).filter((x) => x.strong).length, cross: result.filter((x) => x.cross).length };
  mark("done");
  dbg.sugRows = rows.filter((r) => r.c.sug !== undefined).map((r) => ({
    t: r.c.info.title, top: top.includes(r), inList: chosen.includes(r), pct: r.m?.pct, strong: r.m?.strong, gate: +r.gate.toFixed(2), pen: +r.pen.toFixed(2), score: +score(r).toFixed(2),
    theme: +r.x.theme.toFixed(2), core: +r.x.core.toFixed(2), story: +r.x.story.toFixed(2), vibe: +r.x.vibe.toFixed(2), genre: +r.x.genre.toFixed(2), tone: +r.x.tone.toFixed(2), kw: +r.x.kw.toFixed(2),
  }));
  dbg.heartTop = top.slice(0, 40).map((r) => { const h = heartById.get(r.c.info.id); return { t: r.c.info.title, pct: r.m?.pct, inList: chosen.includes(r), sug: r.c.sug !== undefined, theme: +r.x.theme.toFixed(2), core: +r.x.core.toFixed(2), rel: h?.rel, engine: h?.engine, ending: h?.ending }; });
  dbg.sugLost = [...cands.values()].filter((c) => c.sug !== undefined && !rows.some((r) => r.c === c)).map((c) => c.raw?.title || c.raw?.name || c.info?.title);
  dbg.heart = { on: heartOn(), seed: seedHeart || null, sug: hdbg };
  dbg.trace = trace;
  const gemDown = heartOn() && (!!hdbg.heartError || Object.keys(hdbg).some((k) => k.startsWith("sugError_"))); // Gemini was asked and could not answer (no credit, rate limit)
  return { list: result, partial, gemDown, grp, w, n: wn, pattern: pattern.slice(0, 5), dna: [...(seedHeart ? heartWords(seedHeart) : []), ...describe(seedDna)].slice(0, 5), debug: dbg };
}

// ---------- learning ----------
// one set of weights per language group, so Malayalam picks do not move the English weights
async function learn(kind: string, id: number, picked: string[], shown: string[]) {
  const base = `${CACHE_VERSION}:${kind}:${id}`;
  const { data: rowsC } = await db.from("similar_cache").select("seed_key,list").in("seed_key", [base, base + ":main", base + ":world2", base + ":cross"]);
  const entries = ((rowsC || []) as { seed_key: string; list: unknown }[]).map((r) => r.list as CacheEntry).filter((e) => e && Array.isArray(e.items));
  const entry = entries[0] as CacheEntry | undefined;
  const list = entries.flatMap((e) => e.items);
  const byKey = new Map(list.map((o) => [o.media_type + ":" + o.id, o]));
  const pick = new Set(picked.filter((k) => byKey.has(k)));
  if (!pick.size) return;
  try { // the crowd signal: how often each title was on screen and how often it was ticked (only titles of this list count)
    const onScreen = [...new Set([...picked, ...shown])].filter((k) => byKey.has(k));
    await db.rpc("similar_vote", { p_seed: `${kind}:${id}`, p_picked: [...pick], p_shown: onScreen });
  } catch { /* function missing: similar.sql not re-run */ }
  const grp = entry?.grp || "en";
  const { w, n } = await loadWeights(grp);
  const examples = [...new Set([...picked, ...shown])].filter((k) => byKey.has(k)).map((k) => ({ x: byKey.get(k)!.features, pen: byKey.get(k)!.pen || 0, y: pick.has(k) ? 1 : 0 }));
  for (const e of examples) {
    const g = (e.y - sigmoid(zOf(w, e.x, e.pen))) * (e.y ? 1 : NEG_WEIGHT);
    for (const f of FEATURES) w[f] += LR * SCALE * g * (e.x[f] || 0);
  }
  for (const f of FEATURES) { w[f] += REG * (BASE[f] - w[f]); w[f] = clamp(w[f], BASE[f] * 0.25, BASE[f] * 3); }
  const rounded = { ...Object.fromEntries(FEATURES.map((f) => [f, Math.round(w[f] * 10000) / 10000])), v: WEIGHTS_VERSION };
  await db.from("similar_weights_g").upsert({ grp, w: rounded, n: n + 1, updated_at: new Date().toISOString() });
}

// ---------- title details for the app's small popup (GET ?details=1&type=movie|tv&id=603) ----------
// Three sources, each only asked for what the one before could not give:
//   1. TMDB      summary, language, production companies, director (series: creators), top-billed cast
//   2. Wikidata  director / cast / production company, when TMDB has none (free, no quota). Cast: also when TMDB lists fewer than MIN_CAST names
//   3. OMDb      director / actors / production / full plot, only if still missing (counted in the daily quota). Cast: same rule as Wikidata
// A short TMDB summary is lengthened with the set-up of the Wikipedia plot (the first lines only, not the ending).
// The answer is saved for 30 days in similar_cache (key "details:v3:..."), so each title is looked up once for everyone.
const DETAILS_DAYS = 30;
const MIN_CAST = 7; // the popup shows 6 names and a + for the rest: a title with fewer than 7 known names is topped up from Wikidata / OMDb
type Details = { plot: string; lang: string; directors: string[]; studios: string[]; cast: string[]; dirLabel: string };
const cut = (s: string, max: number) => { // shorten at the end of a sentence
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max), i = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return i > max * 0.5 ? head.slice(0, i + 1) : head.replace(/\s+\S*$/, "") + "…";
};
const uniq = (a: string[]) => [...new Set(a.map((x) => x.trim()).filter(Boolean))];
// Several name lists in one, first list first, each person once ("Zoë Saldaña" and "Zoe Saldana" are the same person)
const nameKey = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const mergeNames = (...lists: string[][]): string[] => {
  const seen = new Set<string>(), out: string[] = [];
  for (const l of lists) for (const n of l) { const k = nameKey(n); if (k && !seen.has(k)) { seen.add(k); out.push(n.trim()); } }
  return out.slice(0, 30);
};
const na = (s: unknown) => { const v = String(s ?? "").trim(); return !v || v === "N/A" ? "" : v; };

async function wikidataPeople(kind: string, id: number): Promise<{ directors: string[]; cast: string[]; studios: string[] }> {
  const prop = kind === "tv" ? "P4983" : "P4947";
  const q = `SELECT ?dL ?cL ?pL WHERE {
    ?item wdt:${prop} "${id}" .
    OPTIONAL { ?item wdt:${kind === "tv" ? "P170" : "P57"} ?d . ?d rdfs:label ?dL . FILTER(LANG(?dL) = "en") }
    OPTIONAL { ?item wdt:P161 ?c . ?c rdfs:label ?cL . FILTER(LANG(?cL) = "en") }
    OPTIONAL { ?item wdt:P272 ?p . ?p rdfs:label ?pL . FILTER(LANG(?pL) = "en") }
  } LIMIT 80`;
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), {
    headers: { Accept: "application/sparql-results+json", "User-Agent": UA }, signal: AbortSignal.timeout(4_000),
  });
  if (!r.ok) throw new Error("Wikidata " + r.status);
  const rows = (await r.json()).results?.bindings || [];
  const pick = (k: string) => uniq(rows.map((x: any) => x[k]?.value || ""));
  return { directors: pick("dL").slice(0, 2), cast: pick("cL").slice(0, 30), studios: pick("pL").slice(0, 2) };
}
// the first lines of the Wikipedia premise / plot: the set-up, not the ending
async function wikiSetup(kind: string, id: number): Promise<string> {
  const t = (await wikiTitles(kind, [id])).get(id);
  if (!t) return "";
  const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&redirects=1&format=json&titles=" + encodeURIComponent(t), {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(4_000),
  });
  if (!r.ok) return "";
  const ex = String((Object.values((await r.json()).query?.pages || {})[0] as any)?.extract || "");
  for (const n of ["Premise", "Plot", "Synopsis", "Storyline"]) {
    const m = ex.search(new RegExp("\\n" + n + "\\s*\\n", "i"));
    if (m >= 0) return cut(ex.slice(m + n.length + 2, m + n.length + 1600), 700);
  }
  return "";
}
async function omdbDetails(imdb: string): Promise<{ directors: string[]; cast: string[]; studios: string[]; plot: string } | null> {
  const key = Deno.env.get("OMDB_API_KEY");
  if (!key || !imdb || (await omdbReserve(1)) < 1) return null;
  const r = await fetch("https://www.omdbapi.com/?plot=full&apikey=" + encodeURIComponent(key) + "&i=" + encodeURIComponent(imdb), { signal: AbortSignal.timeout(8_000) });
  const j = await r.json().catch(() => ({} as any));
  if (/limit/i.test(String(j?.Error || ""))) { try { await db.rpc("omdb_block"); } catch { /* ignore */ } return null; }
  if (j?.Response !== "True") return null;
  const list = (s: unknown) => uniq(na(s).split(","));
  return { directors: list(j.Director).slice(0, 2), cast: list(j.Actors).slice(0, 30), studios: list(j.Production).slice(0, 2), plot: na(j.Plot) };
}

async function details(kind: string, id: number): Promise<Details | null> {
  const ckey = `details:v4:${kind}:${id}`; // v4: cast lists are topped up (older saved answers can hold only 3 or 4 names)
  try {
    const { data } = await db.from("similar_cache").select("list,built_at").eq("seed_key", ckey).maybeSingle();
    if (data && Date.now() - new Date(data.built_at).getTime() < DETAILS_DAYS * 864e5) return data.list as unknown as Details;
  } catch { /* table missing: look it up live */ }

  const r = await tmdb(`/${kind}/${id}`, { append_to_response: "credits,external_ids" });
  const names = (a: any[] | undefined, n: number) => uniq((a || []).map((x) => String(x?.name || ""))).slice(0, n);
  const crew: any[] = r.credits?.crew || [];
  let directors = kind === "tv" ? names(r.created_by, 2) : names(crew.filter((c) => c.job === "Director"), 2);
  if (!directors.length && kind === "tv") directors = names(crew.filter((c) => c.job === "Director"), 2);
  let studios = names(r.production_companies?.length ? r.production_companies : r.networks, 2);
  // the top-billed actors (30 at most) in billing order; the app shows 6 and a + for the rest (main roles first, then the supporting cast), real names not characters
  let cast = uniq(((r.credits?.cast || []) as any[]).slice(0, 30).map((p) => String(p.name || ""))).slice(0, 30);
  let plot = String(r.overview || r.tagline || "").trim();
  const imdb = String(r.external_ids?.imdb_id || r.imdb_id || "");

  // Fallbacks run side by side (not one after another) so the popup opens fast.
  const thinCast = cast.length < MIN_CAST;
  const needPeople = !directors.length || thinCast || !studios.length;
  const needOmdb = !directors.length || thinCast;
  const needPlot = plot.length < 400;
  const [w, o, setup] = await Promise.all([
    needPeople ? wikidataPeople(kind, id).catch(() => null) : null,
    needOmdb ? omdbDetails(imdb).catch(() => null) : null,
    needPlot ? wikiSetup(kind, id).catch(() => "") : "",
  ]);
  if (w) {
    if (!directors.length) directors = w.directors;
    if (!studios.length) studios = w.studios;
  }
  if (o) {
    if (!directors.length) directors = o.directors;
    if (!studios.length) studios = o.studios;
    if (plot.length < 40 && o.plot) plot = o.plot;
  }
  // TMDB's billing order first, then OMDb (also billing order), then Wikidata (no order): each name once
  if (thinCast) cast = mergeNames(cast, o?.cast || [], w?.cast || []);
  // a short summary gets the set-up of the Wikipedia plot after it
  if (setup && setup.length > 80 && plot.length < 400) plot = plot ? plot + "\n\n" + setup : setup;
  const out: Details = { plot: plot.slice(0, 1200), lang: String(r.original_language || ""), directors, studios, cast, dirLabel: kind === "tv" ? "Created by" : "Director" };
  if (out.plot || out.directors.length || out.cast.length || out.studios.length) {
    try { await db.from("similar_cache").upsert({ seed_key: ckey, list: out, built_at: new Date().toISOString() }); } catch { /* ignore */ }
  }
  return out;
}
const detailLimited = limiter(60, 60_000);
const personLimited = limiter(12, 60_000);
const availLimited = limiter(6, 60_000); // low on purpose: the similar-titles features need the Gemini quota first
const availFreshLimited = limiter(3, 60_000); // "Check again" (fresh=1) skips the saved answer, so it gets a tighter limit
// ---------- is it streaming now? Gemini with live search (GET ?avail=1&type=movie|tv&id=<TMDB id>[&fresh=1]) ----------
// A "yes" is saved 3 hours; a "not found" only 30 minutes (a title often reaches the streaming guides a few hours after it goes live, and a saved "no" must not hide that).
// fresh = true (the "Check again" button) ignores the saved answer.
const AVAIL_YES_MS = 3 * 3600e3, AVAIL_NO_MS = 30 * 60e3;
// Order of sources (v93): saved answer -> Watchmode -> Gemini search (LAST, because its credit runs out first).
// A Watchmode "found" is returned at once. An empty Watchmode answer still goes on to Gemini; if Gemini cannot answer (no credit, resting, busy),
// the empty Watchmode answer is saved as "not available" for 30 minutes, so neither API is hammered.
const reserveApi = async (api: string, period: string, n: number, cap: number): Promise<number> => {
  try { const { data, error } = await db.rpc("api_reserve", { p_api: api, p_period: period, p_n: n, p_cap: cap }); return error ? 0 : Number(data) || 0; } // 0 = no counter (run supabase/cache_and_quota.sql): safer than calling without a limit
  catch { return 0; }
};
async function availFor(kind: string, id: number, fresh = false): Promise<Record<string, unknown>> {
  const ckey = `avail:v1:${kind}:${id}`;
  const save = async (out: Record<string, unknown>) => { try { await db.from("similar_cache").upsert({ seed_key: ckey, list: out, built_at: new Date().toISOString() }); } catch { /* ignore */ } };
  try {
    const { data } = await db.from("similar_cache").select("list,built_at").eq("seed_key", ckey).maybeSingle();
    const keep = data && (data.list as any)?.available ? AVAIL_YES_MS : AVAIL_NO_MS;
    if (!fresh && data && Date.now() - new Date(data.built_at).getTime() < keep) return data.list as any;
  } catch { /* table missing: ask live */ }

  // 1. Watchmode
  let wmEmpty = false;
  if (watchmodeOn()) {
    const w = await askWatchmode(kind, id, reserveApi);
    if (!w.error && w.entries.length) {
      const out = { ok: true, available: true, via: "watchmode", country: w.entries[0].country, service: w.entries[0].service, type: w.entries[0].type, entries: w.entries.slice(0, 8), sources: ["watchmode.com"] };
      await save(out);
      return out;
    }
    wmEmpty = !w.error; // Watchmode answered and has nothing (an error is not an answer)
  }
  // Gemini could not be used: keep Watchmode's empty answer for 30 minutes, or report the error (not saved) when Watchmode had no answer either
  const noGemini = async (why: string): Promise<Record<string, unknown>> => {
    if (!wmEmpty) return { ok: false, error: why };
    const out = { ok: true, available: false, via: "watchmode", gemini: why };
    await save(out);
    return out;
  };

  // 2. Gemini search (last)
  if (!heartOn()) return await noGemini("no GEMINI_API_KEY");
  // a 429 was seen (by any instance): stay quiet until the pause row runs out, so the similar-titles features keep the Gemini quota
  try {
    const { data: pz } = await db.from("similar_cache").select("list").eq("seed_key", "avail:pause").maybeSingle();
    const until = Number((pz?.list as any)?.until || 0);
    if (until > Date.now()) return await noGemini(`Gemini is resting after a rate limit (${Math.ceil((until - Date.now()) / 60_000)} min); similar titles come first`);
  } catch { /* table missing: go on */ }
  const r = await tmdb(`/${kind}/${id}`);
  const title = String(r.title || r.name || ""), year = String(r.release_date || r.first_air_date || "").slice(0, 4);
  if (!title) return { ok: false, error: "no title" };
  const a = await askAvailability({ title, year, kind, today: new Date().toISOString().slice(0, 10) });
  if (a.error) {
    if (/429/.test(a.error)) { try { await db.from("similar_cache").upsert({ seed_key: "avail:pause", list: { until: Date.now() + 5 * 60_000 }, built_at: new Date().toISOString() }); } catch { /* ignore */ } }
    return await noGemini(a.error); // without a Watchmode answer: not saved, asked again next time
  }
  const out = a.avail ? { ok: true, available: true, via: "gemini", country: a.avail.country, service: a.avail.service, type: a.avail.type, entries: (a.entries || []).slice(0, 8), sources: a.sources.slice(0, 3) } : { ok: true, available: false, via: "gemini" };
  await save(out);
  return out;
}
// ---------- a fuller biography for a person (GET ?personbio=1&id=<TMDB person id>) ----------
// TMDB's biography is often one or two lines. Wikipedia (found through Wikidata's TMDB person id, P4985) has the real career text.
// Saved 30 days (a "nothing found" only 3 days), so a director that many people open is looked up once. No Gemini, no credit used.
const BIO_DAYS = 30, BIO_EMPTY_DAYS = 3;
async function personBio(id: number): Promise<{ bio: string; url?: string }> {
  const ckey = `personbio:v1:${id}`;
  try {
    const { data } = await db.from("similar_cache").select("list,built_at").eq("seed_key", ckey).maybeSingle();
    const l = data?.list as any;
    if (l && Date.now() - new Date(data!.built_at).getTime() < (l.bio ? BIO_DAYS : BIO_EMPTY_DAYS) * 864e5) return l;
  } catch { /* table missing: ask live */ }
  const q = `SELECT ?name WHERE { ?p wdt:P4985 "${id}" . ?art schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?name . } LIMIT 1`;
  const wr = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { headers: { Accept: "application/sparql-results+json", "User-Agent": UA }, signal: AbortSignal.timeout(8_000) });
  if (!wr.ok) throw new Error("Wikidata " + wr.status); // not saved: asked again next time
  const title = String((await wr.json()).results?.bindings?.[0]?.name?.value || "");
  let out: { bio: string; url?: string } = { bio: "" };
  if (title) {
    const get = async (intro: boolean) => {
      const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&redirects=1&format=json&exchars=4500" + (intro ? "&exintro=1" : "") + "&titles=" + encodeURIComponent(title), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) throw new Error("Wikipedia " + r.status);
      return String((Object.values((await r.json()).query?.pages || {})[0] as any)?.extract || "");
    };
    let ex = await get(true);
    if (ex.length < 700) ex = await get(false); // a one-paragraph lead: take the start of the article (career, early life) instead
    // paragraphs only (drop section headings, which have no full stop), cut at a sentence end, about 1800 characters
    const paras = ex.split(/\n+/).map((x) => x.trim()).filter((x) => x.length > 60 && /[.!?]["')]?$/.test(x));
    let text = "";
    for (const pa of paras) { if (text.length >= 1100) break; text += (text ? "\n\n" : "") + pa; }
    if (text.length > 1900) { const c = text.slice(0, 1900); text = c.slice(0, Math.max(c.lastIndexOf(". "), 400) + 1); }
    if (text) out = { bio: text, url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_")) };
  }
  try { await db.from("similar_cache").upsert({ seed_key: ckey, list: out, built_at: new Date().toISOString() }); } catch { /* ignore */ }
  return out;
}
// ---------- permanent person store (v96): GET ?personfull=1&id=<TMDB person id> ----------
// Everything a person page needs (TMDB profile + filmography, Wikidata filmography, Wikipedia bio) is saved in table person_store and served from there.
// Stale data is still shown at once and refreshed in the background (people with an upcoming title after 1 day, others after 7 days),
// and GET ?personrefresh=1&token=... (called by pg_cron, see supabase/person_store.sql) refreshes the oldest rows, so new releases and corrections arrive by themselves.
const PS_DAYS = 7, PS_UP_DAYS = 1;
const psRefreshing = new Set<number>();
async function wikidataCredits(id: number): Promise<{ credits: any[]; desc: string }> {
  const q = `SELECT ?filmLabel ?mv ?tv ?date ?role ?pd WHERE {
    ?p wdt:P4985 "${id}" .
    { ?film wdt:P161 ?p . BIND("Actor" AS ?role) } UNION { ?film wdt:P57 ?p . BIND("Director" AS ?role) } UNION { ?film wdt:P86 ?p . BIND("Composer" AS ?role) } UNION { ?film wdt:P344 ?p . BIND("Cinematographer" AS ?role) } UNION { ?film wdt:P1040 ?p . BIND("Editor" AS ?role) } UNION { ?film wdt:P58 ?p . BIND("Writer" AS ?role) } UNION { ?film wdt:P162 ?p . BIND("Producer" AS ?role) }
    OPTIONAL { ?film wdt:P4947 ?mv } OPTIONAL { ?film wdt:P4983 ?tv } OPTIONAL { ?film wdt:P577 ?date }
    OPTIONAL { ?p schema:description ?pd . FILTER(LANG(?pd) = "en") }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } LIMIT 800`;
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { headers: { Accept: "application/sparql-results+json", "User-Agent": UA }, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error("Wikidata " + r.status);
  const map = new Map<string, any>();
  let desc = "";
  for (const b of (await r.json()).results?.bindings || []) {
    if (!desc && b.pd?.value) desc = b.pd.value;
    const mv = b.mv && /^\d+$/.test(b.mv.value) ? b.mv.value : "", tv = b.tv && /^\d+$/.test(b.tv.value) ? b.tv.value : "";
    const title = b.filmLabel ? b.filmLabel.value : "";
    if ((!mv && !tv) || !title || /^Q\d+$/.test(title)) continue;
    const media_type = mv ? "movie" : "tv", cid = +(mv || tv), k = media_type + ":" + cid;
    const date = b.date && /^\d{4}/.test(b.date.value) ? b.date.value.slice(0, 10) : "";
    const cur = map.get(k) || { id: cid, media_type, title, date, poster: "", votes: 0, roles: [], char: "", src: "wikidata", rating: 0 };
    if (!cur.roles.includes(b.role.value)) cur.roles.push(b.role.value);
    if (date && (!cur.date || date < cur.date)) cur.date = date;
    map.set(k, cur);
  }
  return { credits: [...map.values()], desc };
}
async function buildPerson(id: number, old?: any): Promise<any> {
  const tm = await tmdb(`/person/${id}`, { append_to_response: "combined_credits" }); // TMDB down: throws, the saved row stays as it is
  // Wikidata and Wikipedia are optional: when one fails now, keep what was saved before
  const [wd, bio] = await Promise.all([
    wikidataCredits(id).catch(() => old?.wd || { credits: [], desc: "" }),
    personBio(id).catch(() => old?.bio || { bio: "" }),
  ]);
  const data = { tmdb: tm, wd, bio };
  const today = new Date().toISOString().slice(0, 10);
  const cc = tm.combined_credits || {};
  const up = [...(cc.cast || []), ...(cc.crew || [])].some((c: any) => String(c.release_date || c.first_air_date || "").slice(0, 10) > today)
    || wd.credits.some((c: any) => String(c.date || "") > today);
  await db.from("person_store").upsert({ id, name: String(tm.name || ""), data, has_upcoming: up, fetched_at: new Date().toISOString() }, { ignoreDuplicates: false });
  return data;
}
async function personFull(id: number): Promise<any> {
  let row: any = null;
  try { row = (await db.from("person_store").select("data,fetched_at,has_upcoming,hits,imdb").eq("id", id).maybeSingle()).data; } catch { /* table missing: build live */ }
  if (row) {
    const age = Date.now() - new Date(row.fetched_at).getTime(), limit = (row.has_upcoming ? PS_UP_DAYS : PS_DAYS) * 864e5;
    try { await db.from("person_store").update({ hits: (row.hits || 0) + 1, last_hit: new Date().toISOString() }).eq("id", id); } catch { /* ignore */ }
    if (age < limit) return { ...row.data, imdb: row.imdb || [], saved: true };
    if (!psRefreshing.has(id) && typeof EdgeRuntime !== "undefined") { // stale: show it now, refresh in the background
      psRefreshing.add(id);
      EdgeRuntime!.waitUntil(buildPerson(id, row.data).catch(() => {}).finally(() => psRefreshing.delete(id)));
    }
    return { ...row.data, imdb: row.imdb || [], saved: true, stale: true };
  }
  return { ...(await buildPerson(id)), imdb: [], saved: false };
}
// the oldest rows first (most opened first among equals), a few at a time so one call stays short
async function personRefreshBatch(max = 25): Promise<{ refreshed: number; failed: number }> {
  const upCut = new Date(Date.now() - PS_UP_DAYS * 864e5).toISOString(), cut = new Date(Date.now() - PS_DAYS * 864e5).toISOString();
  const { data } = await db.from("person_store").select("id,data,has_upcoming,fetched_at").or(`and(has_upcoming.eq.true,fetched_at.lt.${upCut}),fetched_at.lt.${cut}`).order("hits", { ascending: false }).limit(max);
  let refreshed = 0, failed = 0;
  for (const r of data || []) {
    try { await buildPerson(r.id, r.data); refreshed++; } catch { failed++; }
    await new Promise((ok) => setTimeout(ok, 700)); // gentle on TMDB and Wikidata
  }
  return { refreshed, failed };
}
// ---------- a person's missing titles from Gemini, each one checked on TMDB (GET ?person=1&id=<TMDB person id>) ----------
const PERSON_DAYS = 30;
const DEPT_ROLE: Record<string, string> = { Acting: "Actor", Directing: "Director", Sound: "Composer", Camera: "Cinematographer", Editing: "Editor", Writing: "Writer", Production: "Producer" };
const normT = (s: string) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
async function personFilms(id: number): Promise<{ credits: any[]; error?: string }> {
  const ckey = `person:v1:${id}`;
  try {
    const { data } = await db.from("similar_cache").select("list,built_at").eq("seed_key", ckey).maybeSingle();
    if (data && Date.now() - new Date(data.built_at).getTime() < PERSON_DAYS * 864e5) return data.list as any;
  } catch { /* table missing: ask live */ }
  if (!heartOn()) return { credits: [], error: "no GEMINI_API_KEY" };
  const p = await tmdb(`/person/${id}`, { append_to_response: "combined_credits" });
  const role = DEPT_ROLE[String(p.known_for_department || "")] || "Actor";
  const cc = p.combined_credits || {};
  const pool: any[] = role === "Actor" ? cc.cast || [] : cc.crew || [];
  const known = pool.filter((x) => x.media_type === "movie" && x.title).sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0)).slice(0, 6)
    .map((x) => `${x.title} (${String(x.release_date || "").slice(0, 4)})`);
  const ask = await askFilmography({ name: String(p.name || ""), role, born: String(p.birthday || "").slice(0, 4), known });
  if (ask.error) return { credits: [], error: ask.error }; // not saved: asked again next time
  const out: any[] = [], seen = new Set<string>();
  const check = async (t: { title: string; year: number; type: string }) => {
    const tv = t.type === "tv";
    const q = normT(t.title);
    const hit = async (params: Record<string, string>) => ((await tmdb(`/search/${tv ? "tv" : "movie"}`, { query: t.title, include_adult: "false", ...params })).results || []) as any[];
    let res = await hit(tv ? { first_air_date_year: String(t.year) } : { primary_release_year: String(t.year) }).catch(() => [] as any[]);
    const ok = (r: any) => {
      const y = Number(String(r.release_date || r.first_air_date || "").slice(0, 4)) || 0;
      return Math.abs(y - t.year) <= 1 && (normT(r.title || r.name) === q || normT(r.original_title || r.original_name) === q);
    };
    let m = res.find(ok);
    if (!m) { res = await hit({}).catch(() => [] as any[]); m = res.find(ok); }
    if (!m) return;
    const k = (tv ? "tv" : "movie") + ":" + m.id;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ id: m.id, media_type: tv ? "tv" : "movie", title: m.title || m.name, date: m.release_date || m.first_air_date || "", poster: m.poster_path || "", votes: m.vote_count || 0, rating: m.vote_average || 0, roles: [role], char: "", src: "gemini" });
  };
  for (let n = 0; n < ask.titles.length; n += 8) await Promise.all(ask.titles.slice(n, n + 8).map(check)); // 8 TMDB checks at a time
  const result = { credits: out };
  if (out.length) { try { await db.from("similar_cache").upsert({ seed_key: ckey, list: result, built_at: new Date().toISOString() }); } catch { /* ignore */ } }
  return result;
}

// ---------- build a list and save it ----------
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
const rebuilding = new Set<string>(); // lists being rebuilt in the background right now
const building = new Map<string, Promise<BuildOut>>(); // lists being built for a waiting request right now
const BUILD_WAIT_MS = 100_000; // how long a request waits for a build before answering "still building" (the gateway cuts at about 150 s)
const partKey = (kind: string, id: number, part: Part) => `${CACHE_VERSION}:${kind}:${id}` + (part === "all" ? "" : part === "world" ? ":world2" : ":" + part); // world2: the wider world section (older saved world lists are left behind)
async function refresh(kind: string, id: number, lite = false, part: Part = "all"): Promise<BuildOut> {
  const out = await build(kind, id, 0, lite, part);
  // if today's OMDb quota ran out before every score was fetched, keep the list but let it rebuild in about a day
  // (the scores saved meanwhile are reused, so the rebuild costs little)
  // v93: a list built while Gemini could not answer lacks its emotional-match picks, so it lives only about 6 hours and is rebuilt once Gemini is back
  const builtAt = new Date(out.gemDown ? Date.now() - (CACHE_DAYS * 864e5 - 6 * 3600e3) : out.partial ? Date.now() - (CACHE_DAYS - 1) * 864e5 : Date.now()).toISOString();
  if (out.list.length || part === "world" || part === "cross") { // an empty world / cross part is a result too (nothing strong enough), so it is saved
    const entry: CacheEntry = { grp: out.grp, items: out.list, pattern: out.pattern || [], dna: out.dna || [] };
    await db.from("similar_cache").upsert({ seed_key: partKey(kind, id, part), list: entry, built_at: builtAt });
  }
  if (Math.random() < 0.03) purgeRaw();
  return out;
}

// ---------- requests ----------
const int = (v: unknown) => (/^\d{1,9}$/.test(String(v ?? "")) ? Number(v) : 0);
const keyOk = (k: unknown) => typeof k === "string" && /^(movie|tv):\d{1,9}$/.test(k);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const xff = (req.headers.get("x-forwarded-for") || "").split(",").map((x) => x.trim()).filter(Boolean);
  const ip = req.headers.get("cf-connecting-ip") || xff[xff.length - 1] || "unknown";
  if (limited(ip)) return json({ error: "Too many requests" }, 429);

  if (req.method === "POST") {
    if (learnLimited(ip)) return json({ error: "Too many requests" }, 429);
    try {
      const b = await req.json();
      const id = int(b?.id), kind = b?.type === "tv" ? "tv" : "movie";
      const picked = (Array.isArray(b?.picked) ? b.picked : []).filter(keyOk).slice(0, 20) as string[];
      const shown = (Array.isArray(b?.shown) ? b.shown : []).filter(keyOk).slice(0, 40) as string[];
      if (!id || !picked.length) return json({ error: "Bad request" }, 400);
      await learn(kind, id, picked, shown);
      return json({ ok: true });
    } catch { return json({ error: "Could not learn" }, 500); }
  }
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const u = new URL(req.url).searchParams;
  const id = int(u.get("id")), kind = u.get("type") === "tv" ? "tv" : "movie";
  if (!id) return json({ error: "Missing id" }, 400);
  if (u.get("avail") === "1") {
    if (availLimited(ip)) return json({ error: "Too many requests" }, 429);
    const fresh = u.get("fresh") === "1";
    if (fresh && availFreshLimited(ip)) return json({ error: "Too many requests" }, 429);
    try { return json(await availFor(kind, id, fresh)); } catch { return json({ error: "Could not load" }, 502); }
  }
  if (u.get("personfull") === "1") {
    if (personLimited(ip)) return json({ error: "Too many requests" }, 429);
    try { return json(await personFull(id)); } catch { return json({ error: "Could not load" }, 502); }
  }
  if (u.get("personrefresh") === "1") { // called by the schedule, not by the app: needs the secret PERSON_REFRESH_TOKEN
    const tok = Deno.env.get("PERSON_REFRESH_TOKEN") || "";
    if (!tok || u.get("token") !== tok) return json({ error: "Forbidden" }, 403);
    try { return json(await personRefreshBatch()); } catch { return json({ error: "Could not refresh" }, 502); }
  }
  if (u.get("personbio") === "1") {
    if (personLimited(ip)) return json({ error: "Too many requests" }, 429);
    try { return json(await personBio(id)); } catch { return json({ error: "Could not load" }, 502); }
  }
  if (u.get("person") === "1") {
    if (personLimited(ip)) return json({ error: "Too many requests" }, 429);
    try { return json(await personFilms(id)); } catch { return json({ error: "Could not load" }, 502); }
  }
  if (u.get("details") === "1") {
    if (detailLimited(ip)) return json({ error: "Too many requests" }, 429);
    try { return json({ details: await details(kind, id) }); } catch { return json({ error: "Could not load details" }, 502); }
  }
  const part: Part = (["main", "world", "cross"] as string[]).includes(u.get("part") || "") ? (u.get("part") as Part) : "all";
  const lite = u.get("lite") === "1" || Deno.env.get("SIMILAR_LITE") === "on"; // lighter build (less CPU): the app asks for it after an HTTP 546
  if (u.get("debug") === "1") { // /similar?type=movie&id=...&debug=1 : builds fresh and says what happened in the world-cinema step
    if (buildLimited(ip)) return json({ error: "Too many requests" }, 429);
    try { const out = await build(kind, id, int(u.get("probe")), lite, part, int(u.get("stop"))); return json({ trace: (out.debug as any)?.trace, debug: out.debug, world: out.list.filter((x) => x.mix).map((x) => x.title), cross: out.list.filter((x) => x.cross).map((x) => x.title), main: out.list.filter((x) => !x.mix && !x.cross).length }); }
    catch (e) { return json({ error: String((e as Error)?.message || e) }, 502); }
  }
  try {
    const key = partKey(kind, id, part);
    const { data } = await db.from("similar_cache").select("list,built_at").eq("seed_key", key).maybeSingle();
    const entry = data?.list as CacheEntry | undefined;
    const saved = !!entry && Array.isArray(entry.items) && (entry.items.length > 0 || part === "world" || part === "cross");
    const age = data ? Date.now() - new Date(data.built_at).getTime() : Infinity;
    const serve = async (e: CacheEntry) => { const { w, n } = await loadWeights(e.grp || "en"); return json({ weights: w, n, list: e.items, pattern: e.pattern || [], dna: e.dna || [] }); };
    if (saved && u.get("refresh") !== "1") {
      if (age < CACHE_DAYS * 864e5) return await serve(entry!);
      // older than a week: show the saved list now and rebuild it in the background, so next week's new titles are there next time
      if (age < STALE_DAYS * 864e5 && typeof EdgeRuntime !== "undefined") {
        if (!rebuilding.has(key) && !buildLimited(ip)) {
          rebuilding.add(key);
          EdgeRuntime!.waitUntil(refresh(kind, id, lite, part).catch(() => {}).finally(() => rebuilding.delete(key)));
        }
        return await serve(entry!);
      }
    }
    // a second open of the same title joins the build that is already running instead of starting another
    let job = building.get(key);
    if (!job) {
      if (buildLimited(ip)) return json({ error: "Too many requests" }, 429);
      job = refresh(kind, id, lite, part);
      building.set(key, job);
      const done = () => { building.delete(key); };
      job.then(done, done);
    }
    try {
      // a build that runs past the platform limit is cut off by the gateway with an answer that has no CORS headers, and the
      // browser then reports "no answer". So stop waiting early, let the build finish in the background (it saves its list),
      // and tell the app to ask again in a moment.
      const TIMEOUT = Symbol("timeout");
      const out = await Promise.race([job, new Promise<typeof TIMEOUT>((res) => setTimeout(() => res(TIMEOUT), BUILD_WAIT_MS))]);
      if (out === TIMEOUT) {
        if (typeof EdgeRuntime !== "undefined") EdgeRuntime!.waitUntil(job.catch(() => {}));
        if (saved) return await serve(entry!);
        return json({ building: true, error: "Still building this list", retry: 12 }, 503);
      }
      return json({ weights: out.w, n: out.n, list: out.list, pattern: out.pattern || [], dna: out.dna || [] });
    } catch (e) {
      if (saved) return await serve(entry!); // the rebuild failed: an old list is better than none
      for (const v of part === "all" || part === "main" ? ["v20", "v19", "v18"] : []) { // ... and so is a list from an older version of the scoring
        const { data: old } = await db.from("similar_cache").select("list").eq("seed_key", `${v}:${kind}:${id}`).maybeSingle();
        const oe = old?.list as CacheEntry | undefined;
        if (oe && Array.isArray(oe.items) && oe.items.length) return await serve(oe);
      }
      throw e;
    }
  } catch (e) {
    console.error("similar failed", kind, id, e);
    return json({ error: "Could not build the list", detail: String((e as Error)?.message || e).slice(0, 200) }, 502);
  }
});
