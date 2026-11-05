// heart.ts: the HUMAN HEART of a film ("story DNA"). Interstellar is space on the surface, but its heart is a father, a daughter and a promise.
// Manchester by the Sea is remorse. Drishyam is an ordinary man hiding a crime to protect his family. Ocean's Eleven is the cleverness of the con.
//
// One small Gemini call describes a film once (a few films per call). The answer is saved forever (table similar_raw, key heart1:<kind>:<id>),
// so a film is only ever asked about the first time it shows up. Two films are then compared on the heart, not on genre or setting.
// No GEMINI_API_KEY, or any failure: every function here answers "nothing" and the older keyword scoring (theme.ts) carries on alone.
//
//   supabase secrets set GEMINI_API_KEY=...            (free key from Google AI Studio)
//   supabase secrets set GEMINI_MODEL=...              (optional, default: gemini-flash-lite-latest)

export const REL = [
  "father_daughter", "father_son", "mother_daughter", "mother_son", "parent_child", "grandparent_child", "siblings", "romantic_couple",
  "married_couple", "forbidden_lovers", "friends", "mentor_student", "rivals", "found_family", "strangers_bond", "colleagues", "community", "alone",
];
export const ENGINE = [
  "remorse_guilt", "grief_loss", "promise_duty", "protecting_family", "sacrifice", "obsession", "revenge", "redemption", "survival",
  "ambition_greed", "betrayal", "identity_search", "coming_of_age", "forbidden_desire", "loneliness", "justice_vs_law", "moral_dilemma",
  "cover_up_secret", "clever_scheme", "legacy_inheritance", "love_against_odds", "self_destruction", "corruption_power", "escape_freedom",
  "faith_doubt", "belonging", "cost_of_fame", "cost_of_war", "fighting_injustice", "nostalgia_memory", "time_lost", "parenthood_burden",
];
export const ENDING = ["devastating", "tragic", "bittersweet", "hopeful", "uplifting", "haunting", "cathartic", "bleak", "ambiguous", "triumphant", "tense"];

export type Heart = { rel: string[]; engine: string[]; ending: string[]; story: string; conflict: string; world: string[] };

export const LABEL: Record<string, string> = {
  father_daughter: "a father and daughter", father_son: "a father and son", mother_daughter: "a mother and daughter", mother_son: "a mother and son",
  parent_child: "a parent and child", grandparent_child: "a grandparent and child", siblings: "siblings", romantic_couple: "a couple", married_couple: "a marriage",
  forbidden_lovers: "forbidden lovers", friends: "friendship", mentor_student: "a mentor and student", rivals: "rivals", found_family: "a found family",
  strangers_bond: "strangers who bond", colleagues: "colleagues", community: "a community", alone: "one person alone",
  remorse_guilt: "remorse and guilt", grief_loss: "grief and loss", promise_duty: "a promise to keep", protecting_family: "protecting family", sacrifice: "sacrifice",
  obsession: "obsession", revenge: "revenge", redemption: "redemption", survival: "survival", ambition_greed: "ambition and greed", betrayal: "betrayal",
  identity_search: "finding who you are", coming_of_age: "coming of age", forbidden_desire: "forbidden desire", loneliness: "loneliness", justice_vs_law: "justice versus the law",
  moral_dilemma: "a moral dilemma", cover_up_secret: "a secret to hide", clever_scheme: "a clever scheme", legacy_inheritance: "legacy across generations",
  love_against_odds: "love against the odds", self_destruction: "self-destruction", corruption_power: "corruption and power", escape_freedom: "escape and freedom",
  faith_doubt: "faith and doubt", belonging: "belonging", cost_of_fame: "the cost of fame", cost_of_war: "the cost of war", fighting_injustice: "fighting injustice",
  nostalgia_memory: "nostalgia and memory", time_lost: "time lost", parenthood_burden: "the weight of parenthood",
};

