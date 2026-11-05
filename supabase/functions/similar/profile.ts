// profile.ts: a "DNA" for every title, read from several angles, and a match score per angle. Plain rules, no AI, no network.
//
// A person judging "is this like that?" does not use one number. They ask: is it ABOUT the same thing (theme, plot), does it FEEL the
// same (mood, pace, emotional effect), does it LOOK the same (cinematography, style), is it TOLD the same way (structure), and is it
// made by the same hands (director, writer, composer, cinematographer)? theme.ts covers the subject; this file covers the rest.
//
// Each angle is a small vector of "traits" counted in the title's text (TMDB summary + keywords, Wikipedia plot / reception, user reviews).
// Two titles are compared angle by angle. An angle where the ORIGINAL has no signal is left out (unknown, not rewarded), so a title is
// never marked down or up for something nobody wrote about.
//
// matchOf() turns the angles into one match % and a count of how many angles agree. index.ts uses the angles as score features and the
// "strong match" gate (a title is a strong match when enough angles agree), and shows the % and the best shared angles in the app.

import { clamp } from "./logic.ts";

export type Angle = "mood" | "pace" | "look" | "form" | "feel";
export const ANGLES: Angle[] = ["mood", "pace", "look", "form", "feel"];
export const ANGLE_LABEL: Record<Angle, string> = { mood: "mood", pace: "pace", look: "visual style", form: "storytelling", feel: "emotional effect" };

type Lex = { id: string; re: RegExp; label: string };
const L = (id: string, label: string, src: string): Lex => ({ id, label, re: new RegExp("(?:" + src + ")", "gi") });

