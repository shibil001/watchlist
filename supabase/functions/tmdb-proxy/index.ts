// Supabase Edge Function: "tmdb-proxy". The app talks to TMDB through this, so the TMDB key stays on the server.
//
// Call (GET):  <SUPABASE_URL>/functions/v1/tmdb-proxy?path=/search/multi&query=inception&include_adult=false
//              add &fuzzy=1 to /search/multi for spelling-tolerant search (used by the "add title" box).
//
// Allowed paths:  /search/multi  /search/movie  /search/tv  /configuration
//                 /movie/{id}  /tv/{id}  (+ /recommendations, /similar or /watch/providers)  /collection/{id}
// Limits:         RATE_LIMIT_PER_MIN requests per IP per minute (default 60). Answers are cached in memory for a while.
//
// Deploy:  supabase secrets set TMDB_API_KEY=your_tmdb_v3_key      (a v4 "Read Access Token" also works)
//          supabase functions deploy tmdb-proxy --no-verify-jwt
// v93:     also run supabase/cache_and_quota.sql once (database cache for the most searched titles, directors and actors).

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400", // the browser asks permission once a day, not before every request
};
const TMDB = "https://api.themoviedb.org/3";
const RATE_LIMIT = Number(Deno.env.get("RATE_LIMIT_PER_MIN")) || 60;

const ALLOWED_PATHS: RegExp[] = [
  /^\/search\/(multi|movie|tv)$/,
  /^\/configuration$/,
  /^\/(movie|tv)\/\d{1,9}$/,
  /^\/(movie|tv)\/\d{1,9}\/(recommendations|similar)$/,
  /^\/tv\/\d{1,9}\/season\/\d{1,3}$/, // every episode of one season with its air date (release calendar)
  /^\/(movie|tv)\/\d{1,9}\/watch\/providers$/, // is it streaming anywhere (OTT tag)
  /^\/collection\/\d{1,9}$/,
  /^\/discover\/(movie|tv)$/, // movies and series of one production company (with_companies)
  /^\/person\/\d{1,9}$/, // cast & crew page: photo, bio and filmography (combined_credits)
  /^\/company\/\d{1,9}$/, // production company page: logo, country, headquarters, description
];
const ALLOWED_PARAMS = new Set([
  "query", "include_adult", "page", "language", "year", "primary_release_year", "first_air_date_year", "region", "append_to_response", "fuzzy", "with_companies", "sort_by",
]);
const ALLOWED_APPEND = new Set(["credits", "recommendations", "keywords", "similar", "external_ids", "watch/providers", "combined_credits", "release_dates"]);

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });

// ---------- per-IP limit ----------
const hits = new Map<string, { n: number; t: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > 60_000) { hits.set(ip, { n: 1, t: now }); if (hits.size > 5000) hits.clear(); return false; }
  return ++h.n > RATE_LIMIT;
}

// ---------- small answer cache (lives as long as this function instance does) ----------
const cache = new Map<string, { exp: number; body: string }>();
function cacheGet(k: string): string | null {
  const c = cache.get(k);
  if (!c) return null;
  if (c.exp < Date.now()) { cache.delete(k); return null; }
  return c.body;
}
function cacheSet(k: string, body: string, ttlMs: number) {
  if (cache.size >= 400) cache.delete(cache.keys().next().value as string);
  cache.set(k, { exp: Date.now() + ttlMs, body });
}
// ---------- hot cache in the database (v93): what people search most is answered without asking TMDB ----------
// Table hot_cache (supabase/cache_and_quota.sql). Every request is counted; once the same request has been asked twice its answer is saved,
// so one-off searches never fill the database. Rows nobody asks for are removed by the database itself.
// Lifetimes are short where a date can change (release dates, where-to-watch), longer for people.
const db = (() => { try { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } }); } catch { return null; } })();
const HOT_MIN = 2; // saved from the 2nd time it is asked
const hotTtlSecs = (path: string) =>
  path.startsWith("/search/") ? 6 * 3600
  : /^\/person\//.test(path) ? 3 * 86400       // directors, actors: filmography changes slowly
  : /\/watch\/providers$/.test(path) ? 3 * 3600 // same lifetime as the streaming check
  : /^\/(movie|tv)\/\d+$/.test(path) ? 6 * 3600 // release dates and status can change
  : /^\/tv\/\d+\/season\//.test(path) ? 6 * 3600
  : path === "/configuration" ? 86400
  : 6 * 3600;
