// Daily job (GitHub Actions): adds films IMDb knows and TMDB's list of a person lacks.
// Only people who were opened in the app (rows of person_store with imdb_at empty or older than 7 days) are looked up.
// Reads IMDb's free non-commercial text files (title.principals, title.basics) in one pass each, keeps only those people's rows,
// matches each title to TMDB (/find) and saves a small JSON per person in person_store.imdb.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TMDB_API_KEY. Needs Node 18+.
const zlib = require("zlib"), readline = require("readline"), { Readable } = require("stream");
const SB = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "", TM = (process.env.TMDB_API_KEY || "").trim();
if (!SB || !KEY || !TM) { console.error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and TMDB_API_KEY"); process.exit(1); }
const MAX_PEOPLE = Number(process.env.MAX_PEOPLE) || 200, STALE_DAYS = 7;
const ROLE = { actor: "Actor", actress: "Actor", director: "Director", composer: "Composer", cinematographer: "Cinematographer", editor: "Editor", writer: "Writer", producer: "Producer" };
const TYPES = new Set(["movie", "tvMovie", "tvSeries", "tvMiniSeries"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sbh = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

async function tmdb(path, params = {}) {
  const u = new URL("https://api.themoviedb.org/3" + path), h = { Accept: "application/json" };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (TM.startsWith("eyJ")) h.Authorization = "Bearer " + TM; else u.searchParams.set("api_key", TM);
  for (let i = 0; i < 4; i++) {
    const r = await fetch(u, { headers: h });
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    if (!r.ok) throw new Error("TMDB " + r.status);
    return r.json();
  }
  throw new Error("TMDB busy");
}
async function stream(file, onLine) {
  const r = await fetch("https://datasets.imdbws.com/" + file);
  if (!r.ok) throw new Error(file + " " + r.status);
  const rl = readline.createInterface({ input: Readable.fromWeb(r.body).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) { if (first) { first = false; continue; } onLine(line); }
}
const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

(async () => {
  const cut = new Date(Date.now() - STALE_DAYS * 864e5).toISOString();
  const q = `${SB}/rest/v1/person_store?select=id,data&or=(imdb_at.is.null,imdb_at.lt.${cut})&order=hits.desc&limit=${MAX_PEOPLE}`;
  const rows = await (await fetch(q, { headers: sbh })).json();
  if (!Array.isArray(rows)) throw new Error("Could not read person_store: " + JSON.stringify(rows));
  if (!rows.length) { console.log("Nobody to look up."); return; }
  console.log(rows.length + " people to look up");

  // 1. IMDb person id of each (TMDB external_ids)
  const people = new Map(); // nm -> { id, have:Set, haveTitle:Set, titles: Map(tt -> Set(roles)) }
  const noImdb = [];
  for (const row of rows) {
    try {
      const nm = (await tmdb(`/person/${row.id}/external_ids`)).imdb_id;
      if (!nm) { noImdb.push(row.id); continue; }
      const cc = (row.data && row.data.tmdb && row.data.tmdb.combined_credits) || {};
      const have = new Set(), haveTitle = new Set();
      for (const c of [...(cc.cast || []), ...(cc.crew || [])]) {
        have.add(c.media_type + ":" + c.id);
        haveTitle.add(norm(c.title || c.name) + "|" + String(c.release_date || c.first_air_date || "").slice(0, 4));
      }
      for (const c of ((row.data && row.data.wd && row.data.wd.credits) || [])) { have.add(c.media_type + ":" + c.id); haveTitle.add(norm(c.title) + "|" + String(c.date || "").slice(0, 4)); }
      people.set(nm, { id: row.id, have, haveTitle, titles: new Map() });
    } catch (e) { console.log("skip", row.id, e.message); }
    await sleep(120);
  }

  // 2. their credits from title.principals (one pass)
  if (people.size) {
    let n = 0;
    await stream("title.principals.tsv.gz", (line) => {
      const a = line.split("\t"); // tconst, ordering, nconst, category, job, characters
      const p = people.get(a[2]);
      if (!p) return;
      const role = ROLE[a[3]];
      if (!role) return;
      let s = p.titles.get(a[0]); if (!s) p.titles.set(a[0], s = new Set()); s.add(role); n++;
    });
    console.log("principals rows kept:", n);
  }

  // 3. title type / year from title.basics (one pass), only for the titles found
  const wanted = new Set(); for (const p of people.values()) for (const t of p.titles.keys()) wanted.add(t);
  const basics = new Map();
  if (wanted.size) {
    await stream("title.basics.tsv.gz", (line) => {
      const t = line.slice(0, line.indexOf("\t"));
      if (!wanted.has(t)) return;
      const a = line.split("\t");
      if (TYPES.has(a[1])) basics.set(t, { title: a[2], year: a[5] === "\\N" ? "" : a[5] });
    });
    console.log("titles of the right type:", basics.size);
  }

  // 4. match to TMDB and save small JSON per person
  const found = new Map(); // tt -> tmdb result or null (shared between people)
  async function match(tt) {
    if (found.has(tt)) return found.get(tt);
    let out = null;
    try {
      const f = await tmdb(`/find/${tt}`, { external_source: "imdb_id" });
      const m = (f.movie_results || [])[0], t = (f.tv_results || [])[0];
      if (m) out = { id: m.id, media_type: "movie", title: m.title, date: m.release_date || "", poster: m.poster_path || "", votes: m.vote_count || 0 };
      else if (t) out = { id: t.id, media_type: "tv", title: t.name, date: t.first_air_date || "", poster: t.poster_path || "", votes: t.vote_count || 0 };
    } catch { out = undefined; } // a failed call is not remembered
    if (out !== undefined) found.set(tt, out);
    return out;
  }
  const mark = new Date().toISOString();
  for (const [nm, p] of people) {
    const todo = [...p.titles.entries()].filter(([tt]) => {
      const b = basics.get(tt);
      return b && !p.haveTitle.has(norm(b.title) + "|" + b.year); // same name and year already on TMDB's list: skip the call
    });
    const extra = [];
    let failed = false;
    for (let i = 0; i < todo.length; i += 6) {
      const res = await Promise.all(todo.slice(i, i + 6).map(([tt]) => match(tt)));
      res.forEach((m, j) => {
        if (m === undefined) { failed = true; return; }
        if (!m || p.have.has(m.media_type + ":" + m.id)) return;
        extra.push({ ...m, roles: [...todo[i + j][1]], char: "", src: "imdb", rating: 0 });
      });
    }
    if (failed) { console.log("incomplete, retried next run:", nm); continue; } // imdb_at stays empty
    const r = await fetch(`${SB}/rest/v1/person_store?id=eq.${p.id}`, { method: "PATCH", headers: sbh, body: JSON.stringify({ imdb: extra, imdb_at: mark }) });
    console.log(nm, "->", extra.length, "extra titles", r.ok ? "" : "(save failed " + r.status + ")");
  }
  for (const id of noImdb) await fetch(`${SB}/rest/v1/person_store?id=eq.${id}`, { method: "PATCH", headers: sbh, body: JSON.stringify({ imdb: [], imdb_at: mark }) });
})().catch((e) => { console.error(e); process.exit(1); });