// ---- MOOD: the atmosphere (what the film breathes like) ----
const MOOD: Lex[] = [
  L("melancholy", "melancholic", "melanchol|wistful|bittersweet|longing|sorrow|elegiac|yearning|nostalgi|aching|lonel"),
  L("tense", "tense", "tense|tension|suspense|edge of (?:your|my) seat|nail[- ]biting|anxious|paranoi|dread|claustrophob"),
  L("bleak", "bleak", "bleak|grim|nihilis|hopeless|despair|desolat|downbeat|depressing|soul[- ]crushing"),
  L("eerie", "eerie", "eerie|haunting|unsettling|creepy|ominous|sinister|uncanny|spooky|chilling|disquiet"),
  L("warm", "warm", "warm|heartwarming|gentle|tender|cosy|cozy|wholesome|comforting|sweet|charming|feel[- ]good"),
  L("playful", "playful", "playful|whimsical|quirky|zany|lighthearted|fun\\b|breezy|goofy|cheeky|offbeat"),
  L("sensual", "sensual", "sensual|erotic|intimate|steamy|passionate|sultry|languid"),
  L("gritty", "gritty", "gritty|raw\\b|rough|street[- ]level|hard[- ]hitting|unflinching|visceral|brutal"),
  L("dreamy", "dreamlike", "dreamlike|dreamy|ethereal|hypnotic|surreal|lyrical|poetic|trance"),
  L("epic", "epic", "epic|sweeping|grand|majestic|monumental|operatic|larger[- ]than[- ]life"),
  L("satire", "darkly funny", "dark comedy|black comedy|satir|sardonic|deadpan|tongue[- ]in[- ]cheek|wry"),
  L("hopeful", "hopeful", "hopeful|uplifting|inspiring|redemptive|optimistic|triumph|life[- ]affirming"),
];
// ---- PACE: how it moves ----
const PACE: Lex[] = [
  L("slow", "slow-burn", "slow[- ]?burn|slow[- ]paced|slowly|deliberate|meditative|methodical|unhurried|patient|contemplative|languid|restrained|quiet\\b"),
  L("fast", "fast-paced", "fast[- ]paced|gripping|relentless|breathless|non[- ]?stop|adrenaline|pulse[- ]pounding|propulsive|kinetic|rollercoaster|frenetic"),
  L("even", "steady", "well[- ]paced|steady|measured|balanced pacing|tight(?:ly)? (?:paced|edited|plotted)"),
  L("drag", "long and uneven", "overlong|too long|drags|dragged|meandering|padded|uneven pacing|second half"),
];
// ---- LOOK: cinematography and style ----
const LOOK: Lex[] = [
  L("lush", "lush, painterly images", "cinematograph|beautifully shot|gorgeous(?:ly)? (?:shot|photograph)|painterly|visually (?:stunning|striking|beautiful|rich)|stunning visuals|lush|sun[- ]drenched|landscape|scenery|picturesque|golden hour"),
  L("noir", "noir shadows", "noir|chiaroscuro|shadowy|low[- ]key lighting|rain[- ]soaked|moody lighting|dimly lit|neo[- ]noir|black[- ]and[- ]white|monochrome"),
  L("neon", "neon and stylised colour", "neon|stylis|stylized|saturated|colou?rful palette|candy|pop[- ]art|visual flair|slick|glossy|music[- ]video"),
  L("handheld", "handheld, documentary look", "handheld|hand[- ]held|documentary[- ]style|vérité|verite|shaky|cinéma vérité|naturalistic lighting|natural light|found footage|grainy|16mm|35mm grain"),
  L("longtake", "long takes", "long takes?|single[- ]take|one[- ]take|tracking shot|unbroken shot|oner\\b|steadicam"),
  L("static", "still, composed frames", "static (?:camera|shots?)|symmetr|composed frames?|tableau|wide shots?|minimalist|austere|stark|painstaking(?:ly)? composed"),
  L("action_shot", "kinetic action photography", "stunts?|choreograph|set[- ]pieces?|fight scenes?|car chase|shootout|practical effects|action sequences?"),
  L("vfx", "big visual effects", "special effects|\\bcgi\\b|visual effects|\\bvfx\\b|world[- ]?building|spectacle|production design|set design"),
  L("score", "a standout score", "score|soundtrack|background music|composer|needle[- ]drop|songs?\\b|sound design|synth"),
  L("period_look", "period production design", "period (?:detail|setting|costume|accurate)|costume|production design|1[89]\\d0s|vintage|retro|authentic setting"),
];
// ---- FORM: how the story is told ----
const FORM: Lex[] = [
  L("twist", "twists and reveals", "twist|reveal|unpredictable|shocking ending|plot twist|mind[- ]?bending|jaw[- ]dropping|surpris(?:e|ing) ending|rug pulled"),
  L("nonlinear", "non-linear telling", "non[- ]?linear|flashback|time[- ]jump|timeline|fragmented|chronolog|told in (?:reverse|chapters)|multiple timelines?|parallel stor"),
  L("ensemble", "an ensemble of characters", "ensemble|multiple (?:storylines|narratives|characters)|interweav|intersecting|interlocking|anthology|hyperlink"),
  L("character", "a close character study", "character study|character[- ]driven|portrait of|inner life|intimate (?:drama|portrait)|slice of life|two[- ]hander"),
  L("contained", "one place, one pressure", "single location|one location|contained|bottle (?:episode|film|thriller)|chamber piece|claustrophob|one night|real[- ]time|stage[- ]bound"),
  L("unreliable", "an unreliable narrator", "unreliable narrat|ambigu|open[- ]ended|interpretation|puzzle|cryptic|enigmatic|leaves? (?:you|viewers) (?:guessing|wondering)"),
  L("procedural", "a procedural, case-by-case build", "procedural|case of the week|investigat|clues|detective work|whodunit|slow reveal of the truth"),
  L("true", "rooted in true events", "true story|based on (?:a )?true|real events|real[- ]life events|inspired by (?:a )?true|biograph|biopic|docudrama"),
  L("satirical", "social satire", "satir|social commentary|allegor|critique of|class (?:divide|satire)|political (?:satire|allegory)"),
  L("saga", "a multi-year saga", "saga|generations?|decades|over the years|spanning|rise and fall|dynasty|epic scope"),
  L("coming", "a coming-of-age arc", "coming[- ]of[- ]age|growing up|first love|adolescen|rite of passage|teenage|childhood"),
];
// ---- FEEL: what it does to the viewer ----
const FEEL: Lex[] = [
  L("cry", "emotionally devastating", "emotional|heartbreaking|tearjerker|tear[- ]jerking|moving|cried|had me crying|poignant|devastating|gut[- ]punch|wept"),
  L("think", "thought-provoking", "thought[- ]provoking|philosoph|profound|layered|existential|makes you think|food for thought|stays with you|lingers"),
  L("thrill", "pulse-raising", "edge of (?:your|my) seat|gripping|thrilling|nail[- ]biting|heart[- ]pounding|white[- ]knuckle|can't look away|binge"),
  L("laugh", "laugh-out-loud", "hilarious|laugh|funny|comic timing|gags|riotous|witty|had me laughing"),
  L("disturb", "disturbing", "disturbing|unsettling|haunting|shocking|difficult to watch|traumati|harrowing|upsetting|stomach[- ]churning"),
  L("comfort", "comforting", "comfort|feel[- ]good|heartwarming|uplifting|rewatch|cosy|cozy|smile|joyful|delightful"),
  L("awe", "awe-inspiring", "awe|breathtaking|majestic|spectacular|jaw[- ]dropping|transcendent|mesmeriz|spellbinding|immersive"),
  L("romantic", "swoony", "swoon|romantic|chemistry|love story|yearning|sparks|longing|passion"),
  L("rewatch", "built for rewatching", "rewatch|re-?watch|hidden details|on (?:a )?second (?:viewing|watch)|easter eggs|layers"),
];