async function hotGet(k: string, path: string): Promise<string | null> {
  if (!db) return null;
  try {
    const { data, error } = await db.rpc("hot_get", { p_k: k, p_ttl: hotTtlSecs(path) });
    if (error) return null; // table missing: just go to TMDB
    const row = Array.isArray(data) ? data[0] : data;
    return row && typeof row.body === "string" && row.body ? row.body : null;
  } catch { return null; }
}
async function hotPut(k: string, body: string) {
  if (!db || body.length > 400_000) return;
  try { await db.rpc("hot_put", { p_k: k, p_body: body, p_min: HOT_MIN }); } catch { /* optional */ }
}
const later = (p: Promise<unknown>) => { try { (globalThis as any).EdgeRuntime?.waitUntil ? (globalThis as any).EdgeRuntime.waitUntil(p) : void p; } catch { void p; } };

const ttlFor = (path: string) => path.startsWith("/search/") ? 10 * 60_000 : path === "/configuration" ? 24 * 3600_000 : 30 * 60_000;

// ---------- TMDB ----------
async function tmdbFetch(path: string, params: Record<string, string>): Promise<Response> {
  const key = (Deno.env.get("TMDB_API_KEY") || "").trim();
  const u = new URL(TMDB + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key; // v4 token
  else u.searchParams.set("api_key", key);                           // v3 key
  let r = await fetch(u, { headers, signal: AbortSignal.timeout(10_000) });
  if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1000)); r = await fetch(u, { headers, signal: AbortSignal.timeout(10_000) }); }
  return r;
}
async function tmdbJson(path: string, params: Record<string, string>): Promise<any> {
  const r = await tmdbFetch(path, params);
  if (!r.ok) throw new Error("TMDB " + r.status);
  return await r.json();
}