// tags that are close cousins count partly (a guilt story and a redemption story are neighbours; a father-son and a parent-child bond too)
const SOFT_PAIRS: [string, string, number][] = [
  ["remorse_guilt", "redemption", 0.6], ["remorse_guilt", "moral_dilemma", 0.5], ["remorse_guilt", "grief_loss", 0.4], ["remorse_guilt", "cover_up_secret", 0.4],
  ["protecting_family", "cover_up_secret", 0.6], ["protecting_family", "sacrifice", 0.6], ["protecting_family", "parenthood_burden", 0.5], ["protecting_family", "promise_duty", 0.5],
  ["promise_duty", "sacrifice", 0.5], ["promise_duty", "time_lost", 0.4], ["time_lost", "nostalgia_memory", 0.5], ["time_lost", "grief_loss", 0.4],
  ["legacy_inheritance", "parenthood_burden", 0.5], ["legacy_inheritance", "remorse_guilt", 0.3], ["moral_dilemma", "justice_vs_law", 0.5], ["moral_dilemma", "cover_up_secret", 0.5],
  ["obsession", "self_destruction", 0.5], ["obsession", "love_against_odds", 0.3], ["love_against_odds", "forbidden_desire", 0.5], ["revenge", "justice_vs_law", 0.4],
  ["corruption_power", "ambition_greed", 0.5], ["corruption_power", "justice_vs_law", 0.4], ["coming_of_age", "identity_search", 0.5], ["survival", "escape_freedom", 0.4],
  ["fighting_injustice", "justice_vs_law", 0.5], ["belonging", "loneliness", 0.3], ["grief_loss", "loneliness", 0.3],
  ["father_daughter", "parent_child", 0.6], ["father_son", "parent_child", 0.6], ["mother_daughter", "parent_child", 0.6], ["mother_son", "parent_child", 0.6],
  ["father_daughter", "father_son", 0.35], ["mother_daughter", "mother_son", 0.35], ["father_daughter", "mother_daughter", 0.3], ["father_son", "mother_son", 0.3],
  ["romantic_couple", "forbidden_lovers", 0.6], ["romantic_couple", "married_couple", 0.5], ["friends", "found_family", 0.5], ["friends", "strangers_bond", 0.4],
  ["devastating", "tragic", 0.7], ["devastating", "haunting", 0.5], ["tragic", "bleak", 0.6], ["bittersweet", "hopeful", 0.4], ["hopeful", "uplifting", 0.7],
  ["uplifting", "triumphant", 0.7], ["cathartic", "bittersweet", 0.4], ["haunting", "ambiguous", 0.4], ["tense", "bleak", 0.3],
];
const SOFT = new Map<string, number>();
for (const [a, b, s] of SOFT_PAIRS) { SOFT.set(a + "|" + b, s); SOFT.set(b + "|" + a, s); }
const sim = (a: string, b: string) => (a === b ? 1 : SOFT.get(a + "|" + b) || 0);

// how much of the original's tags the other has (the first tag is the most important). 0..1
function recall(seed: string[], cand: string[]): number {
  if (!seed.length) return 0;
  const W = [1, 0.7, 0.5];
  let num = 0, den = 0;
  seed.slice(0, 3).forEach((t, i) => { const w = W[i]; den += w; num += w * Math.max(0, ...cand.map((c) => sim(t, c))); });
  return den ? num / den : 0;
}
export type HeartMatch = { engine: number; rel: number; ending: number; core: number };
const best = (seed: string[], cand: string[]): number => Math.max(0, ...seed.flatMap((t) => cand.map((c) => sim(t, c))));
export function heartMatch(a: Heart, b: Heart): HeartMatch {
  // one shared main drive (guilt, protecting family ...) already makes two films cousins: it counts half, the weighted recall the other half
  const engine = 0.5 * recall(a.engine, b.engine) + 0.5 * best(a.engine, b.engine), rel = 0.6 * recall(a.rel, b.rel) + 0.4 * best(a.rel, b.rel), ending = recall(a.ending, b.ending);
  const relMatters = a.rel.some((r) => r !== "alone");
  return { engine, rel, ending, core: relMatters ? 0.55 * engine + 0.3 * rel + 0.15 * ending : 0.85 * engine + 0.15 * ending };
}
// the words of the one-line human story, for the plain TF-IDF comparison in index.ts
export const heartText = (h: Heart) => (h.story + " " + h.conflict).trim();
// readable words for the app: "a father and daughter · a promise to keep"
export const heartWords = (h: Heart, max = 3): string[] => [...h.rel.filter((r) => r !== "alone").slice(0, 1), ...h.engine.slice(0, 2)].map((t) => LABEL[t] || t).slice(0, max);
export const sharedHeartWords = (seed: Heart, others: Heart[], share = 0.5, max = 3): string[] => {
  if (others.length < 3) return [];
  return [...seed.engine.slice(0, 3), ...seed.rel.filter((r) => r !== "alone").slice(0, 2)]
    .filter((t) => others.filter((o) => [...o.engine, ...o.rel].some((x) => sim(t, x) >= 0.6)).length / others.length >= share)
    .slice(0, max).map((t) => LABEL[t] || t);
};

