// Pure helpers for the "similar" function: no network, no database. Kept apart so they can be tested on their own.

export const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));

// ---------- language: same language, neighbours, same country, the world ----------
export const SOUTH = ["ml", "ta", "te", "kn"], NORTH = ["hi", "bn", "mr", "pa", "gu", "ur"];
export const INDIA = [...SOUTH, ...NORTH];
// the group a language belongs to for LEARNED WEIGHTS (first match wins)
const GROUPS: Record<string, string[]> = {
  south: SOUTH, north: NORTH,
  eastasia: ["ko", "ja", "zh", "cn", "th"],
  europe: ["fr", "de", "it", "es", "pt", "nl", "sv", "da", "no", "fi", "pl"],
  middleeast: ["ar", "tr", "fa", "he"],
  sea: ["vi", "id", "ms", "tl"],
  slavic: ["ru", "uk", "cs", "sk", "bg", "sr", "hr"],
};
// "next door" circles, closest first. A language can sit in several (Thai: East Asia and Southeast Asia, Spanish: Iberia and
// Europe, Polish: Europe and Slavic). neighbours() mixes the circles a language is in, taking turns, so one circle cannot crowd out the rest.
const CIRCLES: string[][] = [
  ["es", "pt", "ca", "gl"],                                   // Iberia
  ["ar", "tr", "fa", "he"],                                   // Middle East
  ...Object.values(GROUPS),
  ["th", "vi", "id", "ms", "tl"],                             // Southeast Asia (Thai also keeps East Asia)
  ["pl", "ru", "uk", "cs", "sk", "bg", "sr", "hr"],           // Slavic (Polish also keeps Europe)
];
export function groupOf(lang: string): string {
  for (const [g, l] of Object.entries(GROUPS)) if (l.includes(lang)) return g;
  return !lang || lang === "en" ? "en" : "other";
}
const nbCache = new Map<string, string[]>();
// the languages next door (Malayalam -> Tamil, Telugu, Kannada; Turkish -> Arabic, Persian, Hebrew; Thai -> Korean, Vietnamese, Japanese ...)
export function neighbours(lang: string): string[] {
  const hit = nbCache.get(lang);
  if (hit) return hit;
  const lists = CIRCLES.filter((c) => c.includes(lang)).map((c) => c.filter((x) => x !== lang));
  const out: string[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && !out.includes(l[i])) out.push(l[i]);
  nbCache.set(lang, out);
  return out;
}
// 1 same language, 2 neighbouring language, 3 same country other language (India), 4 the rest of the world
export function tierOf(seed: string, lang: string): 1 | 2 | 3 | 4 {
  if (!seed || !lang || seed === lang) return 1;
  if (neighbours(seed).includes(lang)) return 2;
  if (INDIA.includes(seed) && INDIA.includes(lang)) return 3;
  return 4;
}
export const TIER_PEN = [0, 0, 1.0, 1.6, 2.4];
export const TIER_LANG_X = [0, 1, 0.5, 0.25, 0];