// ---------- spelling-tolerant search ----------
// Plain form of a title or a query: no accents, lower case, no punctuation, one space between words.
const norm = (s: string) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/&/g, " and ").replace(/['\u2018\u2019\u2032`\u00b4]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const WORD_NUM: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
const ROMAN_NUM: Record<string, string> = { ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9" };
const NUM_WORD: Record<string, string> = Object.fromEntries(Object.entries(WORD_NUM).map(([w, d]) => [d, w]));
const NUM_ROMAN: Record<string, string> = Object.fromEntries(Object.entries(ROMAN_NUM).map(([r, d]) => [d, r]));
// words of a normalised string, with "four" / "iv" turned into "4" so they compare equal
const words = (n: string) => n.split(" ").filter(Boolean).map((w) => WORD_NUM[w] || ROMAN_NUM[w] || w);

// edit distance where swapping two neighbouring letters counts as one mistake ("inceptoin")
function editDist(a: string, b: string): number {
  a = a.slice(0, 80); b = b.slice(0, 80);
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
function wordSim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 3 && b.startsWith(a)) return 0.95; // still being typed
  return Math.max(0, 1 - editDist(a, b) / Math.max(a.length, b.length));
}
// How alike a typed query and a title are, 0 to 1.
function sim(query: string, title: string): number {
  const qn = norm(query), tn = norm(title);
  if (!qn || !tn) return 0;
  const qw = words(qn), tw = words(tn);
  let num = 0, den = 0;
  for (const w of qw) { let best = 0; for (const v of tw) best = Math.max(best, wordSim(w, v)); num += best * w.length; den += w.length; }
  const byWord = (den ? num / den : 0) - Math.min(0.15, 0.03 * Math.max(0, tw.length - qw.length)); // mild preference for the shorter title
  const whole = 1 - editDist(qn, tn) / Math.max(qn.length, tn.length);
  return Math.max(byWord, whole);
}
const names = (r: any): string[] => [r.title, r.name, r.original_title, r.original_name].filter((x) => typeof x === "string" && x);
const bestSim = (q: string, r: any) => Math.max(0, ...names(r).map((t) => sim(q, t)));
// good enough that TMDB's own answer can be trusted: a close name, or the typed text is part of a name
// An obscure title with the typed name (TMDB has a film called "Interstelar") is not proof that the query was spelt right,
// so only a well-known title counts.
const wellKnown = (r: any) => (r.popularity || 0) >= 15 || (r.vote_count || 0) >= 200;
const isStrong = (q: string, rs: any[]) => {
  const qn = norm(q);
  return rs.slice(0, 5).some((r) => wellKnown(r) && (bestSim(q, r) >= 0.85 || (qn.length >= 3 && names(r).some((t) => norm(t).includes(qn)))));
};

const uniq = (a: string[]) => [...new Set(a.filter(Boolean))];
// other ways to write the same title: numbers as words/digits/roman numerals, words run together
function altSpellings(q: string): string[] {
  const t = q.split(" ");
  const out: string[] = [];
  out.push(t.map((w) => NUM_WORD[w] || WORD_NUM[w] || w).join(" "));
  out.push(t.map((w) => ROMAN_NUM[w] || NUM_ROMAN[w] || w).join(" "));
  if (t.length >= 2 && t.length <= 3) out.push(t.join(""));
  return uniq(out).filter((s) => s !== q);
}
// TMDB matches the start of the last word, so cutting a misspelt query short often reaches the right title
function cutDown(q: string): string[] {
  const cut = (s: string, f: number) => s.slice(0, Math.max(3, Math.ceil(s.length * f))).trim();
  const out: string[] = [];
  if (q.length >= 5) out.push(cut(q, 0.7));
  if (q.length >= 8) out.push(cut(q, 0.5));
  q.split(" ").filter((w) => w.length >= 5).sort((a, b) => b.length - a.length).slice(0, 2).forEach((w) => out.push(cut(w, 0.7))); // a mistake in an early word
  return uniq(out).filter((s) => s.length >= 3 && s !== q);
}

const isTitle = (r: any) => r && (r.media_type === "movie" || r.media_type === "tv");
async function smartSearch(raw: string, params: Record<string, string>): Promise<unknown> {
  const typed = raw.normalize("NFKC").replace(/[\u2018\u2019\u201B\u2032]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, " ").trim().slice(0, 150);
  const q = norm(typed);
  // TMDB lists popular matches first, so a new obscure title with the exact name can sit on page 2, or be missing from the mixed list.
  // So also read page 2 and the movie / series searches, then put titles named exactly as typed first.
  const widen = async (list: any[]): Promise<any[]> => {
    const seen = new Set(list.map((r) => r.media_type + ":" + r.id));
    const out = [...list];
    const more = await Promise.allSettled([
      tmdbJson("/search/multi", { ...params, query: typed, page: "2" }),
      tmdbJson("/search/movie", { ...params, query: typed }),
      tmdbJson("/search/tv", { ...params, query: typed }),
    ]);
    more.forEach((x, i) => {
      if (x.status !== "fulfilled") return;
      for (const r of (x.value.results || [])) {
        const mt = i === 1 ? "movie" : i === 2 ? "tv" : r.media_type;
        if (mt !== "movie" && mt !== "tv") continue;
        const k = mt + ":" + r.id;
        if (!seen.has(k)) { seen.add(k); out.push({ ...r, media_type: mt }); }
      }
    });
    const exact = (r: any) => names(r).some((n) => norm(n) === q);
    return [...out.filter(exact), ...out.filter((r) => !exact(r))];
  };
  const reply = async (results: any[]) => {
    const all = q ? await widen(results) : results;
    return { page: 1, results: all.slice(0, 30), total_pages: 1, total_results: Math.min(all.length, 30) };
  };
  if (!q) return reply([]);

  const pool = new Map<string, any>();
  const ask = async (query: string): Promise<any[]> => {
    const d = await tmdbJson("/search/multi", { ...params, query });
    const rs = (d.results || []).filter(isTitle);
    for (const r of rs) { const k = r.media_type + ":" + r.id; if (!pool.has(k)) pool.set(k, r); }
    return rs;
  };

  // 1. what was typed, and the cleaned-up form of it
  const first = await Promise.allSettled(uniq([typed, q !== typed.toLowerCase() ? q : ""]).map(ask));
  if (first.every((x) => x.status === "rejected")) throw (first[0] as PromiseRejectedResult).reason; // TMDB is down: report it
  const primary = [...pool.values()];
  if (isStrong(q, primary)) return reply(primary);

  // 2. other spellings of the same title (4 / four / IV, "spider man" / "spiderman")
  await Promise.allSettled(altSpellings(q).map(ask));
  if (isStrong(q, [...pool.values()].sort((a, b) => bestSim(q, b) - bestSim(q, a)))) {
    return reply([...pool.values()].sort((a, b) => bestSim(q, b) - bestSim(q, a)));
  }

  // 3. misspelling: search for shortened forms, then keep what looks like what was typed
  await Promise.allSettled(cutDown(q).map(ask));
  const ranked = [...pool.values()]
    .map((r) => ({ r, s: bestSim(q, r) }))
    .filter((x) => x.s >= 0.5)
    .map((x) => ({ r: x.r, score: x.s + 0.2 * Math.min(1, (x.r.popularity || 0) / 20) })) // a well-known near match beats an obscure exact one
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
  return reply(ranked.length ? ranked : primary); // never worse than the plain TMDB answer
}

// ---------- request ----------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  if (limited(ip)) return json({ error: "Too many requests" }, 429, { "Retry-After": "10" });

  const url = new URL(req.url);
  const path = (url.searchParams.get("path") || "").trim();
  if (!ALLOWED_PATHS.some((re) => re.test(path))) return json({ error: "path not allowed" }, 403);

  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (k === "path" || !ALLOWED_PARAMS.has(k) || v.length > 200) continue;
    if (k === "append_to_response" && !v.split(",").every((x) => ALLOWED_APPEND.has(x))) return json({ error: "append_to_response not allowed" }, 403);
    if (k === "with_companies" && !/^\d{1,9}$/.test(v)) return json({ error: "with_companies must be one company id" }, 400);
    if (k === "sort_by" && !/^[a-z_.]+$/.test(v)) continue;
    params[k] = v;
  }
  if (!(Deno.env.get("TMDB_API_KEY") || "").trim()) return json({ error: "TMDB_API_KEY is not set on this function" }, 500);

  const fuzzy = path === "/search/multi" && params.fuzzy === "1" && !!(params.query || "").trim();
  delete params.fuzzy;
  const ck = path + "?" + Object.keys(params).sort().map((k) => k + "=" + params[k]).join("&") + (fuzzy ? "&~fuzzy" : "");
  const maxAge = path.startsWith("/search/") ? 60 : 300;
  const ok = (body: string) => new Response(body, { status: 200, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=" + maxAge } });

  const hit = cacheGet(ck);
  if (hit) return ok(hit);
  const useHot = !(path.startsWith("/search/") && (params.query || "").trim().length < 4); // half-typed searches are not worth a database round trip
  const saved = useHot ? await hotGet(ck, path) : null; // 2nd level: the database (shared by every instance and every user)
  if (saved) { cacheSet(ck, saved, ttlFor(path)); return ok(saved); }

  try {
    if (fuzzy) {
      const body = JSON.stringify(await smartSearch(params.query, params));
      cacheSet(ck, body, ttlFor(path));
      useHot && later(hotPut(ck, body));
      return ok(body);
    }
    const r = await tmdbFetch(path, params);
    const body = await r.text();
    if (r.ok) { cacheSet(ck, body, ttlFor(path)); useHot && later(hotPut(ck, body)); return ok(body); }
    return new Response(body, { status: r.status, headers: { ...CORS, "Content-Type": "application/json" } }); // 404, 429 ... passed on as they are
  } catch {
    return json({ error: "TMDB could not be reached" }, 502);
  }
});