// ---------- the Gemini call ----------
export const heartOn = () => !!Deno.env.get("GEMINI_API_KEY");
const SYSTEM = `You describe the HUMAN HEART of films and series for a recommender. Ignore genre, setting and plot devices (space, heist, magic, a murder). Say what the story is really about emotionally: who the central relationship is between, what drives the main character inside, and what choice or conflict they face.
Think like this: Interstellar = a father and daughter, a promise, time lost (not "sci-fi"). Manchester by the Sea = remorse and grief that cannot be fixed. Drishyam = an ordinary father hides a crime to protect his family. Kabir Singh = obsessive love that destroys the lover. Ocean's Eleven = the pleasure of a clever scheme and a crew.
For EACH film return one JSON object with exactly these keys:
"id": the number given,
"rel": 1-3 tags for the central relationship, most important first, ONLY from: ${REL.join(", ")},
"engine": 1-3 tags for the emotional engine / what drives the story, most important first, ONLY from: ${ENGINE.join(", ")},
"ending": 1-2 tags for how it leaves you, ONLY from: ${ENDING.join(", ")},
"story": ONE sentence (max 30 words) of the human story with NO genre words and NO character names, e.g. "A father leaves his daughter to save humanity and tries to keep his promise to come back.",
"conflict": the central dilemma in under 15 words,
"world": 1-3 plain words for the surface setting or device (e.g. space, heist, small town).
Return ONLY a JSON array of these objects, nothing else.`;

let goodModel = "";
const MODELS = () => [...new Set([goodModel, Deno.env.get("GEMINI_MODEL") || "", "gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-flash-latest"].filter(Boolean))];

// ---------- Gemini budget: the similar-titles features come FIRST, the "is it streaming?" check only uses what is left ----------
// - while any similar-titles call is running, an availability check is not started (it answers "busy", is not saved, and is asked again later)
// - after a 429 (from either), availability stays quiet for AVAIL_PAUSE_MS
// - availability calls are spaced AVAIL_GAP_MS apart, and at most 2 wait in line
let simActive = 0, pausedUntil = 0, lastAvailAt = 0, availWaiting = 0;
const AVAIL_GAP_MS = 8_000, AVAIL_PAUSE_MS = 5 * 60_000;
export const gemPausedUntil = () => pausedUntil;
export async function callGemini(prompt: string, system: string = SYSTEM): Promise<{ text?: string; error?: string; limited?: boolean }> {
  simActive++;
  try {
    const r = await callGeminiRaw(prompt, system);
    if (r.limited) pausedUntil = Math.max(pausedUntil, Date.now() + AVAIL_PAUSE_MS);
    return r;
  } finally { simActive--; }
}
async function callGeminiRaw(prompt: string, system: string = SYSTEM): Promise<{ text?: string; error?: string; limited?: boolean }> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return { error: "no GEMINI_API_KEY" };
  let last = "";
  for (const model of MODELS()) {
    for (const thinking of [true, false]) { // some models do not take the thinking setting: then ask again without it
      const gen: Record<string, unknown> = { temperature: 0.2, responseMimeType: "application/json", maxOutputTokens: 4096 };
      if (thinking) gen.thinkingConfig = { thinkingBudget: 0 };
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: gen }),
          signal: AbortSignal.timeout(40_000),
        });
        if (r.status === 429) return { error: "Gemini rate limit (429)", limited: true };
        if (r.status === 404) { last = model + ": not found"; break; } // next model
        if (!r.ok) { last = model + ": HTTP " + r.status + " " + (await r.text()).slice(0, 160); if (r.status === 400 && thinking) continue; break; }
        const j = await r.json();
        const text = (j?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("");
        if (text) { goodModel = model; return { text }; }
        last = model + ": empty answer";
        break;
      } catch (e) { last = model + ": " + String((e as Error)?.message || e); break; }
    }
  }
  return { error: last || "Gemini failed" };
}

