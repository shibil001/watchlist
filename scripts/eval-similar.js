// Quality check for the "Similar taste" lists. Run it after every change to the scoring:
//     node scripts/eval-similar.js            (needs Node 18+ and config.js with SUPABASE_URL / SUPABASE_ANON_KEY)
// For each case it asks the deployed `similar` function for the list of one film and checks two things:
//   want  - titles that SHOULD be in the list (a hit counts when at least one of them shows)   avoid - titles that should NOT be there
// Edit CASES to your own taste: this is the only place where "good" and "bad" suggestions are written down.
// Idea (a small hit-rate harness with expected titles) comes from open-source recommender projects; the code is ours.
const fs = require("fs");
const cfg = fs.readFileSync(__dirname + "/../config.js", "utf8");
const pick = (k) => (cfg.match(new RegExp(k + "\\s*=\\s*\"([^\"]+)\"")) || [])[1] || process.env[k];
const URL_ = pick("SUPABASE_URL"), KEY = pick("SUPABASE_ANON_KEY");
if (!URL_ || !KEY) { console.error("Set SUPABASE_URL and SUPABASE_ANON_KEY in config.js"); process.exit(1); }
const H = { apikey: KEY, Authorization: "Bearer " + KEY };

const CASES = [
  { title: "Premalu", year: 2024, want: ["Hridayam", "Kumbalangi Nights", "Premam"], avoid: ["All We Imagine as Light"] },
  { title: "Premam", year: 2015, want: ["Hridayam", "Neram", "Thattathin Marayathu"], avoid: [] },
  { title: "Interstellar", year: 2014, want: ["Gravity", "Arrival", "The Martian"], avoid: ["The Hangover"] },
  { title: "The Dark Knight", year: 2008, want: ["Batman Begins", "The Dark Knight Rises"], avoid: [] },
];

const get = async (path) => { const r = await fetch(URL_ + path, { headers: H }); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); };
const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

(async () => {
  let hit = 0, total = 0, bad = 0;
  for (const c of CASES) {
    const q = await get("/functions/v1/tmdb-proxy?path=/search/movie&query=" + encodeURIComponent(c.title) + "&primary_release_year=" + c.year);
    const m = (q.results || [])[0];
    if (!m) { console.log("\n" + c.title + ": not found, skipped"); continue; }
    const j = await get("/functions/v1/similar?type=movie&id=" + m.id);
    const list = (j.list || []).filter((x) => !x.mix && !x.cross);
    const names = list.map((x) => norm(x.title));
    const got = c.want.filter((w) => names.includes(norm(w)));
    const wrong = c.avoid.filter((w) => names.includes(norm(w)));
    total += 1; hit += got.length > 0 ? 1 : 0; bad += wrong.length;
    console.log("\n" + c.title + " (" + c.year + "): " + list.length + " titles");
    console.log("  top 10: " + list.slice(0, 10).map((x) => x.title + " " + (x.pct || "?") + "%").join(" | "));
    console.log("  wanted found: " + (got.join(", ") || "none") + (wrong.length ? "   AVOID FOUND: " + wrong.join(", ") : ""));
  }
  console.log("\nCases with a wanted title: " + hit + "/" + total + "   Avoided titles that still showed: " + bad);
})().catch((e) => { console.error(e.message); process.exit(1); });