// ---------- maturity: U/A/R ... ----------
const MAT: [number, string[]][] = [
  [3, ["A", "S", "R", "X", "NC-17", "NC17", "18", "18+", "TV-MA", "TVMA", "18A", "R18+"]],
  [2, ["PG-13", "PG13", "TV-14", "TV14", "UA16+", "UA15+", "16", "16+", "15", "15+", "M", "MA15+"]],
  [1, ["UA", "UA13+", "13+", "12", "12A", "12+", "PG", "TV-PG", "TVPG", "10", "11", "13", "14"]],
  [0, ["U", "G", "TV-G", "TVG", "TV-Y", "TVY", "TV-Y7", "UA7+", "7+", "0", "ALL", "AL", "6", "6+"]],
];
// -1 unknown, 0 all ages, 1 parental guidance, 2 teen, 3 adult
export function maturityOf(cert: string): number {
  const c = String(cert || "").toUpperCase().replace(/[\s_/]/g, "");
  if (!c) return -1;
  for (const [level, list] of MAT) if (list.includes(c)) return level;
  return -1;
}
const CERT_PREF = ["IN", "US", "GB"];
// the age rating out of a TMDB title (movie: release_dates, series: content_ratings), India first
export function certOf(kind: string, r: any): string {
  const rows: { c: string; v: string }[] = kind === "tv"
    ? (r?.content_ratings?.results || []).map((x: any) => ({ c: x.iso_3166_1, v: String(x.rating || "") }))
    : (r?.release_dates?.results || []).map((x: any) => ({
      c: x.iso_3166_1,
      v: String((x.release_dates || []).map((d: any) => d.certification).find((s: string) => s) || ""),
    }));
  for (const c of CERT_PREF) { const f = rows.find((x) => x.c === c && x.v); if (f) return f.v; }
  return (rows.find((x) => x.v) || { v: "" }).v;
}
export const maturityMatch = (a: number, b: number) => (a < 0 || b < 0 ? 0.5 : 1 - Math.abs(a - b) / 3);

// ---------- tone: how dark / intense a title is, 0 (light) to 1 (dark) ----------
const DARK_G = new Set([80, 53, 27, 10752, 9648, 10768]);             // crime, thriller, horror, war, mystery, war & politics
const LIGHT_G = new Map<number, number>([[35, 0.3], [10751, 0.15], [16, 0.15], [10762, 0.15], [10766, 0.1], [10749, 0.05], [10402, 0.05]]); // comedy is the lightest; romance and music hardly count (Rockstar is both and is dark)
const DARK_RE = /violen|murder|kill|revenge|vengeance|gangster|mafia|brutal|gore|serial killer|drug|underworld|assassin|massacre|torture|vigilante|hitman|cartel|gritty|bleak|dark|abduct|kidnap|psychopath|tragic|tragedy|heartbreak|heartbroken|self[- ]destruct|doomed|obsess|grief|addict|suicid|despair/g;
const LIGHT_RE = /comedy|humou?r|rom[- ]?com|romantic comedy|wedding|feel[- ]good|friendship|slice of life|campus|college|school|heartwarming|slapstick|coming of age|family|prank|goofy|hilarious/g;
export function darkness(genreIds: number[], keywords: string[], overview: string, mat: number): number {
  let d = 0.3;
  for (const g of genreIds) { if (DARK_G.has(g)) d += 0.2; d -= LIGHT_G.get(g) || 0; }
  const k = keywords.join(" ").toLowerCase(), o = String(overview || "").toLowerCase();
  d += Math.min(0.3, 0.1 * (k.match(DARK_RE) || []).length);
  d -= Math.min(0.2, 0.1 * (k.match(LIGHT_RE) || []).length);
  d += Math.min(0.15, 0.05 * (o.match(DARK_RE) || []).length);
  d -= Math.min(0.1, 0.05 * (o.match(LIGHT_RE) || []).length);
  if (mat >= 0) d += (mat - 1.5) * 0.12;
  return clamp(d);
}
// x: 0..1 match, pen: how far down a tone clash is pushed. Only a CLEAR clash (a slapstick comedy for a dark thriller, a gap of 0.5 or more)
// is pushed far down; smaller gaps cost little, because the tone is estimated from keywords and is never exact.
export function toneMatch(a: number, b: number): { x: number; pen: number } {
  const diff = Math.abs(a - b);
  return { x: clamp(1 - diff / 0.6), pen: diff > 0.5 ? 2 : diff > 0.4 ? 0.6 : diff > 0.3 ? 0.2 : 0 };
}

// ---------- people behind the camera ----------
export type CrewIds = { d: number[]; w: number[]; m: number[] };
// same director 1, same writer 0.5, same composer 0.3 (at most 1)
export function crewMatch(a: CrewIds, b: CrewIds): number {
  const hit = (x: number[], y: number[]) => x.some((i) => y.includes(i));
  return clamp((hit(a.d, b.d) ? 1 : 0) + (hit(a.w, b.w) ? 0.5 : 0) + (hit(a.m, b.m) ? 0.3 : 0));
}