const pick = (a: unknown, allowed: string[], max: number): string[] =>
  (Array.isArray(a) ? a : []).map((x) => String(x || "").toLowerCase().trim().replace(/[\s-]+/g, "_")).filter((x) => allowed.includes(x)).filter((x, i, arr) => arr.indexOf(x) === i).slice(0, max);
const str = (s: unknown, n: number) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
export function parseHearts(text: string): Map<number, Heart> {
  const out = new Map<number, Heart>();
  let j: any;
  try { j = JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()); } catch { return out; }
  for (const o of Array.isArray(j) ? j : Array.isArray(j?.films) ? j.films : []) {
    const id = Number(o?.id);
    if (!id) continue;
    const h: Heart = { rel: pick(o.rel, REL, 3), engine: pick(o.engine, ENGINE, 3), ending: pick(o.ending, ENDING, 2), story: str(o.story, 240), conflict: str(o.conflict, 140),
      world: (Array.isArray(o.world) ? o.world : []).map((x: unknown) => str(x, 24)).filter(Boolean).slice(0, 3) };
    if (h.engine.length || h.rel.length) out.set(id, h); // an answer with no tag at all is useless
  }
  return out;
}

export type HeartIn = { id: number; title: string; year: string; genres: string; keywords: string; plot: string };
// asks for the hearts of these films, 6 per call, up to 3 calls at the same time
export async function fetchHearts(films: HeartIn[]): Promise<{ map: Map<number, Heart>; error?: string }> {
  const map = new Map<number, Heart>();
  if (!films.length) return { map };
  const chunks: HeartIn[][] = [];
  for (let i = 0; i < films.length; i += 6) chunks.push(films.slice(i, i + 6));
  let error: string | undefined;
  let stop = false;
  const one = async (c: HeartIn[]) => {
    if (stop) return;
    const prompt = c.map((f) => `### id ${f.id}: ${f.title}${f.year ? " (" + f.year + ")" : ""}\nGenres: ${f.genres}\nKeywords: ${f.keywords}\nPlot and reception: ${f.plot}`).join("\n\n");
    let r = await callGemini(prompt);
    if (r.limited) { await new Promise((res) => setTimeout(res, 2500)); r = await callGemini(prompt); }
    if (r.limited) stop = true;
    if (r.error || !r.text) { error ??= r.error || "empty"; return; }
    for (const [id, h] of parseHearts(r.text)) map.set(id, h);
  };
  for (let i = 0; i < chunks.length; i += 3) await Promise.all(chunks.slice(i, i + 3).map(one));
  return { map, error };
}

