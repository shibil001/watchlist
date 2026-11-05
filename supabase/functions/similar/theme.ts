// theme.ts: a plain-rules "what is this film ABOUT" matcher. No AI, no network, easy to read and to test.
//
// How a person judges "similar": first the SUBJECT (a gay summer romance, a prison escape, a brothers-and-the-city tragedy), then the
// kind of people and the setting, then the feel. Popularity and "people also liked" come last. The older scoring leaned on popularity
// lists and raw keyword ids, which is how Forrest Gump got into the list of Call Me by Your Name.
//
// Here every film becomes a THEME PROFILE: ~45 themes, each 0..1, found in its TMDB keywords (strong) and its plot text (weaker).
// Two films are compared on their themes: how much of the original's themes the other has (recall), how much of the other's themes
// the original has (precision), whether the other has the original's 1-2 CORE themes at all (the gate), and whether it carries a
// theme that clashes (an elderly-couple drama for a teenage romance, a heist caper for a family drama).

export type Profile = Record<string, number>;
type Def = { id: string; w: number; re: RegExp; anti?: boolean };
// w = how telling the theme is (rare and specific subjects count more than "romance" or "family")
const D = (id: string, w: number, src: string, anti = false): Def => ({ id, w, re: new RegExp("\\b(?:" + src + ")", "i"), anti });
export const THEMES: Def[] = [
  D("lgbtq", 1.0, "gay\\b|lesbian|queer|homosexual|bisexual|same[- ]sex|lgbt|transgender|coming out|closeted|homophob|gay theme|gay romance"),
  D("first_love", 0.9, "first love|young love|first crush|teenage romance|summer romance|first kiss|first relationship|sexual awakening|infatuation"),
  D("coming_of_age", 0.8, "coming[- ]of[- ]age|adolescen|teenage|teenager|growing up|puberty|seventeen[- ]year|sixteen[- ]year|eighteen[- ]year|fifteen[- ]year"),
  D("forbidden_love", 0.7, "forbidden (?:love|romance|relationship)|secret (?:love|affair|romance|relationship)|illicit|star[- ]crossed|extramarital|affair\\b"),
  D("tragic_romance", 0.55, "tragic (?:love|romance)|doomed|heartbreak|heartbroken|unrequited|lost love|love triangle|obsessive love|obsession"),
  D("romance", 0.25, "romance|romantic|love story|in love|falls? in love|lovers?\\b"),
  D("summer_setting", 0.55, "summer|vacation|holiday|villa\\b|beach|seaside|riviera|countryside|tuscan|island"),
  D("period_piece", 0.3, "period (?:drama|piece)|18th century|19th century|victorian|regency|1[89]\\d0s|historical"),
  D("grief_loss", 0.5, "grief|mourning|bereave|death of|terminal|widow|funeral"),
  D("family_drama", 0.3, "family drama|dysfunctional family|family secret|father[- ]son|mother[- ]daughter|parent"),
  D("fatherhood_legacy", 0.9, "fatherhood|father[- ]son|father and son|fathers and sons|absent father|abandon\\w* (?:son|child)|his (?:son|father)|their sons|paternal|illegitimate (?:son|child)|biological (?:son|father)|sins of the (?:father|past)|raising (?:a |his )?(?:son|child)"),
  D("generations", 0.5, "years later|decades later|years after|next generation|generation|legacy|inherit|descendant|haunted by the past|past comes back"),
  D("guilt_consequence", 0.7, "guilt|consequence|redemption|remorse|regret|atone|atonement|moral (?:dilemma|choice|compromise)|corrupt (?:cop|police)|cover[- ]?up"),
  D("small_town", 0.5, "small[- ]town|rust belt|blue[- ]collar|rural|working[- ]class town|backwoods"),
  D("action_spectacle", 0.6, "car chase|martial arts|shootout|explosion|parkour|bike messenger|action hero|action thriller|kung fu|one[- ]man army", true),
  D("brotherhood", 0.7, "brother|sibling|twin"),
  D("marriage", 0.4, "marriage|married|wedding|divorce|husband|wife\\b|infidelity"),
  D("crime_underworld", 0.8, "gangster|mafia|\\bmob\\b|underworld|organi[sz]ed crime|crime boss|drug (?:lord|cartel|dealer)|cartel|criminal gang|\\bgangs?\\b|smuggl|don\\b"),
  D("police", 0.6, "police|\\bcops?\\b|detective|investigat|inspector|law enforcement"),
  D("murder_mystery", 0.7, "murder|serial kill|whodunit|\\bkiller|homicide|crime scene|missing person"),
  D("revenge", 0.7, "revenge|vengeance|vigilante|avenge|retribution"),
  D("heist", 0.9, "heist|robbery|burglar|bank robber|con (?:man|artist)|thieves|safe[- ]?crack", true),
  D("prison", 0.8, "prison|\\bjail|inmate|incarcerat|penitentiary"),
  D("war", 0.6, "\\bwar\\b|world war|soldier|battlefield|military|vietnam|\\barmy\\b|combat", true),
  D("political", 0.5, "politic|election|corrupt|government|minister|activis|protest"),
  D("courtroom", 0.8, "courtroom|\\btrial\\b|lawyer|attorney|legal drama|\\bjudge\\b|verdict"),
  D("horror", 0.8, "horror|haunted|ghost|demon|possess|exorcis|supernatural|occult|witch|vampire|zombie|slasher", true),
  D("sci_fi", 0.8, "sci[- ]?fi|science fiction|alien|space (?:travel|ship|station)|spacecraft|time travel|dystopia|artificial intelligence|robot|futuristic|post[- ]apocalyptic|astronaut", true),
  D("superhero", 0.9, "superhero|marvel|dc comics|super[- ]?power|comic book", true),
  D("animation_kids", 0.9, "animat|cartoon|talking animal|children's|fairy tale|\\btoys?\\b", true),
  D("slapstick", 0.5, "slapstick|spoof|parody|farce|satire|screwball|rom[- ]?com", true),
  D("music", 0.6, "music|singer|rock ?star|\\bband\\b|concert|guitar|composer|\\bsongs?\\b"),
  D("dance", 0.6, "dance|dancer|ballet"),
  D("sports", 0.8, "sport|boxing|boxer|football|soccer|cricket|athlete|olympic|championship|wrestl|basketball|baseball", true),
  D("biography", 0.5, "biograph|biopic|true story|real[- ]life"),
  D("friendship", 0.3, "friendship|best friends?|buddy"),
  D("road_trip", 0.6, "road trip|road movie|cross[- ]country"),
  D("migration", 0.6, "immigra|migrant|refugee|\\bexile|expatriate|diaspora|\\bgulf\\b"),
  D("poverty_class", 0.5, "poverty|\\bpoor\\b|working[- ]class|slum|class (?:divide|struggle)|homeless"),
  D("mental_health", 0.6, "mental (?:illness|health|disorder)|depress|schizophren|bipolar|suicid|anxiety|trauma|psychiatr|ptsd"),
  D("addiction", 0.6, "addict|alcoholi|drug abuse|substance abuse|overdose|self[- ]destruct"),
  D("religion", 0.5, "religio|\\bfaith\\b|priest|church|\\bnun\\b|\\bmonk\\b|temple|islam|muslim|christian|hindu|spiritual"),
  D("artist", 0.6, "painter|painting|artist|sculptor|poet|novelist|\\bwriter\\b|filmmaker|photograph|cinema|projectionist|film director|theat(?:re|er)"),
  D("school", 0.35, "school|teacher|professor|student|college|university|campus|classroom"),
  D("old_age", 0.8, "old age|elderly|dementia|alzheimer|\\bagei?ng\\b|retire|senior citizen|octogenarian|nursing home", true),
  D("survival", 0.7, "survival|stranded|wilderness|shipwreck|plane crash|castaway|lost at sea"),
  D("spy", 0.8, "\\bspy\\b|\\bspies\\b|espionage|secret agent|\\bcia\\b|\\bmi6\\b|assassin|intelligence agency", true),
  D("disability", 0.5, "disabilit|disabled|wheelchair|autis|down syndrome|\\bblind\\b|\\bdeaf\\b|low iq"),
  D("racism", 0.6, "racis|racial|african american|segregation|civil rights|apartheid|slavery"),
  D("western", 0.9, "western|cowboy|outlaw|frontier|wild west|gunslinger", true),
];
const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