// ---------- which titles make the list ----------
//  - enough good titles in the language (20+ scoring 0.5 or more): only that language
//  - otherwise: the language's titles that are good enough, plus neighbouring languages, the rest of the country and the
//    world, each with its own (higher the farther away) bar, best first. A very thin list is topped up rather than left empty.
export const POOL = { enough: 20, floor: 12, good: 0.45, minScore: [0, 0.3, 0.32, 0.36, 0.46] };
export function selectPool<T extends { tier: number; score: number }>(rows: T[], size: number): T[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const same = sorted.filter((r) => r.tier === 1);
  if (same.filter((r) => r.score >= POOL.good).length >= POOL.enough) return same.filter((r) => r.score >= POOL.minScore[1]).slice(0, size);
  let out = sorted.filter((r) => r.score >= POOL.minScore[r.tier]).slice(0, size);
  if (out.length < POOL.floor) {
    const left = sorted.filter((r) => !out.includes(r));
    out = out.concat(left.slice(0, POOL.floor - out.length));
  }
  return out;
}

// ---------- similar taste from world cinema (a separate section under the list) ----------
// Strong matches only, in other languages than the original's (English titles get foreign ones, other languages get the rest of the
// world, English included). They skip the language bar; instead each has to pass its own checks: rating, the original's main genres,
// a matching tone and real evidence of likeness (plot text, the feel reviewers describe, or rare shared subjects).
export const WORLD = {
  max: 12,
  langs: ["ko", "ja", "fr", "es", "hi", "ml", "ta", "zh", "de", "it", "en"], // where picks are looked for (the original's own language is left out)
  perLang: 8,       // best titles taken from each language
  minRating: 6.8,   // TMDB rating
  minGenre: 0.3,    // share of the original's genres it has
  minTone: 0.4,     // tone match 0..1
  pen: 0.8,         // small fixed penalty in place of the language penalty
  fillTo: 10,       // fewer strict picks than this: the list is filled from the relaxed tier
  relaxedPct: 40,   // relaxed tier: minimum MATCH %
};
export function pickWorld<T extends { strong?: boolean; score: number; pen: number; genre: number; tone: number; rating: number; story: number; vibe: number; kw: number; theme: number; core: number; pct?: number }>(rows: T[]): T[] {
  const byScore = (a: T, b: T) => b.score - a.score;
  // tier 1: strict (strong match, core themes present)
  const strict = [...rows]
    .filter((r) => r.strong !== false && r.rating >= WORLD.minRating && r.genre >= WORLD.minGenre && r.tone >= WORLD.minTone && r.pen <= WORLD.pen + 0.7 && r.core >= 0.5 && r.theme >= 0.25 && // the original's core themes must be there (theme and core are 1 when the original has no clear theme)
      (r.story >= 0.3 || r.vibe >= 0.4 || r.kw >= 0.15 || r.theme >= 0.45))
    .sort(byScore);
  if (strict.length >= WORLD.fillTo) return strict.slice(0, WORLD.max);
  // tier 2: relaxed fill (same genre / tone / rating bars, but the strong-match and core-theme tests are replaced by a match % and one clear angle)
  const got = new Set(strict);
  const relaxed = rows
    .filter((r) => !got.has(r) && r.rating >= WORLD.minRating && r.genre >= WORLD.minGenre && r.tone >= WORLD.minTone && r.pen <= WORLD.pen + 1.9 &&
      (r.pct ?? 0) >= WORLD.relaxedPct && (r.story >= 0.25 || r.vibe >= 0.4 || r.kw >= 0.15 || r.theme >= 0.3))
    .sort(byScore);
  return [...strict, ...relaxed].slice(0, WORLD.max);
}