// ---------- films with the same heart: Gemini knows far more films than TMDB's "similar" lists show ----------
const SUGGEST_SYSTEM = `You are a film expert who recommends by emotional experience, not by genre. Given one film or series and its "heart", name titles that give a viewer the SAME emotional experience, even in a completely different genre or setting (a space film and a small-town drama can share a father-daughter promise). Mix famous and lesser-known titles. Never include the original, its sequels or remakes. Only real titles with the correct release year. Return ONLY a JSON array like [{"title":"...","year":2013}], no other text.`;
export async function suggestTitles(f: { title: string; year: string; kind: string; story: string; rel: string[]; engine: string[]; ending: string[] }, scope: "any" | "world", langName: string, n = 18): Promise<{ titles: { title: string; year: number }[]; error?: string }> {
  const what = f.kind === "tv" ? "TV series" : "films";
  const prompt = `Original: ${f.title}${f.year ? " (" + f.year + ")" : ""}\nIts heart: ${f.rel.map((t) => LABEL[t] || t).join(", ")}; drive: ${f.engine.map((t) => LABEL[t] || t).join(", ")}; it leaves you ${f.ending.join(", ")}.\nHuman story: ${f.story}\n\nName ${n} ${what} with the same heart.` +
    (scope === "world" ? ` ONLY ${what} whose original language is NOT ${langName}: world cinema (French, Korean, Japanese, Spanish, Italian, Hindi, Malayalam, German and so on).` : "");
  const r = await callGemini(prompt, SUGGEST_SYSTEM);
  if (r.error || !r.text) return { titles: [], error: r.error || "empty" };
  let j: any;
  try { j = JSON.parse(r.text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()); } catch { return { titles: [], error: "bad JSON" }; }
  const titles = (Array.isArray(j) ? j : []).map((o: any) => ({ title: str(o?.title, 120), year: Number(o?.year) || 0 })).filter((o: { title: string }) => o.title).slice(0, n);
  return { titles };
}

// ---------- a person's filmography (person page, last fallback after TMDB and Wikidata) ----------
// Gemini only NAMES titles; the function checks every one on TMDB (title and year must match) before the app sees it.
const FILMO_SYSTEM = `You are an expert on world cinema, above all Indian cinema (Malayalam, Tamil, Telugu, Kannada, Hindi). List the feature films and TV series a given person worked on in a given role. Rules: only titles you are sure are real, with the correct release year; never invent or guess; no talk shows, award shows, concerts or reality TV; one entry per title; most recent first. Return ONLY a JSON array like [{"title":"...","year":2019,"type":"movie"}] where type is "movie" or "tv". At most 60 entries.`;
export async function askFilmography(p: { name: string; role: string; born: string; known: string[] }): Promise<{ titles: { title: string; year: number; type: string }[]; error?: string }> {
  const prompt = `Person: ${p.name}${p.born ? " (born " + p.born + ")" : ""}\nRole: ${p.role}\n` +
    (p.known.length ? `Titles this exact person is already known for (only to identify who is meant): ${p.known.join("; ")}\n` : "") + `\nList their ${p.role} credits.`;
  const r = await callGemini(prompt, FILMO_SYSTEM);
  if (r.error || !r.text) return { titles: [], error: r.error || "empty" };
  let j: any;
  try { j = JSON.parse(r.text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()); } catch { return { titles: [], error: "bad JSON" }; }
  const titles = (Array.isArray(j) ? j : []).map((o: any) => ({ title: str(o?.title, 120), year: Number(o?.year) || 0, type: o?.type === "tv" ? "tv" : "movie" }))
    .filter((o: { title: string; year: number }) => o.title && o.year >= 1930 && o.year <= new Date().getFullYear() + 2).slice(0, 60);
  return { titles };
}