const textHits = (re: RegExp, text: string) => (text.match(new RegExp(re.source, "gi")) || []).length;
// strength 0..1: keywords count most (1 hit .6, 2 hits 1), plot words add up to .7 (1 hit .3, 2 .5, 3+ .7)
export function themeProfile(kwNames: string[], text: string): Profile {
  const p: Profile = {};
  const t = String(text || "");
  for (const d of THEMES) {
    const kh = kwNames.reduce((n, k) => n + (d.re.test(k) ? 1 : 0), 0);
    const th = textHits(d.re, t);
    const s = Math.min(1, [0, 0.6, 1][Math.min(kh, 2)] + [0, 0.35, 0.6, 0.8][Math.min(th, 3)]);
    if (s > 0.05) p[d.id] = s;
  }
  return p;
}
// the 1-2 themes the film is mostly about (specific ones only: "romance" and "family" are never core)
export function coreThemes(p: Profile): string[] {
  return Object.entries(p)
    .filter(([id, s]) => s >= 0.5 && (BY_ID.get(id)?.w || 0) >= 0.4 && !BY_ID.get(id)?.anti)
    .sort((a, b) => b[1] * (BY_ID.get(b[0])?.w || 0) - a[1] * (BY_ID.get(a[0])?.w || 0))
    .slice(0, 2).map(([id]) => id);
}
// the TMDB keyword ids of the original that belong to a theme (used to ask TMDB for more films about the same subject)
export function themeKeywordIds(kws: [number, string][], themeId: string, max = 3): number[] {
  const d = BY_ID.get(themeId);
  return d ? kws.filter(([, k]) => d.re.test(k)).slice(0, max).map(([i]) => i) : [];
}
export type ThemeMatch = { has: boolean; theme: number; core: number; anti: number; core_ids: string[]; heart?: boolean };
export function themeMatch(seed: Profile, cand: Profile): ThemeMatch {
  const core_ids = coreThemes(seed);
  const seedList = Object.entries(seed).filter(([, s]) => s >= 0.3);
  if (!core_ids.length || !seedList.length) return { has: false, theme: 0, core: 0, anti: 0, core_ids };
  const w = (id: string) => BY_ID.get(id)?.w || 0.3;
  let rn = 0, rd = 0;
  for (const [id, s] of seedList) { rn += w(id) * Math.min(s, cand[id] || 0); rd += w(id) * s; }
  const recall = rd ? rn / rd : 0;
  let pn = 0, pd = 0;
  for (const [id, c] of Object.entries(cand)) if (c >= 0.5) { pn += w(id) * Math.min(seed[id] || 0, c); pd += w(id) * c; }
  const precision = pd ? pn / pd : 1;
  let core = core_ids.reduce((s, id) => s + Math.min(1, (cand[id] || 0) / 0.5), 0) / core_ids.length;
  // not about the core themes, but about another strong theme of the original (coming of age for a romance): partial credit
  if (core < 0.35 && seedList.some(([id, s]) => s >= 0.5 && (BY_ID.get(id)?.w || 0) >= 0.4 && !BY_ID.get(id)?.anti && (cand[id] || 0) >= 0.5)) core = 0.35;
  let anti = 0;
  for (const d of THEMES) if (d.anti && (cand[d.id] || 0) >= 0.5 && (seed[d.id] || 0) < 0.2) anti += 1;
  return { has: true, theme: Math.max(0, Math.min(1, 0.7 * recall + 0.3 * precision)), core: Math.min(1, core), anti, core_ids };
}
// the penalty: none of the core themes = 1.2, under half = 0.4, a clashing theme up to 1.5 more
export const themePen = (m: ThemeMatch) => (!m.has ? 0 : (m.core === 0 ? 1.2 : m.core < 0.5 ? 0.4 : 0) + Math.min(1.5, m.anti));