const SETS: Record<Angle, Lex[]> = { mood: MOOD, pace: PACE, look: LOOK, form: FORM, feel: FEEL };

export type Dna = { [A in Angle]: number[] } & { len: number }; // len: runtime in minutes (0 unknown), used for a small pace hint only

// how often each trait appears. Counts are damped (sqrt) so one long review cannot drown the rest.
// Every title has genres even when nobody wrote about it (regional films have almost no reviews). A genre says a little about mood, feel and look,
// so it is added as a light hint in words the lists above already know. It never decides alone: it only gives thin titles a few angles to compare.
const GENRE_HINT: Record<number, string> = {
  35: "playful funny", 18: "emotional character study", 10749: "romantic swoon", 53: "tense suspense gripping", 80: "gritty crime", 9648: "mystery clues tense",
  27: "eerie scary", 878: "world-building visual effects", 14: "epic sweeping", 12: "epic spectacle", 28: "action stunts fast-paced", 10752: "epic gritty",
  16: "colourful palette stylized", 10402: "soundtrack score", 36: "period costume", 37: "landscape", 10751: "warm feel-good", 99: "documentary-style", 10759: "action stunts", 10765: "world-building",
};
export const genreHint = (ids: number[]) => ids.map((g) => GENRE_HINT[g] || "").join(" ");
export function dna(text: string, runtime = 0, genres: number[] = []): Dna {
  const t = String(text || "") + " " + genreHint(genres);
  const out = { len: runtime || 0 } as Dna;
  for (const a of ANGLES) out[a] = SETS[a].map((x) => Math.sqrt((t.match(x.re) || []).length));
  return out;
}
const mass = (v: number[]) => v.reduce((s, x) => s + x, 0);
export const hasSignal = (d: Dna, a: Angle, min = 1.6) => mass(d[a]) >= min;

// Cosine on the traits, with traits that nearly every title in the pool shares counting for less (idf over the pool, seed included).
// Returns per candidate a 0..1 score per angle, or -1 when the original has no signal in that angle or the candidate has none (unknown).
export function matchAngles(seed: Dna, cands: Dna[]): Record<Angle, number>[] {
  const res = cands.map(() => ({} as Record<Angle, number>));
  for (const a of ANGLES) {
    const k = SETS[a].length;
    const all = [seed[a], ...cands.map((c) => c[a])];
    const N = all.length;
    const idf = Array.from({ length: k }, (_, i) => Math.log((N + 1) / (all.filter((v) => v[i] > 0).length + 0.5)));
    const vec = (v: number[]) => { const w = v.map((c, i) => c * idf[i]); return { w, n: Math.sqrt(w.reduce((s, x) => s + x * x, 0)) }; };
    const s = vec(seed[a]);
    const seedKnown = mass(seed[a]) >= 1.6 && s.n > 0;
    const raw = cands.map((c) => {
      if (!seedKnown || mass(c[a]) < 1) return -1;
      const v = vec(c[a]);
      return v.n > 0 ? v.w.reduce((d, x, i) => d + x * s.w[i], 0) / (s.n * v.n) : -1;
    });
    // raw cosines bunch together: blend the value with the rank among the known ones (as story and vibe do in index.ts)
    const known = raw.map((v, i) => [v, i] as [number, number]).filter(([v]) => v >= 0).sort((x, y) => x[0] - y[0]);
    const pct = new Array(cands.length).fill(-1);
    known.forEach(([, i], r) => { pct[i] = known.length > 1 ? r / (known.length - 1) : 0.5; });
    cands.forEach((_, i) => { res[i][a] = raw[i] < 0 ? -1 : clamp(0.55 * clamp(raw[i] / 0.75) + 0.45 * pct[i]); });
  }
  return res;
}

// The angles that count as one "match" number, with how much each matters. Subject (theme, plot) matters most and is passed in from index.ts.
export const ANGLE_W: Record<Angle, number> = { mood: 0.22, feel: 0.2, look: 0.14, form: 0.14, pace: 0.1 };
export const AGREE_AT = 0.55; // an angle "agrees" from this score up