// ---------- is this title streaming RIGHT NOW? Gemini with live Google Search (last fallback after TMDB and Wikidata) ----------
// Search grounding cannot be combined with JSON mode, so the answer is asked as JSON in plain text and parsed here.
const AVAIL_SYSTEM = `You check where a film or series can be watched RIGHT NOW, using Google Search. Look at JustWatch first: its pages are justwatch.com/<country code>/movie/<title-slug> (or /tv-show/). Use only what the pages you find say today; never guess from the release date or from older articles. "stream" = included with a subscription, "free" = free with ads, "rent" / "buy" = store. Return ONLY JSON like {"entries":[{"country":"IN","service":"Prime Video","type":"stream"}]}. If you find no page that lists the title as available, return {"entries":[]}.`;
const AVAIL_SOURCES = ["justwatch.com", "themoviedb.org", "imdb.com", "reelgood.com", "flixpatrol.com", "primevideo.com", "amazon.", "netflix.com", "hotstar.com", "disneyplus.com", "apple.com", "sonyliv.com", "zee5.com", "hulu.com", "max.com", "peacocktv.com", "paramountplus.com", "jiocinema.com", "wikipedia.org"];
export type Avail = { country: string; service: string; type: string };
// choose the best entry (stream > free > rent > buy, India first) but ONLY if the search really used a known source
export function pickAvail(text: string, domains: string[]): { avail?: Avail; entries?: Avail[]; sources: string[]; error?: string } {
  const sources = domains.map((d) => d.toLowerCase()).filter((d) => AVAIL_SOURCES.some((a) => d.includes(a)));
  // An answer that did not really search (no known source), or that cannot be read, is an ERROR, not a "not available": it is not saved and is asked again.
  if (!sources.length) return { sources: [], error: "the search used no streaming guide" };
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { sources, error: "answer had no JSON" };
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return { sources, error: "answer was not valid JSON" }; }
  const rank: Record<string, number> = { stream: 0, free: 1, rent: 2, buy: 3 };
  const entries: Avail[] = (Array.isArray(j?.entries) ? j.entries : []).map((e: any) => ({
    country: String(e?.country || "").toUpperCase().slice(0, 2), service: str(e?.service, 40), type: String(e?.type || "").toLowerCase(),
  })).filter((e: Avail) => /^[A-Z]{2}$/.test(e.country) && e.service && e.type in rank);
  entries.sort((a, b) => rank[a.type] - rank[b.type] || (a.country === "IN" ? 0 : 1) - (b.country === "IN" ? 0 : 1));
  return { avail: entries[0], entries, sources };
}
type AvailOut = { avail?: Avail; entries?: Avail[]; sources: string[]; error?: string };
export async function askAvailability(t: { title: string; year: string; kind: string; today: string }): Promise<AvailOut> {
  const rest = pausedUntil - Date.now();
  if (rest > 0) return { sources: [], error: `Gemini is resting after a rate limit (${Math.ceil(rest / 60_000)} min); similar titles come first` };
  if (simActive > 0) return { sources: [], error: "Gemini is busy with similar titles; try again in a minute" };
  if (availWaiting >= 2) return { sources: [], error: "another streaming check is waiting; try again shortly" };
  availWaiting++;
  try {
    const slot = Math.max(Date.now(), lastAvailAt + AVAIL_GAP_MS); // reserve a time slot so checks never fire together
    lastAvailAt = slot;
    if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
    if (simActive > 0) return { sources: [], error: "Gemini is busy with similar titles; try again in a minute" };
    const out = await askAvailabilityRaw(t);
    if (out.error && /429/.test(out.error)) pausedUntil = Math.max(pausedUntil, Date.now() + AVAIL_PAUSE_MS);
    return out;
  } finally { availWaiting--; }
}
async function askAvailabilityRaw(t: { title: string; year: string; kind: string; today: string }): Promise<AvailOut> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return { sources: [], error: "no GEMINI_API_KEY" };
  const prompt = `Title: ${t.title}${t.year ? " (" + t.year + ")" : ""} (${t.kind === "tv" ? "TV series" : "film"}). Today is ${t.today}.\nCheck JustWatch for this title in these countries and report where it is available right now: IN, US, GB, CA, AU, DE, FR, ES, IT, AE, SG, JP, KR, BR, MX. For example justwatch.com/in/movie/... for India.`;
  let last = "";
  for (const model of MODELS()) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: AVAIL_SYSTEM }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1, maxOutputTokens: 2048 } }),
        signal: AbortSignal.timeout(40_000),
      });
      if (r.status === 429) return { sources: [], error: "Gemini rate limit (429)" };
      if (!r.ok) { last = model + ": HTTP " + r.status; continue; } // this model may not take the search tool: next one
      const j = await r.json();
      const cand = j?.candidates?.[0];
      const text = (cand?.content?.parts || []).map((p: any) => p?.text || "").join("");
      const domains = ((cand?.groundingMetadata?.groundingChunks || []) as any[]).map((c) => String(c?.web?.title || c?.web?.uri || ""));
      if (text) { goodModel = model; return pickAvail(text, domains); } // pickAvail may return an error (unsearched or unreadable answer)
      last = model + ": empty answer";
    } catch (e) { last = model + ": " + String((e as Error)?.message || e); }
  }
  return { sources: [], error: last || "Gemini failed" };
}