// ---------- "what connects them": the themes the original and most of its matches share, in plain words ----------
export const THEME_LABEL: Record<string, string> = {
  lgbtq: "LGBTQ love story", first_love: "first love", coming_of_age: "coming of age", forbidden_love: "forbidden or secret love",
  tragic_romance: "heartbreak and longing", romance: "romance", summer_setting: "summer or seaside setting", period_piece: "period setting",
  grief_loss: "grief and loss", family_drama: "family drama", fatherhood_legacy: "fathers and sons", generations: "legacy across generations", guilt_consequence: "guilt and consequences", small_town: "small-town life", action_spectacle: "action spectacle", brotherhood: "brothers and siblings", marriage: "marriage", crime_underworld: "crime underworld",
  police: "police and investigation", murder_mystery: "murder and mystery", revenge: "revenge", heist: "heists", prison: "prison", war: "war",
  political: "politics and power", courtroom: "courtroom", horror: "horror", sci_fi: "science fiction", superhero: "superheroes", animation_kids: "animation",
  slapstick: "comedy and satire", music: "music", dance: "dance", sports: "sports", biography: "a true story", friendship: "friendship",
  road_trip: "a journey", migration: "migration", poverty_class: "class and poverty", mental_health: "mental health", addiction: "addiction",
  religion: "faith and religion", artist: "artists and creators", school: "school life", old_age: "old age", survival: "survival", spy: "spies",
  disability: "disability", racism: "race and prejudice", western: "westerns",
};
// themes the original has (strength 0.3+) that at least `share` of the matches have too (0.4+), most telling first. Plain counting, no AI.
export function sharedThemes(seed: Profile, others: Profile[], share = 0.6, max = 4): string[] {
  if (others.length < 3) return [];
  return Object.entries(seed)
    .filter(([id, s]) => s >= 0.3 && THEME_LABEL[id] && others.filter((o) => (o[id] || 0) >= 0.4).length / others.length >= share)
    .sort((a, b) => b[1] * (BY_ID.get(b[0])?.w || 0.3) - a[1] * (BY_ID.get(a[0])?.w || 0.3))
    .slice(0, max).map(([id]) => THEME_LABEL[id]);
}