export type Match = {
  pct: number;          // 0..100, the match shown in the app
  agree: number;        // how many of the known angles agree (subject angles included)
  known: number;        // how many angles could be judged at all
  strong: boolean;      // enough angles agree: this is the gate for the main list
  gate: number;         // 0 strong, small when it cannot be judged, larger only when the angles clearly DISAGREE
  best: string[];       // up to 3 plain-words reasons ("mood: melancholic", "same director" ...)
};

export type Subject = { theme: number; story: number; core: number; kw: number; hasTheme: boolean; heart?: boolean };
export type Craft = { dir: number; cast: number; dp: number };

// One number from every angle. Subject angles (theme, story) carry 50%, the feel angles 40%, the people 10%. An unknown angle drops out and the
// weights of the rest are renormalised, so a film with little text is judged on what is known, but "strong" also needs MIN_KNOWN angles.
const MIN_KNOWN = 3;
export function matchOf(sub: Subject, ang: Record<Angle, number>, craft: Craft): Match {
  const parts: { id: string; v: number; w: number }[] = [];
  const hw = sub.heart && sub.hasTheme; // the heart match is known: it carries most of the match %
  if (sub.hasTheme) { parts.push({ id: "theme", v: 0.6 * sub.theme + 0.4 * sub.core, w: hw ? 0.55 : 0.3 }); }
  parts.push({ id: "story", v: Math.max(sub.story, sub.kw * 0.8), w: hw ? 0.1 : 0.2 });
  for (const a of ANGLES) if (ang[a] >= 0) parts.push({ id: a, v: ang[a], w: ANGLE_W[a] * (hw ? 0.25 : 0.4) / 0.8 });
  const people = Math.max(craft.dir, craft.dp * 0.8, craft.cast * 0.5);
  if (people > 0) parts.push({ id: "people", v: Math.min(1, people), w: 0.1 });
  const wsum = parts.reduce((s, p) => s + p.w, 0) || 1;
  const judged = parts.filter((p) => p.id !== "people");
  const raw = Math.round(100 * parts.reduce((s, p) => s + p.v * p.w, 0) / wsum);
  const pct = judged.length < MIN_KNOWN ? Math.min(raw, 60) : raw; // too little text to judge: never shown as a high match
  const agree = judged.filter((p) => p.v >= AGREE_AT).length;
  const subjectOk = (!sub.hasTheme || sub.core >= 0.35) && (sub.theme >= 0.3 || sub.story >= 0.45 || sub.kw >= 0.2);
  // Three outcomes, so thin titles are not wiped out: strong (no push-down), cannot judge or half-agree (small push-down), clear disagreement (the big push-down).
  const enough = judged.length >= MIN_KNOWN;
  const need = Math.max(2, Math.ceil(judged.length * 0.4));
  const strong = subjectOk && (enough ? agree >= need && pct >= 55 : raw >= 55);
  const clash = enough && agree <= Math.floor(judged.length * 0.25) && raw < 48;
  const gate = strong ? 0 : clash || !subjectOk ? 0.9 : 0.2;
  const best: string[] = [];
  if (craft.dir >= 1) best.push("same director"); else if (craft.dp >= 1) best.push("same cinematographer");
  if (sub.hasTheme && sub.core >= 0.9) best.push("same core subject");
  const ranked = ANGLES.filter((a) => ang[a] >= AGREE_AT).sort((a, b) => ang[b] - ang[a]);
  for (const a of ranked.slice(0, 3)) best.push(ANGLE_LABEL[a]);
  return { pct, agree, known: judged.length, strong, gate, best: best.slice(0, 3) };
}

// The dominant traits of the original, in words: "melancholic · slow-burn · lush, painterly images" (shown above the list).
export function describe(d: Dna, per = 1, max = 4): string[] {
  const out: { t: string; v: number }[] = [];
  for (const a of ANGLES) {
    if (!hasSignal(d, a)) continue;
    SETS[a].map((x, i) => ({ t: x.label, v: d[a][i] })).filter((x) => x.v >= 1.4).sort((x, y) => y.v - x.v).slice(0, per).forEach((x) => out.push(x));
  }
  return out.sort((a, b) => b.v - a.v).slice(0, max).map((x) => x.t);
}

// ---- the people behind the camera, now with the cinematographer ----
export type People = { d: number[]; w: number[]; m: number[]; p: number[] }; // directors, writers, composers, directors of photography
export function craftMatch(a: People, b: People, castShared: number): Craft {
  const hit = (x: number[], y: number[]) => (x.some((i) => y.includes(i)) ? 1 : 0);
  return { dir: clamp(hit(a.d, b.d) + 0.5 * hit(a.w, b.w) + 0.3 * hit(a.m, b.m)), dp: hit(a.p, b.p), cast: clamp(castShared / 2) };
}
