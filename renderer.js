const STORE_KEY = "movie-watchlist-v1";
const KEY_STORE = "movie-watchlist-tmdb-key";
const THEME_KEY = "movie-watchlist-theme";
const ORDER_KEY = "movie-watchlist-order-v2";
const LABELS = { 1: "Someday", 2: "Low", 3: "Medium", 4: "High", 5: "Top priority" };
const IMG_SMALL = "https://image.tmdb.org/t/p/w92";
const IMG_SAVED = "https://image.tmdb.org/t/p/w185";
const IMG_BIG = "https://image.tmdb.org/t/p/w500";
const IMG_T = "https://image.tmdb.org/t/p/";
// the browser picks the smallest of these that is sharp on its own screen (phone 2-3x, laptop 1-2x), so every device downloads only what it needs
// Discover cards are shown ~160-170 px wide. Smaller pictures (w185 / w342 / w500, never w780) and loading="lazy": only the cards near the screen
// download, not all ~150 in every row at once. That is what made Discover slow to fill in.
// Posters sized for the screen: the browser picks the smallest picture that is still sharp for the tile size and the screen density
// (a 3x phone gets w185 / w342, a plain desktop screen w92 / w154), so it is crisp and still light. w is the tile width in CSS px.
const THUMB_SIZES = "(min-width: 760px) 62px, (max-width: 360px) 40px, (max-width: 520px) 46px, 52px";
const thumbImg = (p, sizes) => `<img src="${IMG_T}w185${p}" srcset="${IMG_T}w92${p} 92w, ${IMG_T}w154${p} 154w, ${IMG_T}w185${p} 185w, ${IMG_T}w342${p} 342w" sizes="${sizes || THUMB_SIZES}" loading="lazy" decoding="async" alt="" draggable="false">`;
const bigImg = (p) => `<img src="${IMG_T}w342${p}" srcset="${IMG_T}w185${p} 185w, ${IMG_T}w342${p} 342w, ${IMG_T}w500${p} 500w" sizes="(max-width: 520px) 110px, 170px" loading="lazy" decoding="async" alt="" draggable="false">`;

// Search goes through our own Supabase Edge Function ("tmdb-proxy"), which holds the TMDB key
// as a server-side secret. No TMDB key ships inside the app. A key the person pastes in
// themselves is used directly instead.
const SB_URL = String(window.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SB_ANON = String(window.SUPABASE_ANON_KEY || "").trim();
const PROXY_URL = SB_URL && SB_ANON ? SB_URL + "/functions/v1/tmdb-proxy" : "";
// Reading storage can throw (Safari with "Block all cookies", some in-app browsers). Never let that stop the app from starting.
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
let userKey = (lsGet(KEY_STORE) || "").trim();
const canSearch = () => !!(userKey || PROXY_URL);

const PIN_ICO = `<svg class="pin-ico" viewBox="0 0 24 24" fill="currentColor" aria-label="Pinned"><path d="M15.5 3l5.5 5.5-1.8.9-3.4 3.4.4 4.1-1.6 1.6-3.8-3.8L5.5 20.5l-1.1-1.1 5.8-5.7L6.4 9.9 8 8.3l4.1.4 3.4-3.4z"/></svg>`;
const DOTS = `<svg class="ico" viewBox="4 4 16 16" aria-hidden="true"><g class="f"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></g></svg>`;
const SPARK = `<svg class="ico" viewBox="3 3 19 19" aria-hidden="true"><path d="M11 3l1.9 5.6L18.5 10.5l-5.6 1.9L11 18l-1.9-5.6L3.5 10.5l5.6-1.9z"/><path d="M19 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>`;
const HAMBURGER = `<svg class="ico" viewBox="4 4 16 16" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`;

const fileStore = !!(window.api && window.api.loadList && window.api.saveList);
let lastBytes = 0;
// Desktop (file) and Android (app) keep poster pictures inside the saved list. A browser does not: it only has about
// 5 MB of localStorage, and ~15 KB per poster would fill it at roughly 300 titles. In a browser the poster is
// re-loaded from TMDB (the service worker keeps a copy for offline use), so only the small poster path is saved.
const keepPosterData = !!(fileStore || window.Capacitor);
const BROWSER_QUOTA = 5 * 1024 * 1024;
function listJson() {
  if (keepPosterData) return JSON.stringify(items);
  return JSON.stringify(items.map((m) =>
    m.posterPath && typeof m.poster === "string" && m.poster.startsWith("data:") ? Object.assign({}, m, { poster: "" }) : m));
}

let items = load();
// Make every title safe to draw: numeric id, known type, real stars. Used for the saved list
// and for titles that arrive from the cloud, so an odd row can never break the page.
function normalizeItem(m) {
  const n = Number(m.id);
  if (Number.isFinite(n)) m.id = n;
  m.type = m.type === "tv" ? "tv" : "movie";
  m.title = String(m.title == null ? "" : m.title);
  m.done = !!m.done;
  if (m.pin) m.pin = true; else delete m.pin; // pinned to the top of To watch / Watching (at most 3 per tab)
  if (m.watchedAt !== undefined) m.watchedAt = Number(m.watchedAt) || 0; // when it was marked watched (Watched tab: latest first)
  m.stars = Math.min(5, Math.max(1, Math.round(Number(m.stars)) || 3));
  if (m.posterPath && !m.poster) m.poster = IMG_SAVED + m.posterPath; // shown at once; saved offline later
  if (m.collectionId !== undefined) {
    m.collectionId = Number(m.collectionId) || 0;
    if (m.collectionId > 0) {
      m.collectionPart = Number(m.collectionPart) || 0;
      m.collectionTotal = Number(m.collectionTotal) || 0;
      m.collectionName = String(m.collectionName || "");
    } else { delete m.collectionPart; delete m.collectionTotal; delete m.collectionName; }
  }
  if (m.ott !== undefined && (!m.ott || typeof m.ott !== "object")) delete m.ott; // OTT tag state (see ensureOtt)
  return m;
}
items.forEach(normalizeItem);
let syncing = false;
let syncAgain = false;
let syncTimer = null;
let syncState = { kind: "", at: 0 }; // kind: "", "syncing", "ok", "offline", "error"

// Change tracking for cloud sync: every edited title gets an updatedAt time.
let sigs = new Map();
let orderSig = "";
// The poster picture is only a local copy. When we know its TMDB path it is not part of a title's content,
// so downloading or re-using it never counts as an edit (and never causes a sync back and forth).
const sigOf = (m) => { const { updatedAt, ...rest } = m; if (rest.posterPath) delete rest.poster; return JSON.stringify(rest); };
function resetSigs() {
  sigs = new Map(items.map((m) => [String(m.id), sigOf(m)]));
  orderSig = items.map((m) => m.id).join(",");
}
resetSigs();
let tab = "watch";
const CAL_VIEW_KEY = "movie-watchlist-cal-view";
let calView = false; // Watching tab: List (false) or Calendar (true), remembered on this device
try { calView = localStorage.getItem(CAL_VIEW_KEY) === "1"; } catch { /* optional */ }
let pinned = false;
let menuOpen = null; // "top" or an item id
let theme = lsGet(THEME_KEY) || "system";
let sheet = null; // add / edit sheet state
let dragId = null;
let pSheet = null; // progress sheet state
let fPrio = 0; // 0 = all priorities
let wQuery = "", wOpen = false; // search box on the Watching tab
const PIN_MAX = 3; // pinned titles allowed per tab

// search state. sel: 0 = "plain text" row, 1.. = TMDB results
let results = [];
let sel = 0;
let status = ""; // "", "loading", "error", "nokey", "empty"
let searchTimer = null;
let toastTimer = null;
let searchSeq = 0;
let plainPicked = false; // the person chose the "plain text" row on purpose

const $ = (id) => document.getElementById(id);
// On a phone, focusing a text box opens the keyboard and hides half the screen. Only focus by itself with a mouse.
const touchOnly = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(pointer: fine)").matches);
const focusSoft = (el) => { if (el && !touchOnly) el.focus(); };
const focusSearch = () => focusSoft($("title"));

/* ---------------- storage ---------------- */
// In the desktop app the list is a regular file (watchlist.json) with no size limit.
// In a plain browser (no desktop bridge) it falls back to localStorage.

function load() {
  if (fileStore) {
    let res = null;
    try { res = window.api.loadList(); } catch {}
    if (res && res.exists) {
      lastBytes = JSON.stringify(res.items).length;
      return res.items;
    }
    // First run with file storage: bring over the list saved by the older version.
    // The old copy is left untouched as a backup.
    let old = [];
    try { old = JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch {}
    if (!Array.isArray(old)) old = [];
    try { window.api.saveList(JSON.stringify(old)); } catch {}
    lastBytes = JSON.stringify(old).length;
    return old;
  }
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}

function storageInfo() {
  return { used: lastBytes, count: items.length };
}

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

function trackChanges() {
  if (!window.Sync) return;
  const meta = Sync.getMeta();
  const track = !!meta.userId; // only remember dirty titles / deletions once an account has been used
  const now = Date.now();
  let changed = false;
  const seen = new Set();
  for (const m of items) {
    const id = String(m.id);
    seen.add(id);
    const sig = sigOf(m);
    if (sigs.get(id) !== sig) {
      m.updatedAt = now;
      sigs.set(id, sig);
      if (track) {
        if (!meta.dirty.includes(id)) meta.dirty.push(id);
        delete meta.tombs[id];
        changed = true;
      }
    }
  }
  for (const id of [...sigs.keys()]) {
    if (seen.has(id)) continue;
    sigs.delete(id);
    if (track) {
      meta.tombs[id] = now;
      meta.dirty = meta.dirty.filter((x) => x !== id);
      changed = true;
    }
  }
  const os = items.map((m) => m.id).join(",");
  if (os !== orderSig) {
    orderSig = os;
    if (track) { meta.orderTs = now; meta.orderDirty = true; changed = true; }
  }
  if (changed) Sync.setMeta(meta);
}

function save() {
  trackChanges();
  const json = listJson();
  try {
    if (fileStore) {
      const res = window.api.saveList(json);
      if (!res || !res.ok) throw new Error(res && res.error);
    } else {
      localStorage.setItem(STORE_KEY, json);
    }
  } catch {
    // Could not write: tell the person instead of silently losing changes.
    try { toast("Could not save your latest changes. Please try again."); } catch {}
    return false;
  }
  lastBytes = json.length;
  if (typeof scheduleSync === "function") scheduleSync();
  if (typeof queueNativeReminders === "function") queueNativeReminders();
  return true;
}

// The list is now ordered by hand. Keep the old order (interest, then newest) once.
(function migrateOrder() {
  let done = null;
  try { done = localStorage.getItem(ORDER_KEY); } catch {}
  if (done) return;
  items.sort((a, b) => (!!a.done - !!b.done) || (b.stars - a.stars) || (b.id - a.id));
  save();
  try { localStorage.setItem(ORDER_KEY, "1"); } catch {}
})();

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- TMDB ---------------- */
// key: a TMDB key to use directly. Leave it out to use the person's own saved key, or the proxy.
function tmdb(path, params = {}, key = userKey) {
  const headers = {};
  let url;
  if (key) {
    url = new URL("https://api.themoviedb.org/3" + path);
    // Long keys starting with "eyJ" are v4 Read Access Tokens; short ones are v3 API keys.
    if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
    else url.searchParams.set("api_key", key);
  } else {
    url = new URL(PROXY_URL);
    url.searchParams.set("path", path);
    headers.apikey = SB_ANON;
    headers.Authorization = "Bearer " + SB_ANON;
  }
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return fetch(url, { headers }).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}

/* ---------------- spelling-tolerant search ---------------- */
// Search text made plain: curly quotes and dashes straightened, spaces collapsed.
const cleanQuery = (q) => String(q || "").normalize("NFKC")
  .replace(/[\u2018\u2019\u201B\u2032]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2010-\u2015]/g, "-")
  .replace(/\s+/g, " ").trim().slice(0, 150);

// Movie + series search. Through the built-in search the proxy repairs spelling on the server (fuzzy=1),
// in ONE request. With a personal TMDB key the app talks to TMDB directly, so the same repair runs here.
// Keep this in step with supabase/functions/tmdb-proxy/index.ts.
async function searchMulti(text) {
  const typed = cleanQuery(text);
  const params = { include_adult: "false" };
  if (!userKey) return tmdb("/search/multi", { ...params, query: typed, fuzzy: "1" });
  return searchOwnKey(typed, params);
}

const FZ_NUM = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9" };
const FZ_WORD = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten" };
const FZ_ROMAN = { 2: "ii", 3: "iii", 4: "iv", 5: "v", 6: "vi", 7: "vii", 8: "viii", 9: "ix" };
const fzPlain = (s) => normName(String(s || "").replace(/&/g, " and ").replace(/['\u2018\u2019\u2032`\u00b4]/g, ""));
const fzWords = (n) => n.split(" ").filter(Boolean).map((w) => FZ_NUM[w] || w);
// edit distance where swapping two neighbouring letters counts as one mistake ("inceptoin")
function fzDist(a, b) {
  a = a.slice(0, 80); b = b.slice(0, 80);
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
function fzWordSim(a, b) {
  if (a === b) return 1;
  if (a.length >= 3 && b.startsWith(a)) return 0.95; // still being typed
  return Math.max(0, 1 - fzDist(a, b) / Math.max(a.length, b.length));
}
function fzSim(query, title) {
  const qn = fzPlain(query), tn = fzPlain(title);
  if (!qn || !tn) return 0;
  const qw = fzWords(qn), tw = fzWords(tn);
  let num = 0, den = 0;
  for (const w of qw) { let best = 0; for (const v of tw) best = Math.max(best, fzWordSim(w, v)); num += best * w.length; den += w.length; }
  const byWord = (den ? num / den : 0) - Math.min(0.15, 0.03 * Math.max(0, tw.length - qw.length));
  return Math.max(byWord, 1 - fzDist(qn, tn) / Math.max(qn.length, tn.length));
}
const fzNames = (r) => [r.title, r.name, r.original_title, r.original_name].filter((x) => typeof x === "string" && x);
const fzBest = (q, r) => Math.max(0, ...fzNames(r).map((t) => fzSim(q, t)));
// an obscure title with the typed name is not proof the query was spelt right: only a well-known title counts
const fzKnown = (r) => (r.popularity || 0) >= 15 || (r.vote_count || 0) >= 200;
const fzStrong = (q, rs) => rs.slice(0, 5).some((r) => fzKnown(r) && (fzBest(q, r) >= 0.85 || (q.length >= 3 && fzNames(r).some((t) => fzPlain(t).includes(q)))));
function fzAlternatives(q) {
  const t = q.split(" "), out = [];
  const roman = (w) => /^(ii|iii|iv|vi|vii|viii|ix)$/.test(w);
  out.push(t.map((w) => FZ_WORD[w] || (!roman(w) && FZ_NUM[w]) || w).join(" "));            // 4 <-> four
  out.push(t.map((w) => (roman(w) && FZ_NUM[w]) || FZ_ROMAN[w] || w).join(" "));           // 2 <-> ii
  if (t.length >= 2 && t.length <= 3) out.push(t.join(""));
  const cut = (s, f) => s.slice(0, Math.max(3, Math.ceil(s.length * f))).trim();
  if (q.length >= 5) out.push(cut(q, 0.7));
  if (q.length >= 8) out.push(cut(q, 0.5));
  t.filter((w) => w.length >= 5).sort((a, b) => b.length - a.length).slice(0, 2).forEach((w) => out.push(cut(w, 0.7)));
  return [...new Set(out)].filter((s) => s && s.length >= 3 && s !== q);
}
// Same as the server's search: TMDB lists popular matches first, so a new obscure title with the exact name can sit on page 2 or be missing.
// Also read page 2 and the movie / series searches, then put titles named exactly as typed first. Keep in step with the proxy.
async function widenSearch(typed, params, list) {
  const q = fzPlain(typed);
  if (!q) return list;
  const seen = new Set(list.map((r) => r.media_type + ":" + r.id)), out = [...list];
  const more = await Promise.allSettled([tmdb("/search/multi", { ...params, query: typed, page: "2" }), tmdb("/search/movie", { ...params, query: typed }), tmdb("/search/tv", { ...params, query: typed })]);
  more.forEach((x, i) => {
    if (x.status !== "fulfilled") return;
    for (const r of (x.value.results || [])) {
      const mt = i === 1 ? "movie" : i === 2 ? "tv" : r.media_type;
      if (mt !== "movie" && mt !== "tv") continue;
      const k = mt + ":" + r.id;
      if (!seen.has(k)) { seen.add(k); out.push({ ...r, media_type: mt }); }
    }
  });
  const exact = (r) => fzNames(r).some((n) => fzPlain(n) === q);
  return [...out.filter(exact), ...out.filter((r) => !exact(r))].slice(0, 30);
}
async function searchOwnKey(typed, params) {
  const q = fzPlain(typed);
  const pool = new Map();
  const ask = async (query) => {
    const d = await tmdb("/search/multi", { ...params, query });
    const rs = (d.results || []).filter((r) => r.media_type === "movie" || r.media_type === "tv");
    rs.forEach((r) => { const k = r.media_type + ":" + r.id; if (!pool.has(k)) pool.set(k, r); });
    return rs;
  };
  await ask(typed); // if TMDB cannot be reached this throws, and the search box shows its error
  const primary = [...pool.values()];
  const fin = async (list) => ({ results: await widenSearch(typed, params, list) });
  if (!q || fzStrong(q, primary)) return fin(primary);
  await Promise.allSettled(fzAlternatives(q).map(ask));
  const ranked = [...pool.values()]
    .map((r) => ({ r, s: fzBest(q, r) }))
    .filter((x) => x.s >= 0.5)
    .map((x) => ({ r: x.r, score: x.s + 0.2 * Math.min(1, (x.r.popularity || 0) / 20) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
  return fin(ranked.length ? ranked : primary);
}

function badgeLabel(m) { return m.done ? "Watched" : m.watching ? "Being watched" : "In watchlist"; }
function statusLabel(m) { return m.done ? "Watched" : m.watching ? "Watching" : "To watch"; }
function findDup(r) {
  const type = r.media_type === "tv" ? "tv" : "movie";
  return items.find((m) => m.tmdbId === r.id && (m.type || "movie") === type);
}
function findPlainDup(q) {
  const k = q.trim().toLowerCase();
  return items.find((m) => !m.tmdbId && m.title.trim().toLowerCase() === k);
}

function yearOf(m) { return (m.release_date || m.first_air_date || "").slice(0, 4); }
function typeOf(m) { return m.media_type === "tv" ? "tv" : "movie"; }

async function doSearch(q) {
  const seq = ++searchSeq;
  if (!canSearch()) { results = []; sel = 0; status = "nokey"; renderResults(); return []; }
  status = "loading";
  renderResults();
  try {
    // "multi" searches movies and TV series together.
    const data = await searchMulti(q);
    if (seq !== searchSeq) return results;
    results = (data.results || [])
      .filter((r) => r.media_type === "movie" || r.media_type === "tv")
      .slice(0, 6);
    sel = results.length && !plainPicked ? 1 : 0; // highlight the best match; plain text sits above it
    status = results.length ? "" : "empty";
  } catch {
    if (seq !== searchSeq) return results;
    results = [];
    sel = 0;
    status = "error";
  }
  renderResults();
  return results;
}

async function toDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const blob = await res.blob();
  if (!/^image\//.test(blob.type)) throw new Error("Not an image");
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

/* ---------------- search dropdown ---------------- */
function closeResults() {
  clearTimeout(searchTimer);
  searchSeq++; // ignore any response still on its way
  plainPicked = false;
  results = []; sel = 0; status = "";
  $("results").hidden = true;
}

function renderResults() {
  const box = $("results");
  const q = $("title").value.trim();
  if (q.length < 2) { box.hidden = true; return; }

  // The plain-text option is always the first row.
  let html = `
    <div class="res ${sel === 0 ? "on" : ""}" data-plain="1">
      <div class="thumb plain">+</div>
      <div>
        <div class="res-title">Add “${esc(q)}” as plain text</div>
        <div class="res-meta">Plain text${(() => { const d = findPlainDup(q); return d ? `<span class="badge ok in-list">${esc(badgeLabel(d))}</span>` : ""; })()}</div>
      </div>
    </div>`;

  if (status === "loading") html += `<div class="res-note">Searching…</div>`;
  else if (status === "nokey") html += `<div class="res-note">Add a TMDB key (menu → API key) to search and show posters.</div>`;
  else if (status === "error") html += `<div class="res-note">Could not reach TMDB. Check your internet connection.</div>`;
  else if (status === "empty") html += `<div class="res-note">No matches found.</div>`;

  html += results.map((r, i) => `
    <div class="res ${i + 1 === sel ? "on" : ""}" data-res="${i}">
      <div class="thumb">${r.poster_path ? thumbImg(esc(r.poster_path), "40px") : ""}</div>
      <div>
        <div class="res-title">${esc(r.title || r.name)}</div>
        <div class="res-meta">${esc([typeOf(r) === "tv" ? "Series" : "Movie", yearOf(r)].filter(Boolean).join(" · "))}${(() => { const d = findDup(r); return d ? `<span class="badge ok in-list">${esc(badgeLabel(d))}</span>` : ""; })()}</div>
      </div>
    </div>`).join("");

  box.innerHTML = html;
  box.hidden = false;
  const on = box.querySelector(".res.on");
  if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
}

/* ---------------- list ---------------- */
function starsHtml(n, attr) {
  let out = "";
  for (let i = 1; i <= 5; i++) {
    out += `<span class="star ${i <= n ? "on" : ""}" ${attr(i)}>★</span>`;
  }
  return out;
}

function metaOf(m) {
  return [m.type === "tv" ? "Series" : "Movie", m.year].filter(Boolean).join(" · ");
}

// New titles go to the end of the list, so To watch shows them in the order you added them (movies and series alike).
// Priority only changes the stars; move a title up or down yourself if you want it elsewhere.
function insertNew(item) {
  items.push(item);
  regCount(item);
}

// To watch = not started, Watching = in progress, Watched = finished.
function inTab(m, t = tab) {
  if (t === "coll" || t === "disc") return false; // the Collections and Discover tabs list franchises / suggestions, not your titles
  if (t === "done") return !!m.done;
  if (t === "watching") return !!m.watching && !m.done;
  return !m.done && !m.watching;
}

function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" }); }
  catch { return ""; }
}

const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Older saves kept a single day. Now a show can air on several days.
function daysOf(p) {
  if (Array.isArray(p.days)) return p.days;
  return p.day ? [p.day] : [];
}

function airingText(p) {
  const d = daysOf(p);
  if (!d.length) return "Airing";
  if (d.length === 7) return "Airing daily";
  return "Airing " + d.join(", ");
}

// One release status at a time. Older saves used two checkboxes, so map them.
function relOf(p) {
  if (p.release !== undefined) return p.release;
  return p.ended ? "ended" : p.airing ? "airing" : "";
}

// Time is saved as hours + minutes. Older saves kept one "h:mm:ss" string.
function timeParts(p) {
  if (p.th !== undefined || p.tm !== undefined) return { h: p.th || "", m: p.tm || "" };
  const parts = String(p.time || "").split(":").filter((x) => x !== "").map((x) => String(parseInt(x, 10) || 0));
  if (parts.length === 3) return { h: parts[0], m: parts[1] };
  if (parts.length === 2 || parts.length === 1) return { h: "", m: parts[0] };
  return { h: "", m: "" };
}

function timeText(p) {
  const t = timeParts(p);
  const h = +t.h || 0, m = +t.m || 0;
  if (!h && !m) return "";
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function progressHtml(m) {
  const p = m.progress || {};
  const bits = [];
  if (p.season) bits.push("Season " + p.season);
  if (p.episode) bits.push("Episode " + p.episode);
  let line = bits.join(", ");
  const tt = timeText(p);
  if (tt) line += (line ? " · " : "") + "at " + tt;
  const badges = [];
  const rel = relOf(p);
  if (rel === "ended") badges.push(`<span class="badge ok">${p.season ? "Finished season " + esc(p.season) : "Finished this season"}</span>`);
  else if (rel === "out") badges.push(`<span class="badge ok">Finished the show</span>`);
  else if (rel === "airing" && airsToday(p)) badges.push(`<span class="badge live">Airs today</span>`);
  if (rel === "airing") badges.push(`<span class="badge live">${esc(airingText(p))}</span>`);
  return `<div class="progress" data-progress="${m.id}">
    ${line ? `<span class="pl">▶ ${esc(line)}</span>` : `<span class="pl empty-p">Add where you stopped</span>`}
    ${badges.join("")}
    ${p.updated ? `<span class="pu">Updated ${esc(fmtDate(p.updated))}</span>` : ""}
  </div>`;
}

// The titles of a tab in the order they are shown: pinned ones first (To watch and Watching), then the rest.
function tabList(t = tab) {
  const v = items.filter((m) => inTab(m, t));
  if (t !== "watch" && t !== "watching") return v;
  return v.filter((m) => m.pin).concat(v.filter((m) => !m.pin));
}

function isReorderable() {
  if (tab === "watching" && wQuery.trim()) return false; // positions are not clear while the list is filtered
  return tab === "coll" || tab === "disc" || tab === "done" ? false : (tab !== "watch" || fPrio === 0);
}

function render() {
  const pending = items.filter((m) => inTab(m, "watch")).length;
  const going = items.filter((m) => inTab(m, "watching")).length;
  const subParts = [];
  if (pending) subParts.push(`${pending} ${pending === 1 ? "title" : "titles"} to watch`);
  if (going) subParts.push(`${going} watching`);
  $("sub").textContent = subParts.length ? subParts.join(" · ") : "Nothing queued yet";

  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === tab));

  $("menuBtn").classList.toggle("warn", !canSearch());
  updateSyncBtn();
  $("bannerHint").hidden = items.length > 0;

  $("filters").hidden = tab !== "watch";
  if (tab !== "watching") { wQuery = ""; wOpen = false; }
  $("wSearchBtn").hidden = tab !== "watching" || calView;
  $("wSearchBtn").classList.toggle("on", !!wQuery.trim());
  $("wSearch").hidden = !(tab === "watching" && wOpen && !calView);
  $("headTools").hidden = tab !== "watching" && tab !== "watch";
  $("calBtn").hidden = tab !== "watching";
  $("tonightBtn").hidden = tab !== "watch";
  $("listHead").classList.toggle("tn-on", tab === "watch");
  const calOn = tab === "watching" && calView;
  $("calBtn").classList.toggle("on", calOn);
  $("calBtn").setAttribute("aria-pressed", calOn ? "true" : "false");
  $("calBtn").title = calOn ? "Back to the list" : "Release calendar";
  $("listHead").classList.toggle("cal-on", calOn);
  { const w = $("calRelWrap"), cb = $("calRel"); // "Notify me on release days" sits in the calendar header row
    if (w) w.hidden = !calOn;
    if (calOn && cb) { try { cb.checked = relOn(); } catch { /* relOn is defined further down; not ready on the very first paint */ } } }
  if ($("wQ").value !== wQuery) $("wQ").value = wQuery;
  $("fPrio").value = String(fPrio);
  { const pt = $("prioText"); if (pt) pt.textContent = $("fPrio").selectedOptions[0] ? $("fPrio").selectedOptions[0].textContent : "Priority: All"; }
  $("listHead").hidden = tab === "coll" || tab === "disc";
  if (calOn) { renderCalendar(); return; }
  if (tab === "coll") { renderCollectionsTab(); return; }
  if (tab === "disc") { renderDiscoverTab(); return; }

  let shown = tabList();
  if (tab === "done") shown = shown.map((m, i) => [m, i]).sort((a, b) => (b[0].watchedAt || 0) - (a[0].watchedAt || 0) || a[1] - b[1]).map((x) => x[0]); // latest watched first; older ones keep their order below
  const reorderable = isReorderable();
  // HTML5 drag and drop needs a mouse. Touch screens use Move up / Move down in the menu.
  const dragOk = reorderable && !!(window.matchMedia && window.matchMedia("(pointer: fine)").matches);
  if (tab === "watch") {
    if (fPrio) shown = shown.filter((m) => m.stars === fPrio);
  }
  if (tab === "watching" && wQuery.trim()) {
    const q = wQuery.trim().toLowerCase();
    shown = shown.filter((m) => m.title.toLowerCase().includes(q));
  }

  $("list").innerHTML = shown.length
    ? shown.map((m, i) => {
        const meta = metaOf(m);
        return `
        <div class="item ${m.done ? "done" : ""} ${dragOk ? "can-drag" : "fixed"}" draggable="${dragOk}" title="${dragOk ? "Drag to change position" : (tab === "watch" && fPrio) ? "Set Priority to All to change position" : ""}" data-row="${m.id}">
          <div class="rank">${tab === "done" ? shown.length - i : i + 1}</div>
          <div class="thumb">${m.poster ? (m.posterPath && !String(m.poster).startsWith("data:") ? thumbImg(esc(m.posterPath)) : `<img src="${esc(m.poster)}" alt="" draggable="false">`) : ""}</div>
          <div class="info">
            <div class="name">${m.pin && tab !== "done" ? PIN_ICO : ""}${esc(m.title)}</div>
            ${meta ? `<div class="meta">${esc(meta)}</div>` : ""}
            ${collLineHtml(m)}
            ${tab === "watch" ? ottTagHtml(m) : ""}
            ${tab === "done" ? "" : `<div class="rating">${starsHtml(m.stars, (n) => `data-rate="${m.id}:${n}"`)}<span class="plabel">${LABELS[m.stars]}</span></div>`}
            ${tab === "watching" ? progressHtml(m) : ""}
            ${m.note ? `<div class="note">${esc(m.note)}</div>` : ""}
          </div>
          ${tab === "done" && m.tmdbId ? `<button class="icon sim-i" data-similar="${m.id}" title="Similar titles" aria-label="Similar titles">${SPARK}</button>` : ""}
          <button class="icon menu-i" data-menu="${m.id}" title="Options">${DOTS}</button>
        </div>`;
      }).join("")
    : `<div class="empty">${tab === "done" ? "Nothing watched yet" : tab === "watching" && wQuery.trim() ? "No title in Watching matches your search" : tab === "watching" ? "Nothing in progress. Open a title’s menu and choose Move to watching" : fPrio ? "No titles with this priority" : "Search for a movie or series above to start your list"}</div>`;
}

/* ---------------- drag to reorder ---------------- */
function clearDragMarks() {
  $("list").querySelectorAll(".dragging,.drop-before,.drop-after")
    .forEach((el) => el.classList.remove("dragging", "drop-before", "drop-after"));
}
function endDrag() {
  dragId = null;
  clearDragMarks();
}

function dropTarget(e) {
  const list = $("list");
  const rows = [...list.querySelectorAll("[data-row]")];
  const row = e.target.closest ? e.target.closest("[data-row]") : null;
  if (row) {
    const r = row.getBoundingClientRect();
    return { id: +row.dataset.row, after: e.clientY > r.top + r.height / 2, row };
  }
  if (rows.length) {
    const last = rows[rows.length - 1];
    if (e.clientY > last.getBoundingClientRect().bottom) {
      return { id: +last.dataset.row, after: true, row: last };
    }
  }
  return null;
}

// Reorder inside the tab that is showing. Other tab's items keep their slots.
function moveItem(id, targetId, after) {
  if (id === targetId) return;
  { const a = items.find((x) => x.id === id), b = items.find((x) => x.id === targetId);
    if (a && b && !!a.pin !== !!b.pin) return; } // a pinned title stays above the others, and the others stay below it
  const slots = [];
  const vis = [];
  items.forEach((m, i) => { if (inTab(m, tab)) { slots.push(i); vis.push(m); } });
  const from = vis.findIndex((m) => m.id === id);
  if (from < 0) return;
  const [moved] = vis.splice(from, 1);
  const to = vis.findIndex((m) => m.id === targetId);
  if (to < 0) vis.push(moved);
  else vis.splice(after ? to + 1 : to, 0, moved);
  slots.forEach((slot, k) => { items[slot] = vis[k]; });
  save();
  render();
}

// Move one step up (-1) or down (+1) inside the tab that is showing.
function moveStep(id, dir) {
  const vis = tabList();
  const i = vis.findIndex((m) => m.id === id);
  const n = i < 0 ? null : vis[i + dir];
  if (!n || !!n.pin !== !!vis[i].pin) return;
  moveItem(id, n.id, dir > 0);
}

$("list").addEventListener("dragstart", (e) => {
  const row = e.target.closest ? e.target.closest("[data-row]") : null;
  if (!row) return;
  dragId = +row.dataset.row;
  row.classList.add("dragging");
  closeMenu();
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(dragId)); } catch {}
  }
});

$("list").addEventListener("dragover", (e) => {
  if (dragId === null) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

  const list = $("list");
  list.querySelectorAll(".drop-before,.drop-after")
    .forEach((el) => el.classList.remove("drop-before", "drop-after"));
  const t = dropTarget(e);
  if (t && t.id !== dragId) t.row.classList.add(t.after ? "drop-after" : "drop-before");

  // Scroll while dragging near the top or bottom edge.
  const lr = list.getBoundingClientRect();
  if (e.clientY < lr.top + 36) list.scrollTop -= 14;
  else if (e.clientY > lr.bottom - 36) list.scrollTop += 14;
});

$("list").addEventListener("drop", (e) => {
  if (dragId === null) return;
  e.preventDefault();
  const t = dropTarget(e);
  const id = dragId;
  endDrag();
  if (t && t.id !== id) moveItem(id, t.id, t.after);
});

$("list").addEventListener("dragend", endDrag);

/* ---------------- add / edit sheet ---------------- */
function paintSheetStars() {
  $("sheetStars").innerHTML = starsHtml(sheet.stars, (n) => `data-sstar="${n}"`);
  $("sheetLabel").textContent = LABELS[sheet.stars];
}

function openSheet(s) {
  sheet = s;
  const isEdit = s.mode === "edit";
  $("sheetHeading").textContent = isEdit ? "Edit" : "Add to list";
  $("sheetSave").textContent = isEdit ? "Save" : "Add to list";
  $("sheetName").value = s.title;
  $("sheetNote").value = s.note || "";
  $("sheetThumb").innerHTML = s.poster ? `<img src="${esc(s.poster)}" alt="" draggable="false">` : "";
  $("sheetMeta").textContent = s.meta || "Plain text entry";
  $("sheetHint").textContent = s.hint || "";
  $("sheetYear").value = s.year || "";
  s.type = s.type === "tv" ? "tv" : "movie";
  // Titles that come from TMDB are locked. Plain text titles stay editable.
  $("sheetName").readOnly = !!s.orig;
  refreshPlainState();
  paintSheetStars();
  closeMenu();
  closeResults();
  $("sheet").hidden = false;
  focusSoft(s.result || isEdit ? $("sheetNote") : $("sheetName"));
}

// Titles that come from TMDB are locked, so only plain text entries are "plain".
function sheetIsPlain() {
  return !sheet.orig;
}

function refreshPlainState() {
  if (!sheet) return;
  const plain = sheetIsPlain();
  $("yearWrap").hidden = !plain;
  $("typeWrap").hidden = !plain;
  document.querySelectorAll("#sheetType [data-stype]").forEach((b) =>
    b.classList.toggle("on", b.dataset.stype === sheet.type));
  if (sheet.orig) {
    $("sheetThumb").innerHTML = !plain && sheet.poster ? `<img src="${esc(sheet.poster)}" alt="" draggable="false">` : "";
    $("sheetMeta").textContent = plain ? "Plain text entry" : sheet.meta;
    $("sheetHint").textContent = plain ? "" : (sheet.hint || "The title comes from TMDB and is locked.");
  }
}

function closeSheet() {
  sheet = null;
  $("sheet").hidden = true;
  focusSearch();
}

function startAddFromResult(r) {
  if (!r) return;
  const type = typeOf(r);
  const dup = items.find((m) => m.tmdbId === r.id && (m.type || "movie") === type);
  if (dup) return openEdit(dup, `Already in your list (${statusLabel(dup)}). You can update it here.`);
  const meta = [type === "tv" ? "Series" : "Movie", yearOf(r)].filter(Boolean).join(" · ");
  openSheet({
    mode: "add",
    result: r,
    orig: r.title || r.name,
    type,
    year: yearOf(r),
    title: r.title || r.name,
    stars: 3,
    note: "",
    poster: r.poster_path ? IMG_SAVED + r.poster_path : "",
    meta,
    hint: "",
  });
}

function startAddPlain(q) {
  if (!q) return;
  const dup = findPlainDup(q);
  if (dup) return openEdit(dup, `Already in your list (${statusLabel(dup)}). You can update it here.`);
  openSheet({
    mode: "add",
    title: q,
    stars: 3,
    note: "",
    poster: "",
    meta: "",
    hint: "No poster or details. It will be saved as plain text.",
  });
}

function openEdit(m, hint) {
  openSheet({
    mode: "edit",
    id: m.id,
    title: m.title,
    stars: m.stars,
    note: m.note || "",
    poster: m.poster || "",
    year: m.year || "",
    type: m.type,
    orig: m.tmdbId ? (m.tmdbTitle || m.title) : "",
    meta: metaOf(m),
    hint: hint || "",
  });
}

async function saveSheet() {
  if (!sheet) return;
  const title = sheet.title.trim();
  if (!title) { $("sheetName").focus(); return; }
  const note = sheet.note.trim();
  const plain = sheetIsPlain();
  const year = plain ? $("sheetYear").value.replace(/\D/g, "").slice(0, 4) : "";

  if (sheet.mode === "edit") {
    const m = items.find((x) => x.id === sheet.id);
    if (m) {
      m.title = title; m.stars = sheet.stars; m.note = note;
      if (m.tmdbId && !plain) m.tmdbTitle = sheet.orig;
      if (plain) {
        // Renamed (or already plain): drop everything that came from TMDB.
        delete m.tmdbId; delete m.tmdbTitle; delete m.type; delete m.rating; delete m.poster; delete m.posterPath;
        delete m.collectionId; delete m.collectionPart; delete m.collectionTotal; delete m.collectionName;
        m.type = sheet.type;
        m.year = year;
      }
      save();
    }
    closeSheet();
    render();
    return;
  }

  const r = sheet.result;
  const id = Date.now();
  const item = { id, title, stars: sheet.stars, note, done: false };
  let posterUrl = "";
  if (r && !plain) {
    posterUrl = r.poster_path ? IMG_SAVED + r.poster_path : "";
    Object.assign(item, {
      year: yearOf(r),
      type: typeOf(r),
      rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
      poster: posterUrl,
      posterPath: r.poster_path || "",
      tmdbId: r.id,
      tmdbTitle: sheet.orig,
    });
  }
  if (plain) { item.type = sheet.type; if (year) item.year = year; }
  insertNew(item);
  save();
  forgetTitleKeys(item); // an old answer for this title (from before it was removed) must not be reused
  if (item.tmdbId) warmRelated(item.tmdbId, item.type); // let the shared list learn this title's franchise (movies and series)
  $("title").value = "";
  tab = "watch";
  closeSheet();
  render();

  hydratePosters(); // also finds out whether it belongs to a collection

  // Save the poster inside the list so it still shows offline.
  if (posterUrl) {
    try {
      const data = await toDataUrl(posterUrl);
      const m = items.find((x) => x.id === id);
      if (m) { m.poster = data; save(); render(); }
    } catch {}
  }
}

$("sheetType").addEventListener("click", (e) => {
  const b = e.target.closest("[data-stype]");
  if (!b || !sheet) return;
  sheet.type = b.dataset.stype;
  refreshPlainState();
});
$("sheetName").addEventListener("input", (e) => { if (sheet) { sheet.title = e.target.value; refreshPlainState(); } });
$("sheetYear").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); saveSheet(); }
});
$("sheetNote").addEventListener("input", (e) => { if (sheet) sheet.note = e.target.value; });
$("sheetName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); saveSheet(); }
});
$("sheetNote").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveSheet(); }
});
$("sheetCancel").addEventListener("click", closeSheet);
$("sheetSave").addEventListener("click", saveSheet);

/* ---------------- airing reminders ---------------- */
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n) => String(n).padStart(2, "0");
function todayName() { return DAY_NAMES[new Date().getDay()]; }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function nowHM() { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function airsToday(p) { return daysOf(p).includes(todayName()); }

function askNotifyPermission() {
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch {}
}

function toast(msg, action) {
  const t = $("toast");
  t.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-act";
    b.textContent = action.label;
    b.addEventListener("click", (e) => { e.stopPropagation(); t.hidden = true; clearTimeout(toastTimer); action.run(); });
    t.appendChild(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 7000 : 9000);
}
$("toast").addEventListener("click", () => { $("toast").hidden = true; clearTimeout(toastTimer); }); // tap to dismiss

function notifyEpisode(m) {
  const body = "A new episode airs today.";
  let shown = false;
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(m.title, { body });
      shown = true;
    }
  } catch {}
  if (!shown) toast(`${m.title}: ${body}`); // fallback when system notifications are off
}

// Runs while the app is open: once a day, on an airing day, after the chosen time.
function checkReminders() {
  if (NATIVE_LN) return; // Android app: the system fires the reminders, even with the app closed
  const day = todayName(), date = todayStr(), now = nowHM();
  let changed = false;
  items.forEach((m) => {
    const p = m.progress;
    if (!p || m.done || !m.watching || relOf(p) !== "airing" || !p.remind) return;
    if (!daysOf(p).includes(day) || m.notifiedOn === date) return;
    if (now < (p.remindTime || "20:00")) return;
    m.notifiedOn = date;
    changed = true;
    notifyEpisode(m);
  });
  if (changed) save();
}
setInterval(checkReminders, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkReminders(); });

/* ---------------- Android app: reminders that fire even when the app is closed ---------------- */
// Uses the Capacitor Local Notifications plugin. In a browser or the Mac/Windows app NATIVE_LN is empty and nothing here runs.
var NATIVE_LN = (function () {
  try {
    var c = window.Capacitor;
    return (c && c.isNativePlatform && c.isNativePlatform() && c.Plugins && c.Plugins.LocalNotifications) || null;
  } catch (e) { return null; }
})();
var nativeSig = null, nativeTimer = 0;
function nativeId(itemId, dayIdx) {
  let h = 0;
  for (const ch of String(itemId)) h = (h * 31 + ch.charCodeAt(0)) % 2000000;
  return h * 8 + dayIdx + 1; // stays under 16,000,008, so it fits a 32-bit number
}
function nativeWanted() {
  const out = [];
  items.forEach((m) => {
    const p = m.progress;
    if (!p || m.done || !m.watching || relOf(p) !== "airing" || !p.remind) return;
    const hm = String(p.remindTime || "20:00").split(":").map((x) => parseInt(x, 10) || 0);
    daysOf(p).forEach((d) => {
      const i = DAY_NAMES.indexOf(d);
      if (i < 0) return;
      out.push({
        id: nativeId(m.id, i), title: m.title, body: "A new episode airs today.",
        schedule: { on: { weekday: i + 1, hour: hm[0], minute: hm[1] || 0 }, allowWhileIdle: true }, // weekday 1 = Sunday
      });
    });
  });
  return out;
}
async function syncNativeReminders() {
  if (!NATIVE_LN) return;
  try {
    const want = nativeWanted();
    const sig = JSON.stringify(want);
    if (sig === nativeSig) return; // nothing changed since the last sync
    if (want.length) {
      let perm = await NATIVE_LN.checkPermissions();
      if (perm.display !== "granted") perm = await NATIVE_LN.requestPermissions();
      if (perm.display !== "granted") {
        nativeSig = sig;
        toast("Allow notifications for Watchlist in your phone settings to get reminders.");
        return;
      }
    }
    const pend = await NATIVE_LN.getPending();
    if (pend && pend.notifications && pend.notifications.length) {
      await NATIVE_LN.cancel({ notifications: pend.notifications.map((n) => ({ id: n.id })) });
    }
    if (want.length) await NATIVE_LN.schedule({ notifications: want });
    nativeSig = sig;
  } catch (e) { console.error("native reminders", e); }
}
function queueNativeReminders() {
  if (!NATIVE_LN) return;
  clearTimeout(nativeTimer);
  nativeTimer = setTimeout(syncNativeReminders, 1500);
}

/* ---------------- progress sheet ---------------- */
const REL_HINTS = {
  out: "Saving moves this show to Watched.",
  ended: "You finished this season. When the next one starts, update the season number.",
};

function paintRelease() {
  document.querySelectorAll("#pRel [data-prel]").forEach((b) =>
    b.classList.toggle("on", b.dataset.prel === pSheet.release));
  // A completed season or show has no "stopped at" time to remember.
  const done = pSheet.release === "ended" || pSheet.release === "out";
  $("pTimeWrap").hidden = done && !$("pFlags").hidden;
  $("pRelHint").textContent = REL_HINTS[pSheet.release] || "";
}

function openProgress(m, starting = false) {
  const p = m.progress || {};
  const kind = m.type === "tv" ? "tv" : "movie"; // plain text entries count as movies
  const rel0 = relOf(p);
  pSheet = { id: m.id, release: rel0 === "airing" ? "" : rel0, starting, info: null, saved: { season: String(p.season || ""), episode: String(p.episode || "") } };
  $("pTitle").textContent = m.title;
  // Series get season, episode and release status. Movies only need a time.
  $("pSeries").hidden = kind === "movie";
  $("pFlags").hidden = kind === "movie";
  $("pSeason").value = p.season || "";
  $("pEpisode").value = p.episode || "";
  const t = timeParts(p);
  $("pH").value = t.h; $("pM").value = t.m;
  $("pError").textContent = "";
  paintRelease();
  paintProgressCheck();
  if (kind === "tv" && m.tmdbId) loadProgressInfo(m);
  closeMenu();
  closeResults();
  $("pSheet").hidden = false;
  focusSoft(kind === "movie" ? $("pH") : $("pSeason"));
}

/* ---- season / episode check (uses the same TMDB / Wikidata season info as the details card) ----
   Ended or cancelled show with counts: wrong numbers block Save. Ongoing show: older seasons are checked, the newest season
   and anything beyond it only warn (the counts may be out of date). No counts, or only part of them: nothing blocks. */
async function loadProgressInfo(m) {
  const id = m.id, key = "tv:" + m.tmdbId;
  try {
    let f = tinfoCache.get(key);
    if (!f && tinfoPending.has(key)) f = await tinfoPending.get(key);
    if (!f) {
      if (!canSearch()) return;
      const pr = tinfoLoad("tv", m.tmdbId).finally(() => tinfoPending.delete(key));
      tinfoPending.set(key, pr);
      f = await pr;
      if (!f.noCache) tinfoCache.set(key, f);
    }
    if (!pSheet || pSheet.id !== id) return; // closed or another title opened meanwhile
    pSheet.info = f.seasons && !f.seasons.none ? f.seasons : null;
    paintProgressCheck();
  } catch { /* optional: without counts nothing is checked */ }
}

// -> { season: {msg, warn}, episode: {msg, warn} } (empty object = fine)
function checkProgress(season, episode) {
  const out = { season: null, episode: null };
  const q = pSheet && pSheet.info;
  const s = season === "" ? 0 : +season, e = episode === "" ? 0 : +episode;
  if (season !== "" && s < 1) out.season = { msg: "Season must be 1 or higher." };
  if (episode !== "" && e < 1) out.episode = { msg: "Episode must be 1 or higher." };
  if (!q || out.season || out.episode) return out;
  const list = (q.list || []).filter((x) => x.e > 0 || x.aired !== undefined);
  const maxN = Math.max(0, q.n || 0, ...list.map((x) => x.n));
  const ongoing = !(q.status === "Ended" || q.status === "Cancelled") || q.partial; // unknown status counts as ongoing: never block on a guess
  const latest = list.length ? list[list.length - 1] : null;
  const lastKnown = latest ? `S${latest.n} E${latest.aired !== undefined ? latest.aired : latest.e}` : "";
  const strictFor = (n) => !ongoing || (latest && n < latest.n); // may this season be blocked on?

  if (s && maxN) {
    if (s > maxN) {
      out.season = strictFor(s) ? { msg: `${plural(maxN, "season")} listed. Pick 1 to ${maxN}.` }
        : { warn: true, msg: `Latest known is ${lastKnown || "S" + maxN}. Saving anyway.` };
    }
  }
  if (e && !out.season) {
    // season left empty on a show with one known season that is still airing: that season is meant
    const row = s ? list.find((x) => x.n === s) : (list.length === 1 && (!ongoing || list[0].aired !== undefined || q.partial) ? list[0] : null);
    // how many episodes of this season have really aired (null = not known)
    const cap = row ? (row.aired !== undefined ? row.aired : (q.partial && list.length === 1 && row.e > 0 ? row.e : null)) : null;
    if (row && cap !== null) {
      if (e > cap) {
        const same = pSheet && pSheet.saved && String(e) === pSheet.saved.episode && String(season) === pSheet.saved.season; // an older saved value is only flagged, so other edits still save
        const msg = cap ? `Only ${plural(cap, "episode")} of Season ${row.n} ${cap === 1 ? "has" : "have"} aired. Pick 1 to ${cap}.` : `Season ${row.n} has not started airing yet.`;
        out.episode = same ? { warn: true, msg: msg.replace(/ Pick 1 to \d+\./, "") + " Saved earlier, kept." } : { msg };
      }
    } else if (row && row.e > 0) {
      if (e > row.e) {
        const block = strictFor(row.n);
        out.episode = block ? { msg: `Season ${row.n} has ${row.e} episodes.` }
          : { warn: true, msg: `Season ${row.n} lists ${row.e} episodes. Latest known is ${lastKnown}. Saving anyway.` };
      }
    } else if (!list.length && q.eps && e > q.eps) { // only a total is known
      out.episode = { warn: true, msg: `${plural(q.eps, "episode")} listed in total. Saving anyway.` };
    }
  }
  return out;
}

// Status vs the real season data. -> {msg} (blocks Save) / {msg, warn:true} / null
function checkStatus(season, episode) {
  const rel = pSheet && pSheet.release;
  const q = pSheet && pSheet.info;
  if ((rel !== "ended" && rel !== "out") || !q || q.partial) return null; // no counts, or only a lower bound: never block on a guess
  const s = season === "" ? 0 : +season, e = episode === "" ? 0 : +episode;
  const list = (q.list || []).filter((x) => x.e > 0 || x.aired !== undefined);
  const over = q.status === "Ended" || q.status === "Cancelled";
  if (rel === "out") {
    if (q.status && !over) return { msg: "This show is still ongoing. Use Finished this season." };
    if (!list.length) return null;
    const last = list[list.length - 1];
    if (s && s < last.n) return { msg: `The last season is ${last.n}. You are on season ${s}.` };
    const row = s ? list.find((x) => x.n === s) : (list.length === 1 ? list[0] : null);
    if (row && row.n === last.n && e && e < row.e) return { msg: `The last episode is ${row.e}. You are on episode ${e}.` };
    return null;
  }
  // ended = finished this season
  const row = s ? list.find((x) => x.n === s) : (list.length === 1 ? list[0] : null);
  if (!row) return null;
  const latest = row === list[list.length - 1];
  if (row.aired !== undefined) { // the running season: episodes are still to come
    return { msg: row.e ? `Season ${row.n} is still airing (${row.aired} of ${row.e} aired).` : `Season ${row.n} has not started airing yet.` };
  }
  if (e && e < row.e) {
    const msg = `Season ${row.n} has ${plural(row.e, "episode")}. You are on episode ${e}.`;
    return !over && latest ? { warn: true, msg: msg + " Saving anyway." } : { msg }; // an ongoing show's newest total may be out of date
  }
  return null;
}

function paintProgressCheck() {
  if (!pSheet) return;
  const q = pSheet.info, series = !$("pSeries").hidden;
  const season = $("pSeason").value, episode = $("pEpisode").value;
  // placeholders show the real range when it is known
  const list = q ? (q.list || []).filter((x) => x.e > 0) : [];
  const maxN = q ? Math.max(0, q.n || 0, ...list.map((x) => x.n)) : 0;
  $("pSeason").placeholder = series && maxN && !q.partial ? `1-${maxN}` : "e.g. 2";
  const row = q && !q.partial && season !== "" ? list.find((x) => x.n === +season) : null;
  $("pEpisode").placeholder = row ? `1-${row.aired > 0 ? row.aired : row.e}` : "e.g. 5";
  const res = series ? checkProgress(season, episode) : { season: null, episode: null };
  [["Season", res.season], ["Episode", res.episode]].forEach(([k, v]) => {
    const msg = $("p" + k + "Msg");
    msg.textContent = v ? v.msg : "";
    msg.classList.toggle("warn", !!(v && v.warn));
    $("p" + k).classList.toggle("bad", !!(v && !v.warn));
  });
  const st = series ? checkStatus(season, episode) : null;
  const rm = $("pRelMsg");
  rm.textContent = st ? st.msg : "";
  rm.classList.toggle("warn", !!(st && st.warn));
  res.status = st;
  return res;
}

function closeProgress() {
  pSheet = null;
  $("pSheet").hidden = true;
}

function progressError(msg, field) {
  $("pError").textContent = msg;
  if (field) $(field).focus();
  return null;
}

// Every field may stay empty. Only what is filled in gets checked.
function readProgress() {
  const season = $("pSeason").value, episode = $("pEpisode").value;
  const h = $("pH").value, mi = $("pM").value;
  const series = !$("pSeries").hidden;

  if (series && season !== "" && +season < 1) return progressError("Season must be 1 or higher.", "pSeason");
  if (series && episode !== "" && +episode < 1) return progressError("Episode must be 1 or higher.", "pEpisode");
  if (series) {
    const chk = checkProgress(season, episode);
    if (chk.season && !chk.season.warn) return progressError(chk.season.msg, "pSeason");
    if (chk.episode && !chk.episode.warn) return progressError(chk.episode.msg, "pEpisode");
  }
  if (series) {
    const st = checkStatus(season, episode);
    if (st && !st.warn) return progressError(st.msg, null);
  }
  const noTime = series && (pSheet.release === "ended" || pSheet.release === "out");
  if (!noTime && mi !== "" && +mi > 59) return progressError("Minutes must be between 0 and 59.", "pM");

  return {
    season: series && season !== "" ? String(+season) : "",
    episode: series && episode !== "" ? String(+episode) : "",
    th: noTime || !(+h) ? "" : String(+h),
    tm: noTime || !(+mi) ? "" : String(+mi),
    release: series ? pSheet.release : "",
    days: [],
    remind: false,
    remindTime: "",
    updated: Date.now(),
  };
}

function saveProgress() {
  if (!pSheet) return;
  const data = readProgress();
  if (!data) return;
  const m = items.find((x) => x.id === pSheet.id);
  if (m) {
    m.progress = data;
    if (pSheet.starting || data.release === "out") delete m.pin;
    if (data.release === "out") {
      // Show completed: it goes straight to Watched.
      m.done = true; m.watching = false; m.watchedAt = Date.now();
      toast(`${m.title} moved to Watched`);
    } else if (pSheet.starting) { m.watching = true; m.done = false; tab = "watching"; }
    save();
  }
  closeProgress();
  render();
}

// Number fields accept digits only.
["pSeason", "pEpisode", "pH", "pM"].forEach((id) => {
  $(id).addEventListener("input", (e) => {
    const v = e.target.value.replace(/\D/g, "");
    if (v !== e.target.value) e.target.value = v;
    $("pError").textContent = "";
    paintProgressCheck();
  });
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveProgress(); } });
});

$("pSheet").addEventListener("click", (e) => {
  if (!pSheet) return;
  const r = e.target.closest("[data-prel]");
  if (r) {
    pSheet.release = pSheet.release === r.dataset.prel ? "" : r.dataset.prel; // click again to clear
    paintRelease();
    $("pError").textContent = "";
    paintProgressCheck();
  }
});

$("pCancel").addEventListener("click", closeProgress);
$("pSave").addEventListener("click", saveProgress);

/* ---------------- popover menus ---------------- */
function showMenu(anchor, html, key) {
  const menu = $("menu");
  menu.innerHTML = html;
  menu.hidden = false;
  menuOpen = key;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

function closeMenu() {
  $("menu").hidden = true;
  menuOpen = null;
}

function storageHtml() {
  const s = storageInfo();
  const titles = `${s.count} ${s.count === 1 ? "title" : "titles"}`;
  const where = fileStore
    ? `<div class="mi" data-act="reveal"><span class="mi-body">Show list file in ${/win/i.test(navigator.platform) ? "File Explorer" : "Finder"}<small>Copy it to back up or move to a new computer</small></span></div>`
    : "";
  const signed = !!(window.Sync && Sync.getSession());
  const iosBrowser = !!(window.__isIOS && !window.__isStandalone && !window.Capacitor);
  const here = fileStore ? "" : signed ? "Backed up to your account."
    : iosBrowser ? "Saved only in Safari on this device, and Safari can clear it after about 7 days without a visit. Sign in to back it up."
    : `Saved only in this ${window.Capacitor || window.__isStandalone ? "app" : "browser"} on this device. Sign in to back it up.`;
  return `<div class="storage">
    <small>${titles} · ${fmtBytes(s.used)}${fileStore ? " · no limit" : keepPosterData ? "" : " of about 5 MB"}</small>${here ? `<small class="where">${here}</small>` : ""}
  </div>${where}`;
}

function topMenuHtml() {
  const seg = ["light", "dark", "system"].map((v) =>
    `<button class="seg ${theme === v ? "on" : ""}" data-act="theme" data-val="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`
  ).join("");
  const pin = window.api && window.api.setPin ? `
    <div class="mi" data-act="pin">
      <span class="mi-body">Keep on top<small>Stay above other apps</small></span>
      <span class="mi-state">${pinned ? "On" : "Off"}</span>
    </div>` : "";
  return `${pin}
    <div class="mi mi-static">Appearance</div>
    <div class="seg-row">${seg}</div>
    <div class="mi mi-static">Storage</div>
    ${storageHtml()}
    ${installHtml()}
    ${transferHtml()}
    ${accountHtml()}
    <div class="mi" data-act="key"><span class="mi-body">API key</span></div>
    <div class="mi" data-act="about"><span class="mi-body">About &amp; developer</span></div>`;
}

// Web / phone only: offer to install the app on the home screen.
function installHtml() {
  if (window.__canInstall && window.__canInstall())
    return `<div class="mi" data-act="install"><span class="mi-body">Install app<small>Add Watchlist to your home screen or desktop</small></span></div>`;
  if (window.__showIOSInstall && window.__showIOSInstall())
    return `<div class="mi" data-act="howto"><span class="mi-body">Install app<small>Add to your Home Screen: tap for the steps</small></span></div>`;
  return "";
}

// Browser / phone only: copy the list out and paste it into another browser or the Home Screen app.
function transferHtml() {
  if (fileStore) return "";
  return `<div class="mi" data-act="xfer"><span class="mi-body">Move my list<small>Copy it to another browser or the Home Screen app</small></span></div>`;
}

function itemMenuHtml(id) {
  const m = items.find((x) => x.id === id);
  if (!m) return "";
  const mi = (act, label, cls = "") =>
    `<div class="mi ${cls}" data-act="${act}" data-id="${id}"><span class="mi-body">${label}</span></div>`;
  let out = "";
  if (m.done) {
    out += mi("towatching", "Move back to Watching");
    out += mi("toback", "Move back to To watch");
  } else if (m.watching) {
    out += mi("progress", "Update progress");
    out += mi("finish", "Mark as watched");
    out += mi("toback", "Move back to To watch");
  } else {
    out += mi("start", "Move to watching");
    out += mi("finish", "Mark as watched");
  }
  if (!m.done) out += mi("pinitem", m.pin ? "Unpin" : "Pin to top");
  if (isReorderable()) {
    const vis = tabList();
    const i = vis.findIndex((x) => x.id === id);
    if (i > 0 && !!vis[i - 1].pin === !!m.pin) out += mi("up", "Move up");
    if (i >= 0 && i < vis.length - 1 && !!vis[i + 1].pin === !!m.pin) out += mi("down", "Move down");
  }
  if (m.tmdbId) out += mi("share", "Share");
  out += mi("edit", "Edit");
  out += mi("remove", "Remove", "danger");
  return out;
}

function applyTheme(v) {
  document.documentElement.setAttribute("data-theme", v);
}

function setTheme(v) {
  theme = v;
  applyTheme(v);
  try { localStorage.setItem(THEME_KEY, v); } catch {}
  if (window.api && window.api.setTheme) window.api.setTheme(v);
}

async function togglePin() {
  if (window.api && window.api.setPin) pinned = await window.api.setPin(!pinned);
}

function handleAct(act, id, val) {
  if (act === "theme") {
    setTheme(val);
    $("menu").innerHTML = topMenuHtml(); // keep the menu open to show the change
    return;
  }
  closeMenu();
  if (act === "pin") return togglePin();
  if (act === "install") return window.__installApp && window.__installApp();
  if (act === "howto") return openHowto();
  if (act === "xfer") return openXfer();
  if (act === "key") return openPanel();
  if (act === "about") return openAbout();
  if (act === "login") return openAccount();
  if (act === "devices") return openDevices();
  if (act === "logout") return doLogout();
  if (act === "reveal") return window.api && window.api.revealList && window.api.revealList();
  const m = items.find((x) => x.id === id);
  if (act === "start" && m) {
    // Nothing moves yet. The title only moves to Watching when the progress is saved.
    openProgress(m, true);
  }
  else if (act === "progress" && m) openProgress(m);
  else if (act === "finish" && m) { delete m.pin; m.done = true; m.watching = false; m.watchedAt = Date.now(); save(); render(); }
  else if (act === "towatching" && m) {
    delete m.pin;
    m.done = false; m.watching = true;
    // A completed show is no longer complete once you are watching it again.
    if (m.progress && relOf(m.progress) === "out") m.progress.release = "";
    save(); tab = "watching"; render();
  }
  else if (act === "toback" && m) {
    delete m.pin;
    if (m.done) { m.done = false; m.watching = false; } else m.watching = false;
    // Moving back to To watch means it is no longer a completed show.
    if (m.progress && relOf(m.progress) === "out") m.progress.release = "";
    save(); render();
  }
  else if (act === "pinitem" && m) {
    if (m.pin) delete m.pin;
    else {
      const n = items.filter((x) => !x.done && !!x.watching === !!m.watching && x.pin).length;
      if (n >= PIN_MAX) { toast(`You can pin up to ${PIN_MAX} titles in ${m.watching ? "Watching" : "To watch"}. Unpin one first.`); return; }
      m.pin = true;
    }
    save(); render();
  }
  else if ((act === "up" || act === "down") && m) moveStep(id, act === "up" ? -1 : 1);
  else if (act === "edit" && m) openEdit(m);
  else if (act === "share" && m) shareTitle(m);
  else if (act === "remove" && m) {
    const at = items.indexOf(m);
    forgetTitleKeys(m);
    items = items.filter((x) => x.id !== id);
    save(); render();
    // One tap on a small menu is easy to get wrong on a phone: offer a way back.
    toast(`${m.title} removed`, { label: "Undo", run: () => {
      if (items.some((x) => x.id === m.id)) return;
      items.splice(Math.min(Math.max(at, 0), items.length), 0, m);
      save(); render();
    } });
  }
}

$("list").addEventListener("scroll", closeMenu);
window.addEventListener("resize", closeMenu);

// Closes the layer on top (popup, sheet or menu). Returns true if something was closed.
function closeTopLayer() {
  if (!$("person").hidden) closePerson();
  else if (!$("shareIn").hidden) closeShareIn();
  else if (!$("tinfo").hidden) closeTinfo();
  else if (pSheet) closeProgress();
  else if (sheet) closeSheet();
  else if (!$("consent").hidden) declineSync();
  else if (!$("coll").hidden) closeColl();
  else if (!$("devices").hidden) closeDevices();
  else if (!$("account").hidden) closeAccount();
  else if (!$("howto").hidden) closeHowto();
  else if (!$("xfer").hidden) closeXfer();
  else if (!$("about").hidden) closeAbout();
  else if (!$("panel").hidden) closePanel();
  else if (menuOpen !== null) closeMenu();
  else return false;
  return true;
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeTopLayer(); });

// Phone / browser Back button (and swipe-back) closes the open sheet instead of leaving the app.
(function backClosesSheets() {
  if (window.api || !window.history || !history.pushState) return;
  const panels = [...document.querySelectorAll(".panel")];
  const anyOpen = () => panels.some((p) => !p.hidden);
  let pushed = false;
  const sync = () => {
    if (anyOpen() && !pushed) { try { history.pushState({ wlPanel: 1 }, ""); pushed = true; } catch {} }
    else if (!anyOpen() && pushed) {
      pushed = false; // closed from the screen: drop the extra history entry we added
      try { if (history.state && history.state.wlPanel) history.back(); } catch {}
    }
  };
  new MutationObserver(sync).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("popstate", () => {
    if (!pushed) return;
    pushed = false; // the entry is already gone
    closeTopLayer();
    sync();         // another sheet is still open: keep Back working for it
  });
})();

/* ---------------- search events ---------------- */
// Typing: debounce, then search TMDB.
$("title").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("title").value.trim();
  if (q.length < 2) { closeResults(); return; }
  sel = 0;
  plainPicked = false;
  results = []; // never show or pick results that belong to an older query
  status = canSearch() ? "loading" : "nokey";
  renderResults();
  searchTimer = setTimeout(() => doSearch(q), 300);
});

// Arrow keys / Escape inside the search box.
$("title").addEventListener("keydown", (e) => {
  const open = !$("results").hidden;
  const total = 1 + results.length;
  if (e.key === "ArrowDown" && open) {
    e.preventDefault();
    sel = (sel + 1) % total;
    plainPicked = sel === 0;
    renderResults();
  } else if (e.key === "ArrowUp" && open) {
    e.preventDefault();
    sel = (sel - 1 + total) % total;
    plainPicked = sel === 0;
    renderResults();
  } else if (e.key === "Escape") {
    closeResults();
  }
});

// Enter / Add: open the add sheet for the highlighted row (best match by default).
// Nothing is added to the list until you confirm in the sheet.
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("title").value.trim();
  if (!q) return;

  clearTimeout(searchTimer);
  if (!plainPicked && canSearch() && (status === "loading" || !results.length)) await doSearch(q);

  if (!plainPicked && sel > 0 && results[sel - 1]) startAddFromResult(results[sel - 1]);
  else startAddPlain(q);
});

$("fPrio").addEventListener("change", (e) => { fPrio = +e.target.value; render(); });

// Search inside Watching
$("wSearchBtn").addEventListener("click", () => {
  wOpen = !wOpen;
  if (!wOpen) wQuery = "";
  render();
  if (wOpen) { try { $("wQ").focus(); } catch {} }
});
$("wQ").addEventListener("input", (e) => { wQuery = e.target.value; render(); });
$("wQ").addEventListener("keydown", (e) => { if (e.key === "Escape") { wQuery = ""; wOpen = false; render(); } });
$("wQx").addEventListener("click", () => { wQuery = ""; wOpen = false; render(); });

/* ---------------- click handling ---------------- */
document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.id === "sheet") return closeSheet(); // click on the dimmed backdrop
  if (t.id === "pSheet") return closeProgress();
  if (!t.closest("#search")) closeResults();

  // Similar titles (Watched tab)
  const sb = t.closest("[data-similar]");
  if (sb) { closeMenu(); openSimilar(+sb.dataset.similar); return; }

  // menus
  const mb = t.closest("[data-menu]");
  if (mb) {
    const id = +mb.dataset.menu;
    if (menuOpen === id) closeMenu(); else showMenu(mb, itemMenuHtml(id), id);
    return;
  }
  if (t.closest("#menuBtn")) {
    if (menuOpen === "top") closeMenu(); else showMenu($("menuBtn"), topMenuHtml(), "top");
    return;
  }
  const actEl = t.closest("[data-act]");
  if (actEl) { handleAct(actEl.dataset.act, +actEl.dataset.id, actEl.dataset.val); return; }
  const hadMenu = menuOpen !== null;
  if (!t.closest("#menu")) closeMenu();

  // everything else
  const el = t.closest("[data-rate],[data-tab],[data-res],[data-plain],[data-sstar],[data-progress],[data-coll],[data-fr],[data-colldone],[data-simmore],[data-dadd],[data-dno],[data-drow],[data-pkgo]");
  if (!el) {
    // a tap on a tile in To watch / Watched (not on a button, star or link) opens the small details popup
    const row = t.closest("#list [data-row]");
    if (row && !hadMenu && (tab === "watch" || tab === "done") && !t.closest("button,a,input,select,textarea")) openTinfo(items.find((x) => x.id === +row.dataset.row));
    return;
  }
  const d = el.dataset;

  if (d.dadd) return discAdd(d.dadd);
  if (d.dno) return discNo(d.dno);
  if (d.pkgo !== undefined) { const [pid, ps] = d.pkgo.split("|"); return pkGo(pid, +ps); }
  if (d.drow) return discOpen(d.drow);
  if (d.simmore !== undefined) return showMoreSimilar();
  if (d.colldone !== undefined) { collDoneOpen = !collDoneOpen; renderCollectionsTab(false); return; }
  if (d.coll) return openCollection(+d.coll);
  if (d.fr) return openFranchise(d.fr);
  if (d.progress) { const pm = items.find((x) => x.id === +d.progress); if (pm) openProgress(pm); return; }
  if (d.res !== undefined) return startAddFromResult(results[+d.res]);
  if (d.plain !== undefined) return startAddPlain($("title").value.trim());
  if (d.sstar) { if (sheet) { sheet.stars = +d.sstar; paintSheetStars(); } return; }
  if (d.rate) {
    const [id, n] = d.rate.split(":").map(Number);
    const m = items.find((x) => x.id === id);
    if (m) { m.stars = n; save(); render(); }
    return;
  }
  if (d.tab) { tab = d.tab; render(); }
});

/* ---------------- API key panel ---------------- */
function setKeyStatus(text, kind = "") {
  const s = $("keyStatus");
  s.textContent = text;
  s.className = "panel-status " + kind;
}

function openPanel() {
  $("keyInput").value = userKey;
  if (userKey) setKeyStatus("Using your own key.", "ok");
  else if (PROXY_URL) setKeyStatus("Using the built-in search.", "ok");
  else setKeyStatus("");
  $("panel").hidden = false;
  focusSoft($("keyInput"));
}
function closePanel() {
  $("panel").hidden = true;
  focusSearch();
}

$("keyClose").addEventListener("click", closePanel);
// A real link. In the desktop app it opens in the default browser; elsewhere the browser handles it.
$("openTmdb").addEventListener("click", (e) => {
  if (window.api && window.api.openExternal) {
    e.preventDefault();
    window.api.openExternal($("openTmdb").href);
  }
});

$("keySave").addEventListener("click", async () => {
  const key = $("keyInput").value.trim();
  if (!key) { setKeyStatus("Paste your key first.", "err"); return; }
  setKeyStatus("Checking key…");
  try {
    await tmdb("/configuration", {}, key);
    userKey = key;
    localStorage.setItem(KEY_STORE, key);
    setKeyStatus("Key works. You can search now.", "ok");
    render();
    setTimeout(closePanel, 700);
  } catch {
    setKeyStatus("That key did not work. Check it and try again.", "err");
  }
});

$("keyRemove").addEventListener("click", () => {
  userKey = "";
  try { localStorage.removeItem(KEY_STORE); } catch { /* storage blocked */ }
  $("keyInput").value = "";
  setKeyStatus(PROXY_URL ? "Your key was removed. Using the built-in search." : "Key removed.");
  render();
});

$("keyInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("keySave").click();
});

/* ---------------- Cloud backup & sync ---------------- */

function syncActive() {
  return !!(window.Sync && Sync.configured() && Sync.getSession() && Sync.getMeta().enabled);
}

function accountHtml() {
  if (!window.Sync || !Sync.configured()) return "";
  const sess = Sync.getSession();
  if (!sess) {
    return `<div class="mi" data-act="login"><span class="mi-body">Back up &amp; sync<small>Optional. Keep your list on all your devices</small></span></div>`;
  }
  let line = "Signed in";
  if (!Sync.getMeta().enabled) line = "Sync is off";
  else if (syncState.kind === "syncing") line = "Syncing…";
  else if (syncState.kind === "offline") line = "Offline. Will sync when back online";
  else if (syncState.kind === "error") line = "Could not sync. Will retry";
  else if (syncState.at) line = "Synced " + ago(syncState.at);
  return `<div class="mi mi-static">Account</div>
    <div class="storage"><small>${esc(sess.user.email || "")}<br>${line}</small></div>
    <div class="mi" data-act="devices"><span class="mi-body">Devices<small>Up to ${Sync.DEVICE_MAX} devices per account</small></span></div>
    <div class="mi" data-act="logout"><span class="mi-body">Sign out</span></div>`;
}

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return s + " seconds ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
  const h = Math.round(m / 60);
  return h + (h === 1 ? " hour ago" : " hours ago");
}

function scheduleSync() {
  if (!syncActive()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 1500);
}

async function runSync() {
  if (!syncActive()) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  syncState = { kind: "syncing", at: syncState.at }; updateSyncBtn();
  try {
    // Is this device still one of the account's devices? (It may have been removed from another device.)
    if ((await Sync.touchDevice()) === false) { deviceRemoved(); return; }
    do {
      syncAgain = false;
      const since = Sync.getMeta().cursor; // empty means a full comparison
      const rows = await Sync.fetchRows(since);
      // No waiting between reading the list and applying the result, so edits are never lost.
      const meta = Sync.getMeta();
      const res = Sync.merge({ items, tombs: meta.tombs, dirty: meta.dirty, orderTs: meta.orderTs, orderDirty: meta.orderDirty }, rows, !since);
      const before = JSON.stringify(items);
      const oldPoster = new Map(items.map((m) => [String(m.id), m.poster]));
      items = res.items.map(normalizeItem);
      for (const m of items) { // keep the offline poster copies we already have
        const o = oldPoster.get(String(m.id));
        if (m.posterPath && typeof o === "string" && o.startsWith("data:")) m.poster = o;
      }
      resetSigs();
      meta.tombs = res.tombs;
      meta.orderTs = res.orderTs;
      meta.orderDirty = res.push.some((r) => r.item_id === Sync.ORDER_ID) || meta.orderDirty;
      meta.dirty = [...new Set([...meta.dirty, ...res.push.filter((r) => !r.deleted && r.item_id !== Sync.ORDER_ID).map((r) => r.item_id)])];
      if (rows.length) meta.cursor = rows[rows.length - 1].synced_at;
      Sync.setMeta(meta);
      if (JSON.stringify(items) !== before) { saveQuiet(); render(); hydratePosters(); }
      await Sync.pushRows(res.push);
      // Pushed: forget only what was not changed again while we were uploading.
      const now = Sync.getMeta();
      for (const r of res.push) {
        if (r.item_id === Sync.ORDER_ID) { if (now.orderTs === r.updated_at) now.orderDirty = false; }
        else if (r.deleted) { if (now.tombs[r.item_id] === r.updated_at) delete now.tombs[r.item_id]; }
        else {
          const cur = items.find((m) => String(m.id) === r.item_id);
          if (!cur || (cur.updatedAt || 0) === r.updated_at) now.dirty = now.dirty.filter((x) => x !== r.item_id);
        }
      }
      Sync.setMeta(now);
    } while (syncAgain);
    syncState = { kind: "ok", at: Date.now() }; updateSyncBtn();
  } catch (e) {
    if (e.signedOut) {
      const meta = Sync.getMeta(); meta.enabled = false; Sync.setMeta(meta);
      syncState = { kind: "", at: 0 }; updateSyncBtn();
      try { toast("You were signed out. Sign in again to keep syncing."); } catch {}
    } else {
      syncState = { kind: e.offline ? "offline" : "error", at: syncState.at }; updateSyncBtn();
    }
  } finally {
    syncing = false;
  }
}

// Write the local file after a sync changed the list, without counting it as a person's edit.
function saveQuiet() {
  const json = listJson();
  try {
    if (fileStore) window.api.saveList(json);
    else localStorage.setItem(STORE_KEY, json);
    lastBytes = json.length;
  } catch {}
}

setInterval(() => { if (!document.hidden) runSync(); }, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) runSync(); });

/* ---- posters: only the TMDB path is synced, each device keeps its own picture ---- */
let hydrating = false, hydrateAgain = false;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function hydratePosters() {
  if (hydrating) { hydrateAgain = true; return; }
  hydrating = true;
  try {
    ensureOtt(); // To watch titles: has it reached a streaming service yet? (starts at once, runs alongside the rest)
    // Titles saved before this change: learn the poster path once (no image is downloaded for this).
    let learned = false;
    for (const m of items.filter((x) => x.tmdbId && x.posterPath === undefined)) {
      if (typeof m.poster === "string" && m.poster.startsWith(IMG_SAVED)) { m.posterPath = m.poster.slice(IMG_SAVED.length); learned = true; continue; }
      if (!canSearch()) break;
      try {
        const d = await tmdb("/" + (m.type === "tv" ? "tv" : "movie") + "/" + m.tmdbId);
        m.posterPath = d && d.poster_path ? d.poster_path : "";
        learned = true;
      } catch { break; } // offline or not available yet: try again next time
      await pause(1100); // stay under the search limit (60 a minute)
    }
    if (learned) { save(); render(); }

    // First: which collection / franchise does each title belong to? (the poster copies below can wait)
    ensureFranchises(); // series (and movies already checked): starts at once, runs alongside the rest
    await learnCollections(); // one lookup a second, only for movies not checked yet
    ensureFranchises(); // movies that just turned out to be in no collection

    // Keep a copy of each poster on this device so it also shows offline.
    let changed = false;
    for (const m of keepPosterData ? items.filter((x) => x.posterPath && !String(x.poster || "").startsWith("data:")) : []) {
      try { m.poster = await toDataUrl(IMG_SAVED + m.posterPath); changed = true; } catch {}
    }
    if (changed) { saveQuiet(); render(); }
  } finally {
    hydrating = false;
  }
  if (hydrateAgain) { hydrateAgain = false; hydratePosters(); }
}

function deviceRemoved() {
  const meta = Sync.getMeta(); meta.enabled = false; Sync.setMeta(meta);
  Sync.clearSession();
  syncState = { kind: "", at: 0 }; updateSyncBtn();
  toast("This device is no longer signed in to your account. Sign in again to keep syncing.");
}

/* ---------------- OTT tag (To watch) ---------------- */
// A digital release counts as "on OTT": subscription, free, ad-supported, or rent / buy. Which countries count is decided by digitalFind (main markets at once, others only after 45 days).
// m.ott = { t, s, at, c }  t: 1 = tracked (it was NOT streaming when first checked), 0 = already streaming then, so never tagged
//                          s: 1 = it has reached OTT since, at = when the app noticed, c = last check
// rd = release date. A tracked title with a future date shows "Not released yet". The tag "Available to stream" stays 30 days. "No OTT release yet" shows while a tracked, recent title is still not streaming.
const OTT_RECHECK = 12 * 3600e3, OTT_TAG_DAYS = 30, OTT_CONFIRM = 3600e3, OTT_V = 5; // OTT_V: answers saved by an older version of this check are dropped and asked again
let ottRunning = false;
const todayIso = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
// Whole days from a date (YYYY-MM-DD) to today, both on the calendar of this device: 0 = today, 1 = yesterday, -1 = tomorrow.
// (Date.parse of a bare YYYY-MM-DD is midnight UTC, which is off by a day for several hours each day in some time zones.)
const daysSince = (iso) => { const a = Date.parse(String(iso || "").slice(0, 10) + "T00:00:00"), b = Date.parse(todayIso() + "T00:00:00"); return isNaN(a) ? NaN : Math.round((b - a) / 864e5); };
// Streaming data from JustWatch (via TMDB) has bad entries in small countries: Jailer 2 was listed on Sun NXT in Andorra, Albania, Malta and others
// while still in cinemas. So a listing in a main market counts at once; a listing only in other countries counts once the title is 45+ days old.
const OTT_MAIN = new Set(["IN", "US", "GB", "CA", "AU", "NZ", "AE", "SA", "QA", "KW", "OM", "BH", "SG", "MY", "DE", "FR", "ES", "IT", "BR", "MX", "JP", "KR"]);
// Returns { note, cc, young } for the strongest listing, or null. note = what made it count, e.g. "Netflix (IN, flatrate)", saved with the answer so a surprising one can be checked.
// Order: kind (subscription first), then main markets (India first), then other countries. Other countries only count once the release date is known and 45+ days old.
// Unknown release date: small countries never count (a missing date must not open the door to bad data).
const OTT_ORDER = ["IN", ...[...OTT_MAIN].filter((c) => c !== "IN")];
function digitalFind(res, released) {
  const t = released ? daysSince(released) : NaN;
  const age = isNaN(t) ? null : t;
  const all = Object.keys(res || {});
  const order = [...OTT_ORDER.filter((c) => all.includes(c)), ...all.filter((c) => !OTT_MAIN.has(c))];
  for (const k of ["flatrate", "free", "ads", "rent", "buy"]) for (const cc of order) {
    const c = res[cc];
    if (!(c && Array.isArray(c[k]) && c[k].length)) continue;
    if (!OTT_MAIN.has(cc) && !(age !== null && age >= 45)) continue;
    return { note: `${c[k][0].provider_name} (${cc}, ${k})`, svc: wtwName(c[k][0].provider_name), cc, young: age !== null && age < 45 };
  }
  return null;
}
// A LIMITED series (mini-series, or one short season that came out in one go with nothing dated after it) is finished the day its last episode is out:
// no "Ongoing", no "next season". TMDB often keeps such a show as "Returning Series", so it is worked out from the episodes.
// A show that gets a second season (or a dated next episode) stops being limited by itself, because it then fails these checks.
function isLimited(d) {
  if (!d || d.status === "Ended" || d.status === "Canceled") return false;
  const sn = (d.seasons || []).filter((x) => x && x.season_number > 0);
  if ((sn.length || Number(d.number_of_seasons) || 0) > 1) return false;
  const t = todayIso();
  const rawNx = d.next_episode_to_air && d.next_episode_to_air.season_number > 0 ? d.next_episode_to_air : null;
  if (rawNx && !(rawNx.air_date && rawNx.air_date <= t)) return false; // a later episode is dated: still airing (a date that has passed counts as out)
  const ls = d.last_episode_to_air && d.last_episode_to_air.season_number > 0 ? d.last_episode_to_air : null;
  const eps = Number(d.number_of_episodes) || (sn[0] && Number(sn[0].episode_count)) || 0;
  const lastNo = Math.max(ls ? Number(ls.episode_number) || 0 : 0, rawNx ? Number(rawNx.episode_number) || 0 : 0);
  const lastDay = [ls && ls.air_date, rawNx && rawNx.air_date].filter(Boolean).sort().pop() || "";
  if (!lastDay || (eps && lastNo < eps)) return false; // some episodes are still to come
  if (d.type === "Miniseries") return true;
  const first = d.first_air_date || "";
  if (first && eps > 0 && eps <= 8 && (Date.parse(lastDay) - Date.parse(first)) / 864e5 <= 7) return true; // the whole short season came out within a week (one day for a binge drop)
  return d.in_production === false && eps > 0 && eps <= 12;
}
// Series that are still airing: where is the run now? (from TMDB's last / next episode)
// og.k: "air" = episodes coming out (w: 1 when they come about a week apart), "soon" = next season is dated, "gap" = between seasons
function airState(d) {
  if (!(d.status === "Returning Series" || d.status === "In Production")) return { end: 1 };
  if (isLimited(d)) return { end: 1 }; // a limited series is not "Ongoing" once its last episode is out
  const nx = d.next_episode_to_air && d.next_episode_to_air.season_number > 0 ? d.next_episode_to_air : null;
  const ls = d.last_episode_to_air && d.last_episode_to_air.season_number > 0 ? d.last_episode_to_air : null;
  if (!ls && !nx) return {}; // nothing aired and nothing dated: the release date rules decide
  const total = (n) => { const x = (d.seasons || []).find((z) => z.season_number === n); return x ? Number(x.episode_count) || 0 : 0; };
  if (nx && ls && nx.season_number === ls.season_number) {
    const gap = nx.air_date && ls.air_date ? (Date.parse(nx.air_date) - Date.parse(ls.air_date)) / 864e5 : 0;
    return { og: { k: "air", w: gap >= 5 && gap <= 9 ? 1 : 0, s: nx.season_number, a: Math.max(0, (Number(nx.episode_number) || 1) - 1) } };
  }
  if (nx) return { og: { k: "soon", s: nx.season_number, d: nx.air_date || "" } };
  const e = total(ls.season_number);
  const recent = ls.air_date && daysSince(ls.air_date) <= 21; // TMDB's season total is often out of date, so a recent episode also means it is still airing
  if ((e && ls.episode_number < e) || recent) return { og: { k: "air", w: 0, s: ls.season_number, a: ls.episode_number } }; // next episode not dated yet
  return { og: { k: "gap", s: ls.season_number } };
}
// Third source: Wikidata, found through the TMDB id. A fallback only, asked when TMDB says "not streaming" (at most every 3 days per title).
// It can fill in a missing release date, and tell when a SERIES is an original of a streaming service (original broadcaster) that has already started.
// Films are not judged by their distributor: that is often just the company that bought the OTT rights, before the film is streaming.
// It has no weekly schedule or episode counts for running shows, so the airing tags still come from TMDB alone.
const WD_RECHECK = 3 * 864e5;
let gemCool = 0; // after a rate-limit / busy answer the app stops asking Gemini for a while: the similar-titles features come first
const gemCoolCheck = (msg) => { if (/rate limit|resting|busy|waiting|429/i.test(String(msg || ""))) gemCool = Date.now() + 5 * 60e3; };
const GEM_RETRY = 3600e3; // a streaming title with no service named yet: ask the Gemini search again after this long
const STREAMERS = /netflix|prime video|amazon|disney\+|hotstar|apple tv|hbo|\bmax\b|sony ?liv|zee ?5|hulu|paramount\+|peacock|crunchyroll|manorama|sun nxt|mubi|discovery\+|aha\b|viu\b|iqiyi|wetv/i;
async function wikidataRelease(kind, id) {
  const tv = kind === "tv";
  const q = `SELECT (MIN(?d) AS ?date) (GROUP_CONCAT(DISTINCT ?l; separator="|") AS ?svc) WHERE {
    ?x wdt:${tv ? "P4983" : "P4947"} "${Number(id)}" .
    OPTIONAL { ?x wdt:P577|wdt:P580 ?d }
    OPTIONAL { ?x wdt:P449 ?s . ?s rdfs:label ?l . FILTER(LANG(?l) = "en") }
  }`;
  const r = await fetch(WD_URL + "?format=json&query=" + encodeURIComponent(q), { headers: { Accept: "application/sparql-results+json" }, signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const b = ((await r.json()).results.bindings || [])[0] || {};
  return { date: b.date ? String(b.date.value).slice(0, 10) : "", svc: b.svc && b.svc.value ? b.svc.value.split("|") : [] };
}
// First check for a FILM, from TMDB's own release dates (type 4 = digital, 2 / 3 = cinema). A film that was never in cinemas and whose
// digital date is today or earlier in a main market is on a streaming service. A film that did play in cinemas only counts when its
// digital date has passed in India (a US rental date is not "on OTT" for you). Returns a note such as "TMDB digital release (IN, 2026-11-04)", or "".
function tmdbDigital(d) {
  const rs = d && d.release_dates && d.release_dates.results;
  if (!Array.isArray(rs)) return { note: "", noTheatre: false };
  const today = todayIso();
  const all = rs.flatMap((r) => (r.release_dates || []).map((x) => ({ cc: r.iso_3166_1, t: x.type, d: String(x.release_date || "").slice(0, 10) })));
  const noTheatre = !all.some((x) => x.t === 2 || x.t === 3);
  const dig = all.filter((x) => x.t === 4 && x.d && x.d <= today && OTT_MAIN.has(x.cc)).sort((a, b) => (a.cc === "IN" ? 0 : 1) - (b.cc === "IN" ? 0 : 1) || a.d.localeCompare(b.d))[0];
  return { note: dig ? `TMDB digital release (${dig.cc}, ${dig.d})` : "", cc: dig ? dig.cc : "", dd: dig ? dig.d : "", noTheatre };
}
// First check for a SERIES, from TMDB's own data: the first episode date has passed and the show's network is a streaming service
// (e.g. "Prime Video"). Covers a whole-season drop that JustWatch has not listed yet. Returns a note, or "".
function tmdbTvOut(d) {
  if (!d) return null;
  const nx = d.next_episode_to_air, ls = d.last_episode_to_air;
  const first = d.first_air_date || (ls && ls.air_date) || (nx && nx.season_number === 1 && (Number(nx.episode_number) || 1) <= 1 && nx.air_date) || "";
  if (!first || first > todayIso()) return null;
  const net = (d.networks || []).map((n) => n && n.name).find((n) => n && STREAMERS.test(n));
  return net ? { note: `Network: ${net}, premiered ${first}`, svc: wtwName(net) } : null;
}
async function ensureOtt() {
  if (ottRunning || !canSearch()) return;
  ottRunning = true;
  try {
    let changed = false;
    const gemJobs = []; // titles for the Gemini search, asked after the loop
    for (const m of items.filter((x) => x.tmdbId && inTab(x, "watch"))) {
      if (m.ott && m.ott.v !== OTT_V) delete m.ott;
      // Answers that only rested on a TMDB date, a network name or Wikidata, with no service named, are asked again from scratch (once, after this update)
      if (m.ott && m.ott.f !== 3 && !m.ott.sv && m.ott.n && /^(TMDB|Wikidata|Network)/.test(m.ott.n)) m.ott = { v: OTT_V, t: m.ott.t, rd: m.ott.rd, c: 0 }; // asked again, but whether it was already streaming when added is kept
      if (m.ott && m.ott.f !== 3 && (m.type === "tv" || (m.ott.t === 1 && m.ott.s !== 1))) m.ott.c = 0; // one fresh check after this update
      const o = m.ott || {};
      const tv = m.type === "tv";
      const settled = o.t === 0 || o.s === 1; // already streaming when added, or already tagged
      // A film that counts as streaming but has no service named yet (only a TMDB date / Wikidata said so): TMDB is not asked again, only the Gemini
      // search, every hour, for up to 180 days. (Before, such a film was "settled" and never looked at again after its first Gemini answer.)
      const unconfirmed = !tv && settled && (!o.sv || !!o.wk) && !!o.rd && o.rd <= todayIso() && daysSince(o.rd) <= 180;
      if (unconfirmed) {
        // 1) TMDB's own provider list first (cheap, and often ahead of the Gemini search); 2) only then the Gemini search, every hour.
        if (Date.now() - (o.c || 0) > GEM_RETRY) {
          try {
            const pv = await tmdb("/movie/" + m.tmdbId + "/watch/providers");
            const hit = digitalFind(pv && pv.results, o.rd);
            m.ott.c = Date.now();
            if (hit && hit.svc) { m.ott.sv = hit.svc; m.ott.sc = hit.cc || ""; delete m.ott.wk; m.ott.n = hit.note; changed = true; render(); }
            await pause(1100);
          } catch { /* TMDB busy: next time */ }
        }
        if (!(m.ott && m.ott.sv && !m.ott.wk) && SIMILAR_URL && Date.now() - (o.g || 0) > GEM_RETRY) gemJobs.push(m);
        continue;
      }
      if (tv ? (o.end && settled) : settled) continue; // a series that is still airing keeps being checked
      const fresh = o.rd && Math.abs(daysSince(o.rd)) <= 14; // released in the last 14 days (or about to): look every 3 hours
      if (o.c && Date.now() - o.c < (o.p ? OTT_CONFIRM : fresh ? 3 * 3600e3 : OTT_RECHECK)) continue; // o.p: a first sighting waiting for its second check
      const path = "/" + (tv ? "tv" : "movie") + "/" + m.tmdbId;
      let on = o.t === 0 || o.s === 1, d = null, note = o.n || "", pending = false, noTheatre = false;
      let svc = o.sv || "", scc = o.sc || "", weak = !!o.wk, dpend = ""; // svc: the service found; weak: only a TMDB date / network / Wikidata says so, no streaming guide does
      try {
        if (o.t === undefined || (o.t === 1 && o.s !== 1)) {
          let prov = null;
          try { d = await tmdb(path, { append_to_response: tv ? "watch/providers" : "watch/providers,release_dates" }); prov = d && d["watch/providers"] && d["watch/providers"].results; } catch { d = null; }
          if (!d && !tv) { try { d = await tmdb(path, { append_to_response: "watch/providers" }); prov = d && d["watch/providers"] && d["watch/providers"].results; } catch { d = null; } } // an older server may not know release_dates yet // one request for both; an older server only answers the plain ones
          if (!prov) { const pv = await tmdb(path + "/watch/providers"); prov = pv && pv.results; d = null; }
          const td = !tv && d ? tmdbDigital(d) : null;
          noTheatre = !!(td && td.noTheatre);
          const tn = tv && d ? tmdbTvOut(d) : null;
          // 1) a streaming-guide listing (JustWatch, via TMDB) names the service: that is the only proof. 2) A TMDB network name or digital date is just a hint:
          // a series from a streaming network that has premiered counts (service = that network); a film's digital date counts only after 3 days
          // (until then the Gemini search below has to find it). Either way the Gemini search is asked to confirm and to name the platform.
          let f = digitalFind(prov, (d && (d.release_date || d.first_air_date)) || o.rd || "");
          weak = false;
          if (!f && tn) { f = { note: tn.note, svc: tn.svc, cc: "" }; weak = true; }
          else if (!f && td && td.note && td.dd) {
            // a film that never played in cinemas, or whose digital date is in India, counts on that date at once; one that played in cinemas and has its date in another
            // country counts from the day after (a date that is only today may still be a rental / pre-order date)
            if (noTheatre || td.cc === "IN" || td.dd < todayIso()) { f = { note: td.note, svc: "", cc: td.cc }; weak = true; }
            else dpend = td.dd;
          }
          note = f ? f.note : "";
          svc = f ? f.svc || "" : "";
          scc = f ? f.cc || "" : "";
          on = !!f;
          // Out in ANY main market counts at once, whichever country you are in (no second look needed).
        }
        if (!d && (tv || (!on && (!o.rd || o.rd > todayIso())))) d = await tmdb(path);
      } catch { break; } // offline or TMDB busy: try again next time
      let rd = d ? (d.release_date || d.first_air_date || "") : (o.rd || "");
      let wAt = o.w || 0;
      if (!on && (tv || !rd || noTheatre) && Date.now() - wAt > WD_RECHECK) {
        try {
          const w = await wikidataRelease(tv ? "tv" : "movie", m.tmdbId);
          wAt = Date.now();
          if (!rd && w.date) rd = w.date;
          if ((tv || noTheatre) && w.date && w.date <= todayIso() && w.svc.some((n) => STREAMERS.test(n))) { on = true; weak = true; svc = wtwName(w.svc.find((n) => STREAMERS.test(n))); note = "Wikidata: " + w.svc.join(", "); } // a streaming-service original that has started
        } catch { /* Wikidata is optional: try again next time */ }
      }
      // Order: 1) TMDB, 2) Wikidata (above), 3) Watchmode, 4) Gemini with live search (JustWatch pages) LAST. Steps 3 and 4 are one server call (?avail=1): the server asks Watchmode first and Gemini only if Watchmode has nothing. Only for a released title under 60 days old that nothing else found streaming, at most
      // every 3 hours. It is asked AFTER every tag is on screen (see gemJobs below): an answer takes 10-40 seconds and must not hold the tags back.
      let gAt = o.g || 0;
      const unconfNow = on && (weak || !svc); // streaming, but no service named
      const gemJob = (!on || weak || unconfNow) && !!SIMILAR_URL && !!rd && rd <= todayIso() && daysSince(rd) <= (unconfNow ? 180 : 60) && Date.now() - gAt > (unconfNow ? GEM_RETRY : 3 * 3600e3);
      const now = Date.now();
      const next = { v: OTT_V, t: o.t === undefined ? (on ? 0 : 1) : o.t, c: now, rd, f: 3 };
      if (on && svc) next.sv = svc;
      if (on && scc) next.sc = scc;
      if (on && weak) next.wk = 1;
      if (gAt) next.g = gAt;
      if (note && on) next.n = note;
      if (pending) next.p = 1;
      if (wAt) next.w = wAt;
      if (next.t === 1) next.s = on ? 1 : 0;
      if (next.t === 1 && on) { next.at = o.at || now; if (o.s !== 1) toast(m.title + " is now available to stream"); }
      if (tv && d && isLimited(d)) next.lim = Number(d.number_of_episodes) || ((d.seasons || []).find((x) => x && x.season_number > 0) || {}).episode_count || 1;
      if (tv && d) { const a = airState(d); if (a.og && !(next.rd > todayIso())) next.og = a.og; if (a.end) next.end = 1; }
      else if (tv) { if (o.og) next.og = o.og; if (o.end) next.end = 1; }
      m.ott = next;
      changed = true;
      render(); // show each tag as soon as it is known
      if (gemJob) gemJobs.push(m);
      await pause(1100); // stay under the request limit
    }
    if (changed) { save(); render(); } // every tag is on screen now
    const askGem = async (m) => {
      try {
        const rr = await fetch(SIMILAR_URL + "?avail=1&type=" + (m.type === "tv" ? "tv" : "movie") + "&id=" + m.tmdbId, { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON }, signal: AbortSignal.timeout(50000) });
        if (!rr.ok) { gemCoolCheck(rr.status === 429 ? "429" : ""); return rr.status === 429; }
        const j = await rr.json();
        if (j && j.error) { gemCoolCheck(j.error); return Date.now() < gemCool; }
        if (!(j && j.ok) || !m.ott) return;
        m.ott.g = Date.now();
        if (j.available && ((m.ott.t === 1 && m.ott.s !== 1) || m.ott.wk || !m.ott.sv)) {
          if (m.ott.t === 1 && m.ott.s !== 1) { m.ott.s = 1; m.ott.at = Date.now(); toast(m.title + " is now available to stream"); }
          m.ott.sv = wtwName(j.service); m.ott.sc = j.country || ""; delete m.ott.wk; // a streaming-guide search named the service: confirmed
          m.ott.n = `${j.service} (${j.country}, ${j.type}), per ${j.via === "watchmode" ? "Watchmode" : "Gemini search"}${j.sources && j.sources[0] ? " (" + j.sources[0] + ")" : ""}`;
        }
        save(); render();
      } catch { /* optional: tried again next time */ }
    };
    // one at a time, 6 seconds apart, at most 3 per pass, and none while Gemini is resting (the similar-titles features come first)
    for (const m of gemJobs.slice(0, 3)) {
      if (Date.now() < gemCool) break;
      const stop = await askGem(m);
      if (stop) break;
      await pause(6000);
    }
  } finally { ottRunning = false; }
}
const fmtDay = (iso) => { const t = new Date(iso + "T00:00:00"); return isNaN(t) ? "" : t.toLocaleDateString(undefined, { day: "numeric", month: "short" }); };
const ottTip = (o) => (o.sv || o.n ? "On " + (o.sv || o.n) + (o.wk ? " (not yet confirmed by a streaming guide)" : "") : "");
function ottTagHtml(m) {
  const o = m.ott;
  if (!o) return "";
  const tag = (cls, txt, tip) => `<div class="ott-row"><span class="ott-tag ${cls}"${tip ? ` title="${esc(tip)}"` : ""}>${esc(txt)}</span></div>`;
  const g = o.og; // a series that is still airing: this comes first, whatever the OTT state
  if (g) {
    if (g.k === "air") {
      const prog = g.a ? `S${g.s}: ${plural(g.a, "episode")} aired` : `S${g.s}: starting`; // progress only: the season's total on TMDB is often wrong
      return tag(g.w ? "wk" : "cine", (g.w ? "Airing weekly" : "Ongoing") + " · " + prog);
    }
    if (g.k === "soon") return g.d && g.d <= todayIso() ? tag("wk", g.d === todayIso() ? `S${g.s} out today` : `S${g.s} out now`) : tag("soon", g.d ? `S${g.s} starts ${fmtDay(g.d)}` : `S${g.s} date not announced`); // a dated season whose day has come is out, not still starting
    return tag("", "Between seasons");
  }
  // "Available to stream" is only for a title that was NOT streaming when it was added and reached a service later (t = 1). One that was already out when added (t = 0) gets no tag.
  // a limited series is finished: say so instead of "Ongoing" and an episode count that never grows. Same rule as every release tag: only for a title that was added BEFORE it was out (t = 1)
  if (o.lim && o.t === 1 && !(o.s === 1 && Date.now() - (o.at || 0) < OTT_TAG_DAYS * 864e5)) return tag("", "Limited series \u00B7 " + plural(o.lim, "episode"), "All episodes are out");
  if (m.type !== "tv") {
    const st = filmStage(m);
    if (st) return tag(st[1], st[0], st[2]);
    if (o.t !== 1 || o.s === 1) return "";
    return (Number(m.year) || 0) >= new Date().getFullYear() - 1 ? tag("", "No OTT release yet") : "";
  }
  if (o.t !== 1) return "";
  if (o.s === 1) return Date.now() - (o.at || 0) < OTT_TAG_DAYS * 864e5 ? tag("on", "Available to stream", ottTip(o)) : "";
  if (o.rd && o.rd > todayIso()) return tag("soon", "Not released yet");
  return (Number(m.year) || 0) >= new Date().getFullYear() - 1 ? tag("", "No OTT release yet") : "";
}
// ONE place decides the release tag of a FILM, for the list and the calendar, so the two never disagree. Returns [text, class, tooltip] or null.
// Order: reached a service after you added it (t = 1, s = 1) -> release day -> in cinemas (first 45 days) -> awaiting OTT. A film that was already
// streaming when added (t = 0) gets no tag. Days are whole calendar days on this device (daysSince): 0 = out today, -1 = out tomorrow.
function filmStage(m, rdIn, cal) {
  const o = m.ott || {};
  if (o.t === 1 && o.s === 1) return Date.now() - (o.at || 0) < OTT_TAG_DAYS * 864e5 ? ["Available to stream", "on", ottTip(o)] : null;
  if (o.t === 0) return null;
  const rd = rdIn || o.rd || "";
  if (!rd) return cal ? null : ["Announced", "ann", "TMDB has no release date for this film yet"];
  const since = daysSince(rd);
  if (isNaN(since)) return null;
  if (since < -1) return cal ? null : ["Not released yet", "soon"]; // the calendar shows the date itself
  if (since === -1) return ["Out tomorrow in cinemas", "cine"];
  if (since === 0) return ["Out today in cinemas", "cine"];
  if (since <= 45) return ["In cinemas", "cine", "No streaming listing in a main market yet"];
  if (!cal && since <= 400) return ["Awaiting OTT", "wait", "Past the usual cinema run. No streaming listing in a main market yet"];
  return null;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) ensureOtt(); });

/* ---------------- Collections (prequels and sequels) ---------------- */
// "John Wick Collection" -> "John Wick collection"
const collName = (n) => (String(n || "").replace(/\s*(film\s+)?collection$/i, "").trim() || "This") + " collection";
const sortParts = (parts) => [...(parts || [])].sort((a, b) => {
  const x = a.release_date || "9999", y = b.release_date || "9999";
  return x < y ? -1 : x > y ? 1 : String(a.title).localeCompare(String(b.title));
});
const collCache = new Map(); // collection id -> { at, data }
let collState = null;        // the collection shown in the sheet

// All films of one collection in release order. Also refreshes the part numbers kept on your titles.
async function getCollection(id, fresh = false) {
  const c = collCache.get(id);
  if (c && !fresh && Date.now() - c.at < 10 * 60 * 1000) return c.data;
  const d = await tmdb("/collection/" + id);
  const data = { id: Number(d.id) || id, name: String(d.name || ""), parts: sortParts(d.parts) };
  collCache.set(id, { at: Date.now(), data });
  if (applyCollection(data)) save();
  return data;
}

function applyCollection(data) {
  let changed = false;
  for (const m of items) {
    if (m.collectionId !== data.id) continue;
    const i = data.parts.findIndex((p) => p.id === m.tmdbId);
    const part = i >= 0 ? i + 1 : m.collectionPart || 0;
    const total = data.parts.length;
    if (m.collectionPart !== part || m.collectionTotal !== total || m.collectionName !== data.name) {
      m.collectionPart = part; m.collectionTotal = total; m.collectionName = data.name;
      changed = true;
    }
  }
  return changed;
}

// Finds out once which collection each movie belongs to (the result is saved, and synced to other devices).
async function learnCollections() {
  if (!canSearch()) return;
  let changed = false;
  for (const m of items.filter((x) => x.tmdbId && (x.type || "movie") === "movie" && x.collectionId === undefined)) {
    try {
      const d = await tmdb("/movie/" + m.tmdbId);
      const bc = d && d.belongs_to_collection;
      if (bc && bc.id) {
        m.collectionId = Number(bc.id);
        m.collectionName = String(bc.name || "");
        await getCollection(m.collectionId); // fills in "part N of M" for every title of that collection
      } else {
        m.collectionId = 0; // checked: not part of a collection
      }
      changed = true;
    } catch { break; } // offline or not available yet: try again next time
    await pause(1100); // stay under the search limit (60 a minute)
  }
  if (changed) { save(); render(); }
}

const inCollection = (m) => m.collectionId > 0 && m.collectionTotal > 1;

// The small line under a title: "Part 2 of 4 in the John Wick collection"
function collLineHtml(m) {
  if (!inCollection(m)) return "";
  const text = m.collectionPart
    ? `Part ${m.collectionPart} of ${m.collectionTotal} in the ${collName(m.collectionName)}`
    : `In the ${collName(m.collectionName)}`;
  return `<span class="coll-line">${esc(text)}</span>`;
}

function collectionGroups() {
  const map = new Map();
  for (const m of items) {
    if (!inCollection(m)) continue;
    let g = map.get(m.collectionId);
    if (!g) { g = { id: m.collectionId, name: m.collectionName, total: m.collectionTotal, mine: [] }; map.set(m.collectionId, g); }
    g.mine.push(m);
  }
  return [...map.values()].sort((a, b) => collName(a.name).localeCompare(collName(b.name)));
}

/* ---- Series franchises (Naruto, The Boys ...) in the Collections tab ---- */
// TMDB has no collections for series, so the shared server list says which franchise a title belongs to.
// What it answers is kept on this device for a week, so the tab opens at once the next time.
const FR_TTL = 24 * 3600 * 1000; // the server answers quickly and is the source of truth: keep this copy for a day only
try { for (const k of Object.keys(localStorage)) if (/^(fri2|frl2|frl3|rel4|rel5):/.test(k)) localStorage.removeItem(k); } catch { /* storage blocked */ } // lists saved by older versions
const kindOf = (m) => (m.type === "tv" ? "tv" : "movie");
function frGet(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v && Date.now() - v.at < FR_TTL ? v : null; } catch { return null; }
}
function frSet(key, v) { try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), ...v })); } catch { /* storage full or blocked */ } }
const frItem = (type, id) => frGet("fri3:" + type + ":" + id);   // { f: franchise id, "" = none }
const frList = (fid) => frGet("frl5:" + fid);                     // { name, list }

async function relatedLookup(type, id, refresh = false) {
  for (let i = 0; i < 24; i++) {
    const r = await fetch(RELATED_URL + "?type=" + type + "&id=" + Number(id) + (refresh && i === 0 ? "&refresh=1" : ""), { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (j.franchise === null || Array.isArray(j.list)) return j;
    if (j.busy && i >= 10) throw new Error("busy"); // still busy after ~30 s: give up for now
    await pause(3000); // being learned or built right now (the "added" call from a moment ago may still be at it): ask again
  }
  throw new Error("timeout");
}

let frBusy = false, frFailAt = 0, frAgain = false;
async function ensureFranchises() {
  if (!RELATED_URL || !canSearch()) return;
  if (frBusy) { frAgain = true; return; } // a run is going: it looks once more when it ends
  if (Date.now() - frFailAt < 15000) return;
  frBusy = true;
  try {
    for (let n = 0; n < 12; n++) {
      const m = items.find((x) => x.tmdbId && !inCollection(x) && !(kindOf(x) === "movie" && x.collectionId === undefined) && !frItem(kindOf(x), x.tmdbId)); // a movie not yet checked for a TMDB collection waits for that
      if (!m) break;
      const j = await relatedLookup(kindOf(m), m.tmdbId);
      if (j.franchise === null) { frSet("fri3:" + kindOf(m) + ":" + m.tmdbId, { f: "" }); continue; }
      frSet("frl5:" + j.franchise, { name: j.name || "", list: j.list });
      for (const x of items) { // every title of yours in this franchise is known now
        if (x.tmdbId && j.list.some((r) => r.id === x.tmdbId && r.media_type === kindOf(x))) frSet("fri3:" + kindOf(x) + ":" + x.tmdbId, { f: j.franchise });
      }
      frSet("fri3:" + kindOf(m) + ":" + m.tmdbId, { f: j.franchise });
      if (tab === "coll" && !collState) renderCollectionsTab(false);
    }
  } catch { frFailAt = Date.now(); setTimeout(ensureFranchises, 16000); /* server busy or offline: try again shortly */ }
  frBusy = false;
  if (tab === "coll" && !collState) renderCollectionsTab(false);
  if (frAgain) { frAgain = false; ensureFranchises(); }
}

// One rule for what a franchise list shows (used by the row count and by the window): released titles only,
// no documentaries, and no talk / reality / news / soap after-shows unless the franchise itself is one.
const AFTER_GENRES = [10764, 10767, 10763, 10766];
function franchiseShown(list) {
  const talk = (r) => (r.genres || []).some((g) => AFTER_GENRES.includes(g.id));
  const keepT = list.filter(talk).length * 2 >= list.length;
  return list.filter((r) => r.release_date || r.first_air_date)
    .filter((r) => keepT || !talk(r))
    .filter((r) => !(r.genres || []).some((g) => g.id === 99));
}

function franchiseGroups() {
  const map = new Map();
  for (const m of items) {
    if (!m.tmdbId || inCollection(m)) continue;
    const v = frItem(kindOf(m), m.tmdbId);
    if (!v || !v.f) continue;
    let g = map.get(v.f);
    if (!g) { const L = frList(v.f); g = { id: v.f, name: L ? L.name : "", total: L ? franchiseShown(L.list).length : 0, mine: [] }; map.set(v.f, g); }
    g.mine.push(m);
  }
  return [...map.values()].filter((g) => g.total !== 1).map((g) => ({ ...g, name: g.name || g.mine[0].title }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

let collDoneOpen = false; // the "Completed" group in the Collections tab
// The Collections tab: one row per collection or franchise that has one of your titles in it.
function renderCollectionsTab(fetchMore = true) {
  const groups = collectionGroups();
  const fgroups = franchiseGroups();
  const row = (attr, name, g, mine, action) => {
    const pic = mine.find((m) => m.poster);
    const watched = mine.filter((m) => m.done).length;
    const meta = (g.total ? `${mine.length} of ${g.total} on your list` : `${mine.length} on your list`) + (watched ? ` · ${watched} watched` : "");
    return `
        <div class="item coll-row" ${attr}="${esc(String(g.id))}" title="${action}">
          <div class="thumb">${pic ? `<img src="${esc(pic.poster)}" alt="" draggable="false">` : ""}</div>
          <div class="info">
            <div class="name">${esc(name)}</div>
            <div class="meta">${esc(meta)}</div>
          </div>
          <span class="coll-open">${action} ›</span>
        </div>`;
  };
  // a collection with every part on your list and every part watched is finished: it moves under "Completed" (it comes back
  // by itself if a new part appears or one is no longer watched)
  const all = groups.map((g) => ({ g, html: row("data-coll", collName(g.name), g, [...g.mine].sort((a, b) => (a.collectionPart || 99) - (b.collectionPart || 99)), "See all parts") }))
    .concat(fgroups.map((g) => ({ g, html: row("data-fr", g.name + " franchise", g, g.mine, "See all titles") })));
  const finished = ({ g }) => g.total > 0 && g.mine.length >= g.total && g.mine.every((m) => m.done);
  const open = all.filter((x) => !finished(x)), doneRows = all.filter(finished);
  const html = open.map((x) => x.html).join("") + (doneRows.length
    ? `<button type="button" class="coll-done-toggle" data-colldone="1" aria-expanded="${collDoneOpen}">Completed (${doneRows.length}) <span>${collDoneOpen ? "−" : "+"}</span></button>` + (collDoneOpen ? doneRows.map((x) => x.html).join("") : "")
    : "");
  if (fetchMore) ensureFranchises(); // starts at once; frBusy is set before it first waits
  $("list").innerHTML = html || (frBusy
    ? `<div class="empty">Looking for prequels, sequels and spin-offs… the first time can take a minute.</div>`
    : `<div class="empty">No collections yet. When a movie or series you add has a prequel, a sequel or a spin-off, it shows up here.</div>`);
}

// A series franchise opens in the same panel as a movie collection: all its films and series, tick to add.
async function openFranchise(fid) {
  collState = null;
  const L = frList(fid);
  $("collTitle").textContent = L && L.name ? L.name : "Franchise";
  $("collText").textContent = "";
  $("collList").textContent = "";
  if ($("collRelated")) $("collRelated").innerHTML = "";
  $("collAdd").disabled = true;
  $("collAdd").textContent = "Add selected";
  setCollStatus("Loading…");
  $("coll").hidden = false;
  $("collClose").focus();
  let name = L ? L.name : "", list = L ? L.list : null;
  try {
    if (!list) {
      const mine = items.find((x) => x.tmdbId && (frItem(kindOf(x), x.tmdbId) || {}).f === fid);
      if (!mine) throw new Error("no title");
      const j = await relatedLookup(kindOf(mine), mine.tmdbId);
      if (!Array.isArray(j.list)) throw new Error("none");
      name = j.name || ""; list = j.list;
      frSet("frl5:" + fid, { name, list });
    }
    if ($("coll").hidden) return; // closed while loading
    const shown = franchiseShown(list)
      .sort((a, b) => String(a.release_date || a.first_air_date).localeCompare(String(b.release_date || b.first_air_date)));
    collState = { id: 0, name, parts: [], related: shown, relFranchise: fid, franchiseMode: true };
    $("collTitle").textContent = name || "Franchise";
    $("collText").textContent = `${shown.length} films and series, in release order. Tick the ones you want to add.`;
    setCollStatus("");
    renderRelated();
  } catch {
    setCollStatus("Could not load this franchise. Check your internet connection.", "err");
  }
}

// Not out yet (future or no release date): listed, but it can't be added until it is released.
const isUnreleased = (r) => { const d = r.release_date || r.first_air_date || ""; return !d || d > todayIso(); };
const findPartItem = (p) => items.find((m) => m.tmdbId === p.id && (m.type || "movie") === (p.media_type === "tv" ? "tv" : "movie"));

function setCollStatus(text, kind = "") {
  const el = $("collStatus");
  el.textContent = text;
  el.className = "panel-status " + kind;
}

function updateCollAdd() {
  const n = $("coll").querySelectorAll("input[data-part]:checked:not(:disabled), input[data-rel]:checked:not(:disabled)").length;
  $("collAdd").disabled = n === 0;
  $("collAdd").textContent = n ? `Add selected (${n})` : "Add selected";
}

function renderCollection() {
  const d = collState;
  if (!d) return;
  const have = d.parts.filter(findPartItem).length;
  $("collTitle").textContent = collName(d.name);
  $("collText").textContent = `${d.parts.length} films, in release order.` + (have ? ` ${have} already on your list.` : "") + " Tick the ones you want to add.";
  $("collList").innerHTML = d.parts.map((p, i) => {
    const mine = findPartItem(p);
    const soon = !mine && isUnreleased(p);
    const y = (p.release_date || "").slice(0, 4);
    return `<label class="cpart ${mine ? "have" : soon ? "soon" : ""}">
      <input type="checkbox" data-part="${p.id}" ${mine ? "checked disabled" : soon ? "disabled" : ""} />
      <span class="cnum">${i + 1}</span>
      <span class="thumb">${p.poster_path ? thumbImg(esc(p.poster_path), "34px") : ""}</span>
      <span class="cinfo"><b>${esc(p.title || "Untitled")}</b><small>${y ? esc(y) : "Release date not announced"}</small></span>
      ${mine ? `<span class="badge ok">${esc(badgeLabel(mine))}</span>` : soon ? `<span class="badge soon">Not released</span>` : ""}
    </label>`;
  }).join("");
  setCollStatus("");
  updateCollAdd();
}


/* ---- Related films & series (spin-offs, TV shows) ---- */
// TMDB keeps spin-offs in separate collections, so the franchise link comes from Wikidata instead:
// it knows which films and series belong to the same franchise. Titles Wikidata has no TMDB id for
// are found on TMDB by name, and a short hand-written list covers big franchises Wikidata misses.
const relCache = new Map(); // collection id -> list
const WD_URL = "https://query.wikidata.org/sparql";
const normName = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// The hand-checked list (franchises.js) for this collection, if there is one.
function curatedFor(name) {
  const base = normName(String(name || "").replace(/\s*(film\s+)?collection$/i, ""));
  return (typeof FRANCHISES !== "undefined" ? FRANCHISES : []).find((f) => f.match.some((m) => base === m || base.startsWith(m + " "))) || null;
}

// One title from the list -> its TMDB entry, by name and year (the year picks the right show among same-named ones).
// Uses /search/multi because it is the one search the proxy allows. A busy proxy answers 429: wait and retry.
async function tmdbPatient(path, params) {
  for (let tries = 0; ; tries++) {
    try { return await tmdb(path, params); }
    catch (e) {
      if (!/429/.test(String(e && e.message)) || tries >= 3) throw e;
      await pause(15000);
    }
  }
}
const NUMWORDS = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
const titleTokens = (t) => new Set(normName(t).replace(/^marvel s /, "").split(" ").map((w) => NUMWORDS[w] || w).filter(Boolean));
const EXTRA_BITS = /\b(premiere|trailer|featurette|behind the scenes|making of|recap|special look|tv spot|interview)\b/i;
// How alike two titles are (0 to 1): shared words / all words. "The Fantastic 4: First Steps" = "The Fantastic Four: First Steps".
function titleScore(a, b) {
  const x = titleTokens(a), y = titleTokens(b);
  let both = 0;
  x.forEach((w) => { if (y.has(w)) both++; });
  return both / (x.size + y.size - both || 1);
}
async function resolveTitle([type, title, year]) {
  const tv = type === "t";
  const d = await tmdbPatient("/search/multi", { query: title.replace(/\*/g, ""), include_adult: "false" });
  const yr = (r) => Number(String(r.first_air_date || r.release_date || "").slice(0, 4)) || 0;
  const cands = (d.results || [])
    .filter((r) => r.media_type === (tv ? "tv" : "movie") && Math.abs(yr(r) - year) <= 1)
    .filter((r) => !EXTRA_BITS.test(r.title || r.name) || EXTRA_BITS.test(title))
    .map((r) => ({ r, sc: titleScore(title, r.title || r.name) - (yr(r) === year ? 0 : 0.15) }))
    .filter((x) => x.sc >= 0.6)
    .sort((a, b) => b.sc - a.sc);
  const hit = cands.length ? cands[0].r : null;
  if (!hit) return null;
  return { id: hit.id, media_type: tv ? "tv" : "movie", title: hit.title || hit.name, poster_path: hit.poster_path,
           release_date: hit.release_date, first_air_date: hit.first_air_date, vote_average: hit.vote_average };
}

// The shared list: built once on the server, kept in Supabase, the same for everybody.
const RELATED_URL = SB_URL && SB_ANON ? SB_URL + "/functions/v1/related" : "";
async function relatedFromServer(name, ids, refresh = false) {
  const qs = "name=" + encodeURIComponent(name) + (ids && ids.length ? "&ids=" + ids.slice(0, 40).join(",") : "");
  for (let i = 0; i < 25; i++) {
    const r = await fetch(RELATED_URL + "?" + qs + (refresh && i === 0 ? "&refresh=1" : ""), { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (j.busy) throw new Error("busy");
    if (j.franchise === null) return { none: true };
    if (Array.isArray(j.list)) return { list: j.list, franchise: j.franchise };
    await pause(4000); // someone else's request is building it right now
  }
  throw new Error("timeout");
}

// A title was just added: the server learns its franchise in the background (nothing to wait for, nothing shown).
function warmRelated(id, type) {
  if (!RELATED_URL || !id) return;
  fetch(RELATED_URL + "?warm=1&type=" + (type === "tv" ? "tv" : "movie") + "&id=" + Number(id), { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON } })
    .catch(() => { /* offline or not set up: it will be learned when someone opens the related list */ });
}

// "Report a missing title": the person searches for it and reports it. Enough reports add it to the shared list.
async function reportRelated(d, type, id) {
  const r = await fetch(RELATED_URL, {
    method: "POST",
    headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ franchise: d.relFranchise || "", type, id }),
  });
  if (!r.ok) {
    let code = "failed";
    try { code = (await r.json()).error || code; } catch { /* no body */ }
    const e = new Error("HTTP " + r.status);
    e.code = code;
    throw e;
  }
}

async function wikidataRelated(parts) {
  const ids = parts.map((p) => '"' + Number(p.id) + '"').join(" ");
  const q = `SELECT DISTINCT ?m ?t ?label WHERE {
    VALUES ?mine { ${ids} }
    ?src wdt:P4947 ?mine .
    ?src (wdt:P8345|wdt:P179) ?fr .
    { ?x (wdt:P8345|wdt:P179) ?fr } UNION { ?fr wdt:P527 ?x } UNION { ?x wdt:P361 ?fr }
    OPTIONAL { ?x wdt:P4947 ?m }
    OPTIONAL { ?x wdt:P4983 ?t }
    OPTIONAL { ?x wdt:P31/wdt:P279* ?cls . VALUES ?cls { wd:Q11424 wd:Q5398426 wd:Q1259759 wd:Q63952888 } }
    OPTIONAL { ?x rdfs:label ?label . FILTER(LANG(?label) = "en") }
    FILTER(BOUND(?m) || BOUND(?t) || BOUND(?cls))
  } LIMIT 400`;
  const r = await fetch(WD_URL + "?format=json&query=" + encodeURIComponent(q), { headers: { Accept: "application/sparql-results+json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const rows = (await r.json()).results.bindings;
  const found = new Map();
  for (const b of rows) {
    if (b.m) found.set("movie:" + b.m.value, { kind: "movie", id: +b.m.value });
    if (b.t) found.set("tv:" + b.t.value, { kind: "tv", id: +b.t.value });
    if (!b.m && !b.t && b.label) found.set("name:" + b.label.value, { name: b.label.value });
  }
  return [...found.values()];
}

// A title known only by name: find it on TMDB (movie or series) with an exact name match.
async function findByName(name, tvOnly = false, year = "") {
  const d = await tmdb(tvOnly ? "/search/tv" : "/search/multi", { query: name, include_adult: "false" });
  const want = normName(name);
  const hits = (d.results || []).filter((r) => tvOnly || r.media_type === "movie" || r.media_type === "tv");
  const exact = hits.filter((r) => normName(r.title || r.name) === want);
  const inYear = year ? exact.filter((r) => String(r.first_air_date || r.release_date || "").startsWith(year)) : exact;
  const hit = inYear[0] || exact[0] || (tvOnly && !year ? hits[0] : null);
  return hit ? { kind: tvOnly || hit.media_type === "tv" ? "tv" : "movie", id: hit.id } : null;
}

const REL_TTL = 24 * 3600 * 1000; // keep a found list on this device for a day (the shared copy on the server is the real cache)
function relStored(id) {
  try {
    const v = JSON.parse(localStorage.getItem("rel6:" + id) || "null");
    return v && Date.now() - v.at < REL_TTL ? v.list : null;
  } catch { return null; }
}
function relStore(id, list) {
  try { localStorage.setItem("rel6:" + id, JSON.stringify({ at: Date.now(), list })); } catch { /* storage full or blocked */ }
}

async function getRelated(d, onProgress) {
  if (relCache.has(d.id)) return relCache.get(d.id);
  const stored = relStored(d.id);
  if (stored) { relCache.set(d.id, stored); return stored; }
  const base = normName(String(d.name || "").replace(/\s*(film\s+)?collection$/i, ""));
  const mine = new Set(d.parts.map((p) => "movie:" + p.id));
  const seen = new Set();
  const out = [];
  const finish = () => {
    const isTalk = (r) => (r.genres || []).some((g) => g.id === 10767 || g.id === 10763 || g.id === 10764);
    const keepTalk = out.filter(isTalk).length * 2 >= out.length; // talk shows / reality are after-shows, unless the franchise itself is one
    return out
      .filter((r) => (r.release_date || r.first_air_date)) // not announced yet
      .filter((r) => !(r.media_type === "movie" && r.runtime && r.runtime < 40)) // shorts and featurettes
      .filter((r) => !(r.genres || []).some((g) => g.id === 99) && (keepTalk || !isTalk(r))) // documentaries, and after-shows
      .sort((a, b) => String(a.release_date || a.first_air_date).localeCompare(String(b.release_date || b.first_air_date)));
  };
  const take = async (cands) => {
    const fresh = cands.filter((c) => { const k = c.kind + ":" + c.id; if (mine.has(k) || seen.has(k)) return false; seen.add(k); return true; });
    for (let i = 0; i < fresh.length; i += 8) { // a few at a time, to stay under the TMDB limit
      const batch = await Promise.all(fresh.slice(i, i + 8).map(async (c) => {
        try {
          const r = await tmdb("/" + c.kind + "/" + c.id);
          return { id: r.id, media_type: c.kind, title: r.title || r.name, poster_path: r.poster_path, release_date: r.release_date, first_air_date: r.first_air_date,
                   vote_average: r.vote_average, runtime: r.runtime, genres: (r.genres || []).map((g) => ({ id: g.id })) };
        } catch { return null; }
      }));
      out.push(...batch.filter(Boolean));
      if (onProgress) onProgress(finish());
    }
  };

  // 1) the shared list from Supabase (fast, same for everybody; it learns new franchises by itself)
  let serverSaidNone = false;
  if (RELATED_URL) {
    try {
      const got = await relatedFromServer(d.name, d.parts.map((p) => p.id));
      if (got.none) serverSaidNone = true;
      if (got.list) {
        d.relFranchise = got.franchise || "";
        got.list.forEach((r) => { const k = r.media_type + ":" + r.id; if (!mine.has(k) && !seen.has(k)) { seen.add(k); out.push(r); } });
        const list = finish();
        relCache.set(d.id, list);
        if (list.length) relStore(d.id, list);
        return list;
      }
    } catch { /* server not set up or busy: use the slower way below */ }
  }

  const cur = curatedFor(d.name);
  if (cur) {
    // 2) hand-checked list, looked up here (slow: needs about a minute): the most accurate source, so nothing else is mixed in.
    // The shared proxy allows about 60 requests a minute, so go one at a time (fast when the person uses their own key).
    const gap = userKey ? 60 : 1100;
    let done = 0;
    for (const it of cur.items) {
      let r = null;
      try { r = await resolveTitle(it); } catch { /* skip this one */ }
      done++;
      if (r) {
        const k = r.media_type + ":" + r.id;
        if (!mine.has(k) && !seen.has(k)) { seen.add(k); out.push(r); }
      }
      if (onProgress) onProgress(finish(), done, cur.items.length);
      await pause(gap);
    }
    const list = finish();
    relCache.set(d.id, list);
    if (list.length) relStore(d.id, list);
    return list;
  }

  if (serverSaidNone) { // the server already asked Wikidata and found no franchise: don't ask again from here
    relCache.set(d.id, []);
    return [];
  }
  let wd = [];
  try { wd = await wikidataRelated(d.parts); } catch { /* Wikidata is optional: keep going */ }
  const named = [];
  const direct = [];
  for (const x of wd) (x.name ? named : direct).push(x);
  await take(direct.slice(0, 150));

  // titles Wikidata knows only by name, plus the hand-written extras for this franchise
  const todo = [
    ...named.slice(0, 40).map((x) => ({ name: x.name, tv: false, year: "" })),
  ];
  const found = [];
  for (const t of todo) {
    try { const f = await findByName(t.name, t.tv, t.year); if (f) found.push(f); } catch { break; }
    await pause(150);
  }
  await take(found);

  const list = finish();
  relCache.set(d.id, list);
  if (list.length) relStore(d.id, list);
  return list;
}

// "Refresh this list": the server forgets what it learned about this franchise and learns it again, and this device drops its copies.
async function refreshRelated(d) {
  if (!RELATED_URL || d.refreshing) return;
  d.refreshing = true;
  setCollStatus("Refreshing… this can take up to a minute.");
  try {
    if (d.franchiseMode) {
      const fid = d.relFranchise;
      const mine = items.find((x) => x.tmdbId && (frItem(kindOf(x), x.tmdbId) || {}).f === fid);
      if (!mine) throw new Error("no title");
      const j = await relatedLookup(kindOf(mine), mine.tmdbId, true);
      if (!Array.isArray(j.list)) throw new Error("none");
      frSet("frl5:" + fid, { name: j.name || "", list: j.list });
      forgetFranchiseKeys();
      d.refreshing = false;
      await openFranchise(fid);
      ensureFranchises();
    } else {
      await relatedFromServer(d.name, d.parts.map((p) => p.id), true);
      relCache.delete(d.id);
      try { localStorage.removeItem("rel6:" + d.id); } catch { /* storage blocked */ }
      forgetFranchiseKeys();
      d.refreshing = false;
      await loadRelated(d);
    }
  } catch {
    d.refreshing = false;
    if (collState === d || d.franchiseMode) setCollStatus("Could not refresh. Check your internet connection and try again in a minute.", "err");
  }
}
// which franchise each of your titles is in is asked again the next time (the Collections tab fills in by itself)
function forgetTitleKeys(m) {
  if (!m || !m.tmdbId) return;
  try {
    const v = frGet("fri3:" + kindOf(m) + ":" + m.tmdbId);
    if (v && v.f) localStorage.removeItem("frl5:" + v.f);
    localStorage.removeItem("fri3:" + kindOf(m) + ":" + m.tmdbId);
  } catch { /* storage blocked */ }
}
function forgetFranchiseKeys() {
  try { for (const k of Object.keys(localStorage)) if (/^fri3:/.test(k)) localStorage.removeItem(k); } catch { /* storage blocked */ }
}

function repResHtml(d) {
  const sent = new Set(d.reportSent || []);
  const rows = (d.reportRes || []).map((r) => {
    const k = r.media_type + ":" + r.id;
    return `<button type="button" class="rep-row" data-rep="${k}" ${sent.has(k) ? "disabled" : ""}>
      <span class="thumb">${r.poster_path ? thumbImg(esc(r.poster_path), "40px") : ""}</span>
      <span class="cinfo"><b>${esc(r.title || r.name || "Untitled")}</b><small>${esc([r.media_type === "tv" ? "Series" : "Movie", yearOf(r)].filter(Boolean).join(" · "))}</small></span>
      <span class="badge ${sent.has(k) ? "ok" : ""}">${sent.has(k) ? "Reported" : "Report"}</span>
    </button>`;
  }).join("");
  return (d.reportMsg ? `<p class="coll-loading">${esc(d.reportMsg)}</p>` : "") + rows;
}
function reportHtml(d) {
  if (!RELATED_URL || !d.relFranchise) return "";
  if (!d.reportOpen) return `<button type="button" class="coll-more" id="collReport">Report a missing title</button> <button type="button" class="coll-more" id="collRefresh">Refresh this list</button>`;
  return `<div class="rep-box"><input id="repQ" class="rep-in" type="search" placeholder="Search the missing film or series…" value="${esc(d.reportQ || "")}" autocomplete="off" />
    <div id="repRes">${repResHtml(d)}</div></div>`;
}

function renderRelated() {
  const d = collState;
  const box = $("collRelated");
  if (!d || !box) return;
  const list = d.related || [];
  const ticked = new Set([...box.querySelectorAll("input[data-rel]:checked:not(:disabled)")].map((i) => i.dataset.rel));
  if (!list.length) { if (!d.relLoading) { box.innerHTML = ""; updateCollAdd(); } return; }
  const f = d.relFilter || "all";
  const chip = (k, label) => `<button type="button" class="coll-chip${f === k ? " on" : ""}" data-relf="${k}">${label}</button>`;
  const shown = list.filter((r) => f === "all" || (f === "tv") === (r.media_type === "tv"));
  const chips = d.similarMode ? "" : `<div class="coll-chips">${chip("all", `All ${list.length}`)}${chip("movie", `Movies ${list.filter((r) => r.media_type !== "tv").length}`)}${chip("tv", `Series ${list.filter((r) => r.media_type === "tv").length}`)}</div>`;
  const rowHtml = (r) => {
    const mine = findPartItem(r);
    const soon = !mine && isUnreleased(r);
    const y = yearOf(r);
    return `<label class="cpart ${mine ? "have" : soon ? "soon" : ""}">
      <input type="checkbox" data-rel="${r.media_type}:${r.id}" ${mine ? "checked disabled" : soon ? "disabled" : ticked.has(r.media_type + ":" + r.id) ? "checked" : ""} />
      <span class="thumb">${r.poster_path ? thumbImg(esc(r.poster_path), "40px") : ""}</span>
      <span class="cinfo"><b>${esc(r.title || "Untitled")}</b><small>${esc([r.media_type === "tv" ? "Series" : "Movie", y].filter(Boolean).join(" · "))}</small>${d.similarMode && r.why && r.why.length ? r.why.slice(0, 2).map((t) => `<small class="why">${esc(t)}</small>`).join("") : ""}</span>
      ${mine ? `<span class="badge ok">${esc(badgeLabel(mine))}</span>` : soon ? `<span class="badge soon">Not released</span>` : ""}
    </label>`;
  };
  const mainRows = d.similarMode ? shown.filter((r) => !r.mix && !r.cross) : shown;
  const crossRows = d.similarMode ? shown.filter((r) => r.cross) : [];
  const worldRows = d.similarMode ? shown.filter((r) => r.mix) : [];
  const crossTitle = d.simSeed && d.simSeed.type === "tv" ? "Films with the same feel" : "Series with the same feel";
  const dnaHtml = ""; // "This one is:" line removed
  const patternHtml = ""; // "What connects them:" line removed
  box.innerHTML = `<h3 class="coll-sub">${d.similarMode ? "Similar taste" : d.franchiseMode ? "Films &amp; series" : "Related films &amp; series"}</h3>${dnaHtml}${patternHtml}${chips}` + mainRows.map(rowHtml).join("") + (d.similarMode ? (d.simMoreCount > 0
    ? `<button type="button" class="coll-more" data-simmore="1">Show ${d.simMoreCount} more</button>`
    : `<p class="sim-end">That's all the close matches. New picks tomorrow.</p>`) : "") +
    (crossRows.length ? `<h3 class="coll-sub">${crossTitle}</h3>` + crossRows.map(rowHtml).join("") : "") +
    (worldRows.length ? `<h3 class="coll-sub">Strong matches in other languages</h3>` + worldRows.map(rowHtml).join("") : "") + reportHtml(d);
  updateCollAdd();
}

function showRelatedButton(msg = "") {
  const box = $("collRelated");
  if (!box) return;
  box.innerHTML = (msg ? `<p class="panel-status err">${esc(msg)}</p>` : "") +
    `<button type="button" class="coll-more" id="collMore">Show related films &amp; series</button>`;
}

async function loadRelated(d) {
  const box = $("collRelated");
  box.innerHTML = "";
  setCollStatus("Loading related films & series…"); // the status line sits under the list, so it is always in view
  try {
    d.relLoading = true;
    const list = await getRelated(d, (partial, done, total) => {
      if (collState !== d) return;
      d.related = partial;
      setCollStatus(total ? `Still loading related titles… ${done} of ${total}` : "Loading related films & series…");
      renderRelated();
    });
    d.relLoading = false;
    if (collState !== d) return; // panel closed or changed
    d.related = list;
    setCollStatus(list.length ? "" : "No related films or series found.");
    if (list.length) renderRelated();
  } catch {
    d.relLoading = false;
    setCollStatus("");
    if (collState === d) showRelatedButton("Could not load related titles. Try again.");
  }
}

async function openCollection(id) {
  const known = items.find((m) => m.collectionId === id);
  collState = null;
  $("collTitle").textContent = collName(known && known.collectionName);
  $("collText").textContent = "";
  $("collList").textContent = "";
  if ($("collRelated")) $("collRelated").innerHTML = "";
  $("collAdd").disabled = true;
  $("collAdd").textContent = "Add selected";
  setCollStatus(canSearch() ? "Loading…" : "Add a TMDB key (menu → API key) to see this collection.");
  $("coll").hidden = false;
  $("collClose").focus();
  if (!canSearch()) return;
  try {
    const data = await getCollection(id, true);
    if ($("coll").hidden) return; // closed while loading
    collState = { ...data, related: [] };
    renderCollection();
    render(); // the part numbers may have been updated
    showRelatedButton(); // related titles load only when asked
  } catch (e) {
    setCollStatus(e && /429/.test(String(e.message)) ? "Too many requests. Try again in a minute." : "Could not load this collection. Check your internet connection.", "err");
  }
}

// "Similar taste" for a title on the Watched tab. Opens the collection panel; only the ticked titles are added, to To watch.
// The server ("similar" function) blends TMDB, Wikidata, IMDb / Rotten Tomatoes scores and more, and gives every title 25
// numbers (features) plus the reasons it was picked. The ranking uses server-learned weights plus a small personal
// adjustment that is learned here, on this device, from what you tick. Nothing personal leaves the device.
const SIMILAR_URL = SB_URL && SB_ANON ? SB_URL + "/functions/v1/similar" : "";
const SIM_TASTE_KEY = "movie-watchlist-similar-taste";
const SIM_SCALE = 8, SIM_BIAS = 3.2, SIM_LR = 0.004, SIM_NEG = 0.25, SIM_FEATURES = ["kw", "story", "cast", "dir", "genre", "tone", "rec", "sim", "trk", "co", "agree", "wd", "quality", "era", "lang", "vibe", "recep", "crowd", "theme", "core", "mood", "pace", "look", "form", "feel"];
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
function simTaste() {
  try { const v = JSON.parse(localStorage.getItem(SIM_TASTE_KEY) || "null"); if (v && typeof v.d === "object") return v; } catch { /* storage blocked */ }
  return { d: {}, n: 0 };
}
const simZ = (w, d, x, pen = 0) => SIM_SCALE * SIM_FEATURES.reduce((t, f) => t + ((w[f] || 0) + (d[f] || 0)) * (x[f] || 0), 0) - SIM_BIAS - pen;
let simBasicWhy = ""; // set when the smart list could not be loaded and the plain TMDB list is shown instead
let simWeights = null; // the server's learned weights for the list on screen
let simDna = [];       // what the original itself is like ("melancholic · slow-burn · lush, painterly images"), from the server
let simPattern = [];   // what the best matches share with the original ("first love", "summer or seaside setting" ...), from the server

async function similarFor(kind, id) {
  simBasicWhy = "";
  if (SIMILAR_URL) {
    try {
      // The list is built in three parts, each its own request with its own CPU budget on the server:
      //   main (the list), world (strong matches in other languages), cross (series <-> films). The parts are asked at the same time and merged.
      // The first build of a title can take a minute: the server answers 503 "still building" and keeps working, so ask again (up to 5 times).
      const getPart = async (part) => {
        let r = null, lite = false;
        for (let attempt = 0; attempt < 6; attempt++) {
          r = await fetch(SIMILAR_URL + "?type=" + kind + "&id=" + Number(id) + "&part=" + part + (lite ? "&lite=1" : ""), { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON }, signal: AbortSignal.timeout(170000) });
          if (r.status === 546 && !lite) { lite = true; if (part === "main") setCollStatus("Reading this title (lighter pass)…"); continue; } // used too much CPU: ask for the lighter build
          if (r.status !== 503) break;
          let b = null; try { b = await r.clone().json(); } catch { /* not JSON */ }
          if (!(b && b.building) || attempt === 5) break;
          if (part === "main") setCollStatus("Reading this title closely, one moment…");
          await new Promise((res) => setTimeout(res, 4000));
        }
        return r;
      };
      const [rm, rw, rc] = await Promise.all([getPart("main"), getPart("world").catch(() => null), getPart("cross").catch(() => null)]);
      const r = rm;
      if (r.status === 429) throw new Error("HTTP 429");
      if (r.ok) {
        const j = await r.json();
        simBasicWhy = "";
        if (Array.isArray(j.list) && j.weights) {
          simWeights = j.weights;
          simPattern = Array.isArray(j.pattern) ? j.pattern.filter((x) => typeof x === "string" && x.length < 60).slice(0, 5) : [];
          simDna = Array.isArray(j.dna) ? j.dna.filter((x) => typeof x === "string" && x.length < 60).slice(0, 4) : [];
          let all = j.list;
          for (const rx of [rw, rc]) { // the other languages and the other kind: a part that failed is simply left out
            try { if (rx && rx.ok) { const jx = await rx.json(); if (Array.isArray(jx.list)) all = all.concat(jx.list); } } catch { /* leave it out */ }
          }
          const seenK = new Set();
          all = all.filter((x) => { const k = (x && (x.media_type || kind)) + ":" + (x && x.id); if (!x || seenK.has(k)) return false; seenK.add(k); return true; });
          const t = simTaste();
          return all.filter((x) => x && x.id && x.title)
            .map((x) => { const z = simZ(j.weights, t.d, x.features || {}, x.pen || 0); return { ...x, z: x.mix || x.cross ? Math.min(0.5, Math.max(0, z)) : z }; }) // world-cinema picks (mix) and the other kind (cross) skip the close-match bar: the server already tested them
            .sort((a, b) => b.z - a.z);
        }
      }
      simBasicWhy = "HTTP " + r.status;
    } catch (e) { if (e && /429/.test(String(e.message))) throw e; simBasicWhy = simBasicWhy || (e && e.name === "TimeoutError" ? "timed out" : "no connection to the function; is it deployed?"); /* otherwise fall back to the plain TMDB list below */ }
  }
  simWeights = null;
  simPattern = [];
  simDna = [];
  const pick = (d) => (d && (Array.isArray(d.results) ? d.results : d.recommendations && d.recommendations.results)) || [];
  let list = [];
  try { list = pick(await tmdb("/" + kind + "/" + Number(id) + "/recommendations")); } catch { /* try the other way below */ }
  if (!list.length) list = pick(await tmdb("/" + kind + "/" + Number(id), { append_to_response: "recommendations" })); // the proxy may only allow the plain title path, or answer without a list
  // the plain list is mostly English: the original's own language goes first (a Tamil film gets Tamil films before anything else)
  let seedLang = "";
  try { seedLang = (await tmdb("/" + kind + "/" + Number(id))).original_language || ""; } catch { /* no language: plain order */ }
  return list.filter((r) => r && r.id && (r.title || r.name) && !r.adult).map((r) => ({
    id: r.id, media_type: kind, title: r.title || r.name, poster_path: r.poster_path || "",
    release_date: r.release_date || "", first_air_date: r.first_air_date || "", vote_average: r.vote_average || 0,
    lang: r.original_language || "", z: seedLang && r.original_language === seedLang ? 3 : 0,
  }));
}

// The list from the server holds up to 50 titles. Only close matches (40% match or more) are used: a weak list is cut where it gets weak (if only 7
// are close, 7 are shown). 15 are shown, and the same 10 stay for 24 hours; then a new 10 is drawn: better matches more often,
// titles already shown (and not added) less and less, and yesterday's 10 sit out while there are enough others. "Show more"
// adds up to 15 more close matches (30 at most) and stays open for the rest of the day. Titles you add are replaced at once.
const SIM_SEEN_KEY = "movie-watchlist-similar-seen";
const SIM_SHOW = 15, SIM_MAX = 30, SIM_MIN = 0.3, SIM_FLOOR = 0.2, SIM_PCT = 40, SIM_DAY = 24 * 3600 * 1000;
function dailySimilar(seedKey, list, more = false) {
  let st = {};
  try { st = JSON.parse(localStorage.getItem(SIM_SEEN_KEY) || "{}") || {}; } catch { /* storage blocked */ }
  const mine = st[seedKey] || { at: 0, keys: [], seen: {}, more: false };
  mine.seen = mine.seen || {};
  const world = list.filter((r) => r.mix); // the world-cinema section: shown whole, under the list
  const cross = list.filter((r) => r.cross); // the other kind (series for a film, films for a series): shown whole, between the list and world cinema
  const byZ = (a, b) => (b.z ?? 0) - (a.z ?? 0);
  const mains = list.filter((r) => !r.mix && !r.cross);
  const pctOk = (r) => typeof r.pct !== "number" || r.pct >= SIM_PCT; // nothing under 40% match is ever shown
  let eligible = mains.filter((r) => pctOk(r) && (typeof r.pct === "number" || typeof r.z !== "number" || sigmoid(r.z) >= SIM_MIN)); // close matches only: 40%+ match (titles without a match % use the score bar)
  if (eligible.length < SIM_SHOW) { // never nearly empty: top up with the next best (still above a low floor) so there is always a short list to pick from
    const have = new Set(eligible);
    eligible = eligible.concat(mains.filter((r) => !have.has(r) && pctOk(r) && typeof r.z === "number" && sigmoid(r.z) >= SIM_FLOOR).sort(byZ).slice(0, SIM_SHOW - eligible.length));
  }
  const kOf = (r) => r.media_type + ":" + r.id;
  const byKey = new Map(eligible.map((r) => [kOf(r), r]));
  const newDay = Date.now() - (mine.at || 0) >= SIM_DAY;
  const yesterday = new Set(newDay ? mine.keys || [] : []);
  if (newDay) mine.more = false;
  if (more) mine.more = true;
  const want = Math.min(mine.more ? SIM_MAX : SIM_SHOW, eligible.length);
  let keys = (newDay ? [] : mine.keys || []).filter((k) => byKey.has(k)).slice(0, want); // within 24 h: the same titles, minus any you added since
  if (keys.length < want) {
    const have = new Set(keys);
    let pool = eligible.filter((r) => !have.has(kOf(r)));
    const fresh = pool.filter((r) => !yesterday.has(kOf(r)));
    if (fresh.length >= want - keys.length) pool = fresh;
    // a balanced draw, one title at a time: close matches are likelier, but every title already chosen makes another of the same decade or the same
    // language a little less likely, so the 10 have a rhythm (an older classic, a recent one, a quieter one, a bigger one) instead of ten of one kind
    const decade = (r) => Math.floor((Number(String(r.release_date || r.first_air_date || "").slice(0, 4)) || 0) / 10);
    const chosen = keys.map((k) => byKey.get(k)).filter(Boolean);
    const drawn = [];
    let left = pool.slice();
    while (drawn.length < want - keys.length && left.length) {
      const now = chosen.concat(drawn.map((k) => byKey.get(k)));
      let best = null, bestKey = -1;
      for (const r of left) {
        const k = kOf(r);
        let wt = Math.exp(Math.max(-4, Math.min(4, typeof r.z === "number" ? r.z : 0)) / 2) * Math.pow(0.5, mine.seen[k] || 0);
        wt *= Math.pow(0.7, now.filter((x) => decade(x) === decade(r)).length) * Math.pow(0.85, now.filter((x) => x.lang && x.lang === r.lang).length);
        const key = Math.pow(Math.random(), 1 / Math.max(wt, 1e-9));
        if (key > bestKey) { bestKey = key; best = r; }
      }
      drawn.push(kOf(best));
      left = left.filter((r) => r !== best);
    }
    drawn.forEach((k) => { mine.seen[k] = (mine.seen[k] || 0) + 1; });
    keys = keys.concat(drawn);
    if (newDay) mine.at = Date.now();
  }
  mine.keys = keys;
  st[seedKey] = mine;
  const seeds = Object.keys(st);
  if (seeds.length > 40) delete st[seeds[0]];
  try { localStorage.setItem(SIM_SEEN_KEY, JSON.stringify(st)); } catch { /* storage full or blocked */ }
  const rs = keys.map((k) => byKey.get(k));
  return {
    items: rs.slice(0, SIM_SHOW).sort(byZ).concat(rs.slice(SIM_SHOW).sort(byZ)), // the best first; the extra 10 below the first 10
    world: world.sort(byZ),
    cross: cross.sort(byZ),
    moreCount: mine.more ? 0 : Math.min(SIM_SHOW, Math.max(0, eligible.length - SIM_SHOW)),
  };
}

// Called when "Add selected" is pressed in the Similar panel: ticked titles are a yes, the others on screen a weak no.
function learnSimilar(d, pickedKeys) {
  if (!d || !d.similarMode || !d.simSeed || !pickedKeys.length) return;
  const shown = d.simShown || [];
  const picked = new Set(pickedKeys);
  if (simWeights) { // personal adjustment, on this device only
    const t = simTaste();
    for (const r of d.related || []) {
      const k = r.media_type + ":" + r.id;
      if (!r.features || !(picked.has(k) || shown.includes(k))) continue;
      const y = picked.has(k) ? 1 : 0;
      const g = (y - sigmoid(simZ(simWeights, t.d, r.features, r.pen || 0))) * (y ? 1 : SIM_NEG);
      for (const f of SIM_FEATURES) t.d[f] = Math.max(-0.1, Math.min(0.2, (t.d[f] || 0) * 0.98 + SIM_LR * SIM_SCALE * g * (r.features[f] || 0)));
    }
    t.n++;
    try { localStorage.setItem(SIM_TASTE_KEY, JSON.stringify(t)); } catch { /* storage full or blocked */ }
  }
  if (SIMILAR_URL && simWeights) { // the shared weights learn from it too (only keys and the ticks are sent, nothing about you)
    fetch(SIMILAR_URL, {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ type: d.simSeed.type, id: d.simSeed.id, picked: pickedKeys, shown }),
    }).catch(() => { /* learning is a bonus */ });
  }
}

async function openSimilar(id) {
  const m = items.find((x) => x.id === id);
  if (!m || !m.tmdbId) return;
  closeMenu();
  const d = { id: 0, name: "", parts: [], related: [], similarMode: true, relFilter: "all", simSeed: { type: kindOf(m), id: m.tmdbId }, simShown: [] };
  collState = d;
  $("collTitle").textContent = "Similar to " + m.title;
  $("collText").textContent = "Same kind of taste. Tick the ones you want to add. Only the ones you tick are added, to To watch.";
  $("collList").textContent = "";
  $("collRelated").innerHTML = "";
  $("collAdd").disabled = true;
  $("collAdd").textContent = "Add selected";
  setCollStatus(canSearch() ? "Loading…" : "Add a TMDB key (menu → API key) to see similar titles.");
  $("coll").hidden = false;
  $("collClose").focus();
  if (!canSearch()) return;
  try {
    const all = (await similarFor(kindOf(m), m.tmdbId)).filter((r) => !findPartItem(r)); // already on your list: left out
    const key = kindOf(m) + ":" + m.tmdbId;
    const pick = dailySimilar(key, all);
    const list = pick.items.concat(pick.cross, pick.world);
    d.simAll = all; d.simKey = key; d.simMoreCount = pick.moreCount; d.simPattern = simPattern.slice(); d.simDna = simDna.slice();
    if ($("coll").hidden || collState !== d) return; // closed while loading
    d.related = list;
    d.simShown = list.map((r) => r.media_type + ":" + r.id);
    setCollStatus(list.length ? (simBasicWhy ? `Smart matching did not answer (${simBasicWhy}), so this is TMDB's basic list. Close and open it again in a minute.` : "") : "No similar titles found for this one.");
    renderRelated();
  } catch (e) {
    if ($("coll").hidden || collState !== d) return;
    setCollStatus(e && /429/.test(String(e.message)) ? "Too many requests. Try again in a minute." : "Could not load similar titles. Check your internet connection and try again.", "err");
  }
}

// "Show more" in the Similar panel: the next close matches (30 at most), ticks are kept
function showMoreSimilar() {
  const d = collState;
  if (!d || !d.similarMode || !d.simAll) return;
  const pick = dailySimilar(d.simKey, d.simAll, true);
  d.related = pick.items.concat(pick.cross, pick.world);
  d.simMoreCount = pick.moreCount;
  d.simShown = d.related.map((r) => r.media_type + ":" + r.id);
  renderRelated();
}

/* ---------------- Discover tab ----------------
   Three parts: "Picked for you" (5 titles a day, drawn at random from a pool that fits YOUR TASTE PROFILE = the titles you watched),
   "Trending for you" (this week's trending, re-ranked by that taste) and "Trending now" (as TMDB lists them).
   Learning: titles you add from here become lighter taste seeds; titles shown again and again without being added, or
   crossed out, come up less; and the server counts what was shown and what was added for EVERYONE, so titles many people add rank higher. */
const DISC_URL = SB_URL && SB_ANON ? SB_URL + "/functions/v1/discover" : "";
const DISC_KEY = "movie-watchlist-discover";
const DISC_SHOW = 20, DISC_DAY = 24 * 3600 * 1000, DISC_POOL_TTL = 6 * 3600 * 1000;
let discMem = null, discBusy = false, discFailAt = 0, discErr = "";
function discState() {
  if (discMem) return discMem;
  let st = {};
  try { st = JSON.parse(localStorage.getItem(DISC_KEY) || "{}") || {}; } catch { /* storage blocked */ }
  const arr = (v) => (Array.isArray(v) ? v : []);
  discMem = { at: +st.at || 0, picks: arr(st.picks), pool: arr(st.pool), poolAt: +st.poolAt || 0, sig: st.sig || "", trend: arr(st.trend), profile: st.profile || null, seen: st.seen || {}, liked: arr(st.liked), no: st.no || {}, regChoice: String(st.regChoice || ""), reg: st.reg || null };
  if (st.ver !== 2) { discMem.picks = []; discMem.at = 0; discMem.poolAt = 0; discMem.sig = ""; } // new rules: draw again once
  discMem.ver = 2;
  if (st.tv !== 5) discMem.poolAt = 0; // new Trending now: load it once (today's picks stay)
  discMem.tv = 5;
  return discMem;
}
function discSave() {
  const st = discState();
  for (const m of [st.seen, st.no]) { const ks = Object.keys(m); if (ks.length > 300) ks.slice(0, ks.length - 300).forEach((k) => delete m[k]); }
  try { localStorage.setItem(DISC_KEY, JSON.stringify(st)); } catch { /* storage full or blocked */ }
}
const discKey = (r) => (r.media_type === "tv" ? "tv" : "movie") + ":" + r.id;
const discOwned = () => new Set(items.filter((m) => m.tmdbId).map((m) => kindOf(m) + ":" + m.tmdbId));
// THE TASTE PROFILE: what you watched, the latest first (at most 12)
function discSeeds() {
  return items.map((m, i) => [m, i]).filter(([m]) => m.done && m.tmdbId)
    .sort((a, b) => (b[0].watchedAt || 0) - (a[0].watchedAt || 0) || a[1] - b[1])
    .slice(0, 12).map(([m]) => kindOf(m) + ":" + m.tmdbId);
}
function discPost(shown, added) {
  if (!DISC_URL) return;
  fetch(DISC_URL, { method: "POST", headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON, "Content-Type": "application/json" }, body: JSON.stringify({ shown, added }) })
    .catch(() => { /* learning is a bonus */ });
}
// A balanced random draw, one title at a time: a better taste match is likelier, a title shown before without being added is less likely
// every time, and each title already chosen makes another of the same decade or language a little less likely.
function discDraw(n, exclude, avoid) {
  const st = discState(), owned = discOwned();
  let pool = st.pool.filter((r) => { const k = discKey(r); return !owned.has(k) && !st.no[k] && !exclude.has(k); });
  const fresh = pool.filter((r) => !avoid.has(discKey(r)));
  if (fresh.length >= n) pool = fresh;
  const decade = (r) => Math.floor((Number(yearOf(r)) || 0) / 10);
  const topLang = new Set(((st.profile && st.profile.langs) || []).slice(0, 1)); // your main language
  const wantTop = topLang.size ? Math.ceil(n * 0.5) : 0; // half of the picks (change 0.5 for more or less)
  const drawn = [];
  while (drawn.length < n && pool.length) {
    let cand = pool;
    if (topLang.size) {
      const mine = pool.filter((r) => topLang.has(r.lang)), others = pool.filter((r) => !topLang.has(r.lang));
      cand = drawn.filter((x) => topLang.has(x.lang)).length < wantTop ? (mine.length ? mine : others) : (others.length ? others : mine);
    }
    let best = null, bestKey = -1;
    for (const r of cand) {
      let wt = Math.pow(0.12 + (r.taste || 0), 3) * Math.pow(0.5, st.seen[discKey(r)] || 0);
      wt *= Math.pow(0.7, drawn.filter((x) => decade(x) === decade(r)).length) * Math.pow(0.8, drawn.filter((x) => x.lang && x.lang === r.lang).length);
      const key = Math.pow(Math.random(), 1 / Math.max(wt, 1e-9));
      if (key > bestKey) { bestKey = key; best = r; }
    }
    drawn.push(best);
    pool = pool.filter((r) => r !== best);
  }
  return drawn;
}
async function discRefresh() {
  if (discBusy || !DISC_URL || !canSearch() || Date.now() - discFailAt < 60000) return;
  const st = discState(), seeds = discSeeds();
  const liked = st.liked.slice(-8);
  const sig = seeds.join(",") + "|" + liked.join(",");
  const stale = st.sig !== sig || Date.now() - st.poolAt >= DISC_POOL_TTL || !st.pool.length;
  const newDay = seeds.length > 0 && Date.now() - st.at >= DISC_DAY;
  if (!stale && !newDay) return;
  discBusy = true; discErr = "";
  try {
    if (stale) {
      const r = await fetch(DISC_URL + "?seeds=" + encodeURIComponent(seeds.join(",")) + "&liked=" + encodeURIComponent(liked.join(",")), { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON } });
      if (r.status === 429) throw new Error("429");
      if (!r.ok) { let d = ""; try { const b = await r.json(); d = String((b && (b.error || b.message)) || "").slice(0, 120); } catch { /* not JSON */ } throw new Error("HTTP " + r.status + (d ? ": " + d : "")); }
      const j = await r.json();
      st.pool = Array.isArray(j.picks) ? j.picks : [];
      st.trend = Array.isArray(j.trending) ? j.trending : [];
      st.profile = j.profile || null; st.sig = sig; st.poolAt = Date.now();
    }
    if (newDay) { // a new day: new titles; yesterday's sit out
      const avoid = new Set(st.picks.map(discKey));
      st.picks = discDraw(DISC_SHOW, new Set(), avoid);
      st.picks.forEach((r) => { st.seen[discKey(r)] = (st.seen[discKey(r)] || 0) + 1; });
      st.at = Date.now();
      discPost(st.picks.map(discKey), []);
    }
    discSave();
  } catch (e) {
    discFailAt = Date.now();
    const m = String((e && e.message) || "");
    console.error("discover failed", e);
    discErr = /^429/.test(m) ? "Too many requests. Try again in a minute."
      : /HTTP 404/.test(m) ? "Discover is not set up on the server (HTTP 404). Deploy it: supabase functions deploy discover --no-verify-jwt"
      : /HTTP 401|HTTP 403/.test(m) ? "The server refused the request (" + m + "). Deploy with --no-verify-jwt, or check the anon key in config.js."
      : /HTTP 5\d\d/.test(m) ? "Discover failed on the server (" + m + "). Check the TMDB_API_KEY secret and run supabase/discover.sql."
      : navigator.onLine === false ? "Could not load Discover. You are offline."
      : "Could not reach the Discover function. Is it deployed? (supabase functions deploy discover --no-verify-jwt)";
  }
  discBusy = false;
  if (tab === "disc") renderDiscoverTab();
}
function discRow(r, canNo) {
  const k = discKey(r), y = yearOf(r);
  const meta = [r.media_type === "tv" ? "Series" : "Movie", y, langLabel(r.lang)].filter(Boolean).join(" · ");
  const why = [r.pct ? r.pct + "% taste match" : "", (r.why || []).join(" · ")].filter(Boolean).join(" · ");
  return `
        <div class="item disc-row fixed" data-drow="${esc(k)}">
          <div class="thumb">${r.poster_path ? thumbImg(esc(r.poster_path)) : ""}</div>
          <div class="info">
            <div class="name">${esc(r.title || "Untitled")}</div>
            <div class="meta">${esc(meta)}</div>
            ${why ? `<div class="meta disc-why">${esc(why)}</div>` : ""}
          </div>
          ${canNo ? `<button type="button" class="icon disc-no" data-dno="${esc(k)}" title="Not for me" aria-label="Not for me">×</button>` : ""}
          <button type="button" class="icon disc-add" data-dadd="${esc(k)}" title="Add to To watch" aria-label="Add to To watch">+</button>
        </div>`;
}
// "Picked for you": a row of posters you slide through. The card in the middle is the active one; tap another to bring it to the middle.
let pkIdx = {}; // per carousel: which card (0 = the first) is in the middle; it opens on the first
function pickCard(r, canNo) {
  const k = discKey(r), y = yearOf(r);
  const meta = [r.media_type === "tv" ? "Series" : "Movie", y, langLabel(r.lang)].filter(Boolean).join(" · ");
  const why = [r.pct ? r.pct + "% taste match" : "", (r.why || []).join(" · ")].filter(Boolean).join(" · ");
  return `
        <div class="pk-card" data-drow="${esc(k)}">
          <div class="pk-poster">${r.poster_path ? bigImg(esc(r.poster_path)) : ""}</div>
          <div class="pk-title">${esc(r.title || "Untitled")}</div>
          <div class="pk-meta">${esc(meta)}</div>
          ${why ? `<div class="pk-why">${esc(why)}</div>` : ""}
          <div class="pk-acts">
            ${canNo ? `<button type="button" class="pk-no" data-dno="${esc(k)}" title="Not for me" aria-label="Not for me">×</button>` : ""}
            <button type="button" class="pk-add" data-dadd="${esc(k)}" title="Add to To watch" aria-label="Add to To watch">+ To watch</button>
          </div>
        </div>`;
}
const pkRow = (id, rows, canNo) => `<div class="pk-wrap"><button type="button" class="pk-nav pk-prev" data-pkgo="${id}|-1" aria-label="Previous">‹</button><div class="pk-track" id="${id}">${rows.map((r) => pickCard(r, canNo)).join("")}</div><button type="button" class="pk-nav pk-next" data-pkgo="${id}|1" aria-label="Next">›</button></div>`;
const pkCenter = () => 0; // (kept so older code paths still find it)
function pkGo(id, step) { // arrows: slide by most of a screen
  const tr = $(id);
  if (tr) tr.scrollBy({ left: step * Math.max(200, tr.clientWidth * 0.8), behavior: "smooth" });
}
function pkInit() { // every row starts at the left; after adding or dismissing one it stays where you were
  document.querySelectorAll("#list .pk-track").forEach((tr) => {
    tr.scrollLeft = pkIdx[tr.id] || 0;
    tr.parentElement.classList.toggle("fits", tr.scrollWidth <= tr.clientWidth + 2);
    tr.addEventListener("scroll", () => { pkIdx[tr.id] = tr.scrollLeft; }, { passive: true });
  });
}
/* ---- Trending in <country> (Discover) ----
   The server finds the country from the request (or the device language), the person can change it with the small menu, and the choice is kept on this device.
   Every title added to a list sends one anonymous count (title + country, nothing else), so "added this week" in a country can rank higher. */
const REG_TTL = 3 * 3600 * 1000;
const REG_COUNTRIES = ["AF", "AL", "DZ", "AR", "AM", "AU", "AT", "AZ", "BH", "BD", "BY", "BE", "BO", "BA", "BR", "BG", "KH", "CM", "CA", "CL", "CN", "CO", "CR", "HR", "CU", "CY", "CZ", "DK", "DO", "EC", "EG", "SV", "EE", "ET", "FI", "FR", "GE", "DE", "GH", "GR", "GT", "HN", "HK", "HU", "IS", "IN", "ID", "IR", "IQ", "IE", "IL", "IT", "CI", "JP", "JO", "KZ", "KE", "KW", "KG", "LV", "LB", "LY", "LT", "MY", "MX", "MA", "MM", "NP", "NL", "NZ", "NG", "NO", "OM", "PK", "PS", "PA", "PY", "PE", "PH", "PL", "PT", "QA", "RO", "RU", "SA", "SN", "RS", "SG", "SK", "SI", "ZA", "KR", "ES", "LK", "SD", "SE", "CH", "SY", "TW", "TZ", "TH", "TN", "TR", "UA", "AE", "GB", "US", "UY", "UZ", "VE", "VN", "YE"];
let regBusy = false, regFailAt = 0;
const regName = (c) => { try { return new Intl.DisplayNames(["en"], { type: "region" }).of(c) || c; } catch { return c; } };
const REG_TZ = { "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Dubai": "AE", "Asia/Riyadh": "SA", "Asia/Qatar": "QA", "Asia/Kuwait": "KW", "Asia/Muscat": "OM", "Asia/Bahrain": "BH", "Asia/Karachi": "PK", "Asia/Dhaka": "BD", "Asia/Colombo": "LK", "Asia/Kathmandu": "NP", "Asia/Singapore": "SG", "Asia/Kuala_Lumpur": "MY", "Asia/Jakarta": "ID", "Asia/Bangkok": "TH", "Asia/Manila": "PH", "Asia/Ho_Chi_Minh": "VN", "Asia/Hong_Kong": "HK", "Asia/Shanghai": "CN", "Asia/Tokyo": "JP", "Asia/Seoul": "KR", "Asia/Taipei": "TW", "Asia/Tehran": "IR", "Asia/Jerusalem": "IL", "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Madrid": "ES", "Europe/Rome": "IT", "Europe/Amsterdam": "NL", "Europe/Istanbul": "TR", "Europe/Moscow": "RU", "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Pacific/Auckland": "NZ", "Africa/Lagos": "NG", "Africa/Nairobi": "KE", "Africa/Johannesburg": "ZA", "Africa/Cairo": "EG", "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US", "America/Toronto": "CA", "America/Vancouver": "CA", "America/Mexico_City": "MX", "America/Sao_Paulo": "BR", "America/Argentina/Buenos_Aires": "AR" };
const regHl = () => {
  try { const tz = REG_TZ[Intl.DateTimeFormat().resolvedOptions().timeZone]; if (tz) return tz; } catch { /* no time zone */ }
  try { const m = String(navigator.language || "").match(/[-_]([A-Za-z]{2})$/); return m ? m[1].toUpperCase() : ""; } catch { return ""; }
};
function regCount(item) {
  try {
    if (!DISC_URL || !item || !item.tmdbId) return;
    const k = (item.type === "tv" ? "tv" : "movie") + ":" + item.tmdbId;
    fetch(DISC_URL, { method: "POST", headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON, "Content-Type": "application/json" }, body: JSON.stringify({ radd: [k], hl: regHl() }) })
      .catch(() => { /* counting is a bonus */ });
  } catch { /* ignore */ }
}
async function regRefresh() {
  if (regBusy || !DISC_URL || !canSearch() || Date.now() - regFailAt < 60000) return;
  const st = discState();
  if (st.reg && st.reg.v === 5 && st.reg.choice === st.regChoice && Date.now() - st.reg.at < REG_TTL) return;
  regBusy = true;
  const want = st.regChoice; // the country this answer is for
  try {
    const r = await fetch(DISC_URL + "?mode=region&country=" + encodeURIComponent(want) + "&hl=" + encodeURIComponent(regHl()), { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (st.regChoice === want) { // not changed while waiting: keep it. Otherwise it is for the old country and is dropped
      st.reg = { code: String(j.country || ""), by: String(j.by || ""), items: Array.isArray(j.items) ? j.items : [], at: Date.now(), choice: want, v: 5 };
      discSave();
    }
  } catch (e) {
    if (st.regChoice === want) regFailAt = Date.now();
    console.error("regional trending failed", e);
  }
  regBusy = false;
  if (tab === "disc") renderDiscoverTab(); // also starts the answer for a country picked meanwhile
}
function regSection(owned, have) {
  const st = discState(), reg = st.reg;
  const code = st.regChoice || (reg && reg.code) || "";
  const opts = [...new Set([...REG_COUNTRIES, code].filter(Boolean))].sort((a, b) => regName(a).localeCompare(regName(b)));
  const sel = `<span class="reg-wrap"><span class="reg-text" aria-hidden="true">${esc(code ? regName(code) : "Choose country")}</span><select class="reg-pick" data-dreg aria-label="Choose country">` +
    (st.regChoice ? `<option value="">Detect automatically</option>` : code ? "" : `<option value="" selected>Choose country</option>`) +
    opts.map((c) => `<option value="${esc(c)}"${c === code ? " selected" : ""}>${esc(regName(c))}</option>`).join("") + `</select></span>`;
  const head = `<div class="reg-head"><h3 class="coll-sub">Popular in ${esc(code ? regName(code) : "your country")}</h3>${sel}</div>`;
  if (!code) return head + `<p class="disc-note">${regBusy ? "Finding your country…" : "Choose your country to see what is popular there."}</p>`;
  const rows = ((reg && reg.items) || []).filter((r) => !owned.has(discKey(r)) && !have.has(discKey(r))).slice(0, 30);
  if (rows.length) return head + pkRow("pkReg", rows, false);
  return head + `<p class="disc-note">${regBusy || !reg ? "Loading…" : "Nothing to show for " + esc(regName(code)) + " yet."}</p>`;
}
function regChoose(v) {
  const st = discState();
  st.regChoice = /^[A-Z]{2}$/.test(v) ? v : "";
  st.reg = null;
  regFailAt = 0; // a new pick is asked for at once, even after an earlier failure
  discSave();
  renderDiscoverTab();
}
$("list").addEventListener("change", (e) => {
  const s = e.target && e.target.closest ? e.target.closest("select[data-dreg]") : null;
  if (s) regChoose(s.value);
});

/* ---- Popular anime (Discover): trending Japanese animation, one list for everyone, kept on this device for a few hours ---- */
let animeMem = null, animeBusy = false, animeFailAt = 0, animeErr = false;
function animeState() {
  if (animeMem) return animeMem;
  let st = {};
  try { st = JSON.parse(localStorage.getItem("wl-anime2") || "{}") || {}; } catch { /* storage blocked */ }
  animeMem = { items: Array.isArray(st.items) ? st.items : [], at: +st.at || 0 };
  return animeMem;
}
async function animeRefresh() {
  if (animeBusy || !DISC_URL || !canSearch() || Date.now() - animeFailAt < 60000) return;
  const st = animeState();
  if (st.items.length && Date.now() - st.at < REG_TTL) return;
  animeBusy = true;
  try {
    const r = await fetch(DISC_URL + "?mode=anime", { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (!Array.isArray(j.items)) throw new Error("the deployed discover function is the old one (no anime mode)");
    st.items = j.items;
    st.at = Date.now();
    animeErr = false;
    try { localStorage.setItem("wl-anime2", JSON.stringify(st)); } catch { /* storage blocked */ }
  } catch (e) {
    animeFailAt = Date.now();
    animeErr = true;
    console.error("anime failed", e);
  }
  animeBusy = false;
  if (tab === "disc") renderDiscoverTab();
}
function animeSection(owned, have) {
  const rows = animeState().items.filter((r) => !owned.has(discKey(r)) && !have.has(discKey(r))).slice(0, 30);
  if (rows.length) return `<h3 class="coll-sub">Popular anime</h3>` + pkRow("pkAnime", rows, false);
  if (animeBusy) return `<h3 class="coll-sub">Popular anime</h3><p class="disc-note">Loading…</p>`;
  return animeErr ? `<h3 class="coll-sub">Popular anime</h3><p class="disc-note">Could not load anime. Deploy the latest discover function (supabase functions deploy discover --no-verify-jwt).</p>` : "";
}

function renderDiscoverTab() {
  const st = discState(), owned = discOwned();
  if (!DISC_URL || !canSearch()) {
    $("list").innerHTML = `<div class="empty">Discover needs the built-in search (Supabase) or a TMDB key. Open the menu → API key.</div>`;
    return;
  }
  discRefresh();
  regRefresh();
  animeRefresh();
  const seeds = discSeeds();
  st.picks = st.picks.filter((r) => !owned.has(discKey(r))); // added some other way: gone from today's five
  if (st.picks.length < DISC_SHOW && st.pool.length && seeds.length) { const had = st.picks.length; discFill(); if (st.picks.length !== had) discSave(); } // the five ran out (or the pool arrived late): draw again
  const have = new Set(st.picks.map(discKey));
  const trend = st.trend.filter((r) => !owned.has(discKey(r)) && !have.has(discKey(r)));
  const now = trend.slice(0, 30);
  const taste = st.profile && st.profile.n ? [...(st.profile.genres || []), ...(st.profile.langs || []).map(langLabel)].filter(Boolean).slice(0, 4) : [];
  let html = "";
  if (!seeds.length) html += `<h3 class="coll-sub">Picked for you</h3><p class="disc-note">Mark a few titles as watched and this fills with picks that match your taste, a new set every day.</p>`;
  else if (st.picks.length) html += `<h3 class="coll-sub">Picked for you</h3>` +
    pkRow("pkPicks", st.picks, false);
  else if (!discErr) html += `<h3 class="coll-sub">Picked for you</h3><p class="disc-note">Finding titles for your taste…</p>`;
  html += regSection(owned, have);
  if (now.length) html += `<h3 class="coll-sub">Global trending</h3>` + pkRow("pkTrend", now, false);
  html += animeSection(owned, new Set([...have, ...now.map(discKey)].filter(() => false)));
  if (discErr) html += `<div class="empty">${esc(discErr)}</div>`;
  else if (discBusy && !now.length) html += `<div class="empty">Loading…</div>`;
  $("list").innerHTML = html;
  pkInit();
}
const discFind = (k) => { const st = discState(); return [...st.picks, ...st.trend, ...st.pool, ...((st.reg && st.reg.items) || []), ...animeState().items].find((r) => discKey(r) === k); };
function discOpen(k) {
  const r = discFind(k);
  if (!r) return;
  openTinfo({ title: r.title, tmdbId: r.id, type: r.media_type === "tv" ? "tv" : "movie", year: yearOf(r), poster: r.poster_path ? IMG_SAVED + r.poster_path : "", posterPath: r.poster_path || "" });
}
// one of today's five is gone (added or crossed out): a new one takes its place at once
function discFill() {
  const st = discState();
  const need = DISC_SHOW - st.picks.length;
  if (need <= 0 || !discSeeds().length) return;
  const exclude = new Set(st.picks.map(discKey));
  const more = discDraw(need, exclude, new Set());
  more.forEach((r) => { st.seen[discKey(r)] = (st.seen[discKey(r)] || 0) + 1; });
  st.picks = st.picks.concat(more);
  if (more.length) discPost(more.map(discKey), []);
}
function discAdd(k) {
  const r = discFind(k);
  if (!r || findPartItem(r)) return;
  const st = discState();
  const item = {
    id: Date.now(), title: r.title || "Untitled", stars: 3, note: "", done: false, year: yearOf(r), type: r.media_type === "tv" ? "tv" : "movie",
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null, poster: r.poster_path ? IMG_SAVED + r.poster_path : "", posterPath: r.poster_path || "", tmdbId: r.id, tmdbTitle: r.title || "",
  };
  insertNew(item);
  save();
  forgetTitleKeys(item);
  warmRelated(item.tmdbId, item.type);
  st.liked = st.liked.filter((x) => x !== k).concat(k).slice(-8); // a lighter taste seed from now on
  st.picks = st.picks.filter((x) => discKey(x) !== k);
  discFill();
  discSave();
  discPost([], [k]); // everyone's list learns that this one was added
  render();
  toast(`${item.title} added to To watch`);
  hydratePosters();
}
function discNo(k) {
  const st = discState();
  st.no[k] = 1; // never again on this device
  st.picks = st.picks.filter((x) => discKey(x) !== k);
  discFill();
  discSave();
  render();
}

function closeColl() {
  $("coll").hidden = true;
  collState = null;
}

// Adds only the ticked films, in release order, as "To watch" with medium priority.
function addCollectionParts() {
  const d = collState;
  if (!d) return;
  const ids = [...$("collList").querySelectorAll("input[data-part]:checked:not(:disabled)")].map((i) => +i.dataset.part);
  const parts = d.parts.filter((p) => ids.includes(p.id) && !findPartItem(p) && !isUnreleased(p));
  const relKeys = [...$("coll").querySelectorAll("input[data-rel]:checked:not(:disabled)")].map((i) => i.dataset.rel);
  const rels = (d.related || []).filter((r) => relKeys.includes(r.media_type + ":" + r.id) && !findPartItem(r) && !isUnreleased(r));
  if (!parts.length && !rels.length) return;
  const base = Date.now();
  parts.forEach((p, k) => {
    insertNew({
      id: base + k,
      title: p.title || "Untitled",
      stars: 3,
      note: "",
      done: false,
      year: (p.release_date || "").slice(0, 4),
      type: "movie",
      rating: p.vote_average ? Math.round(p.vote_average * 10) / 10 : null,
      poster: p.poster_path ? IMG_SAVED + p.poster_path : "",
      posterPath: p.poster_path || "",
      tmdbId: p.id,
      tmdbTitle: p.title || "",
      collectionId: d.id,
      collectionName: d.name,
      collectionPart: d.parts.findIndex((x) => x.id === p.id) + 1,
      collectionTotal: d.parts.length,
    });
  });
  rels.forEach((r, k) => {
    insertNew({
      id: base + parts.length + k,
      title: r.title || "Untitled",
      stars: 3,
      note: "",
      done: false,
      year: yearOf(r),
      type: r.media_type,
      rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
      poster: r.poster_path ? IMG_SAVED + r.poster_path : "",
      posterPath: r.poster_path || "",
      tmdbId: r.id,
      tmdbTitle: r.title || "",
    });
  });
  const total = parts.length + rels.length;
  learnSimilar(d, rels.map((r) => r.media_type + ":" + r.id));
  save();
  closeColl();
  render();
  toast(`${total} ${total === 1 ? "title" : "titles"} added to To watch`);
  hydratePosters(); // keeps a copy of each poster on this device
}

/* ---- small details popup for a title on the To watch / Watched tabs ----
   Tap a tile (not its stars or buttons) to see: poster, year, language, director (series: creator), production house and
   the best-known lead actors. One TMDB call per title (the title page with its credits), kept in memory so a second tap is instant. */
const tinfoCache = new Map();
const tinfoPending = new Map(); // key -> lookup already under way
let tinfoKey = "";
let tinfoItem = null; // the title shown in the details popup (for its Share button)
const langLabel = (c) => { try { return (c && new Intl.DisplayNames(["en"], { type: "language" }).of(c)) || c || ""; } catch { return c || ""; } };
function tinfoFacts(kind, r) {
  const names = (a, n) => (a || []).map((x) => x && x.name).filter(Boolean).slice(0, n);
  const crew = (r.credits && r.credits.crew) || [];
  const directors = kind === "tv" ? names(r.created_by, 2) : names(crew.filter((c) => c.job === "Director"), 2);
  const studios = names(r.production_companies && r.production_companies.length ? r.production_companies : r.networks, 2);
  // the top-billed actors in billing order: main roles first, then the supporting cast (real names, not characters)
  const cast = [...new Set(((r.credits && r.credits.cast) || []).slice(0, 30).map((p) => p.name).filter(Boolean))].slice(0, 30);
  return { plot: String(r.overview || r.tagline || "").trim(), lang: langLabel(r.original_language), directors, studios, cast, dirLabel: kind === "tv" ? "Created by" : "Director" };
}
// "Where to watch": providers for the chosen country. No location permission is used: the country is the one saved from the picker,
// else India when the device time zone is Indian, else the region in the device language, else India. The picker lists the main markets.
const WTW_KEY = "movie-watchlist-region";
function wtwRegion() {
  try { const v = localStorage.getItem(WTW_KEY); if (v) return v; } catch { /* storage blocked */ }
  let tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { /* old browser */ }
  if (/^Asia\/(Kolkata|Calcutta)$/.test(tz)) return "IN";
  return regHl() || "IN";
}
let tinfoLast = null; // details shown in the popup (so a country change can redraw the row)
// Same service listed under several names (Prime Video, "with Ads", "Free with Ads"; MX Player, "Amazon MX Player") counts once.
function wtwName(n) {
  n = String(n || "").replace(/\s+(free\s+)?with ads$/i, "").trim();
  if (/^amazon prime video$/i.test(n)) return "Prime Video";
  if (/^amazon mx player$/i.test(n)) return "MX Player";
  return n;
}
// Names for one country, grouped, each service in its best group only (stream, then free, then rent / buy).
function wtwGroups(res, cc) {
  const r = (res && res[cc]) || {}, seen = new Set();
  const names = (...lists) => { const out = []; lists.forEach((l) => (l || []).forEach((p) => { const n = wtwName(p && p.provider_name); if (n && !seen.has(n)) { seen.add(n); out.push(n); } })); return out; };
  return [["Stream", names(r.flatrate)], ["Free", names(r.free, r.ads)], ["Rent or buy", names(r.rent, r.buy)]].filter((g) => g[1].length);
}
function wtwRow(f) {
  if (!f) return "";
  const res = f.wtw || {};
  const cc = wtwRegion();
  const here = wtwGroups(res, cc);
  // not on a service in the chosen country: still say where it IS (other main markets), or what the app found (streaming-guide search / network)
  const elsewhere = here.length ? [] : OTT_ORDER.filter((c) => c !== cc).map((c) => [c, wtwGroups(res, c)]).filter((x) => x[1].length).slice(0, 4);
  const o = tinfoItem && tinfoItem.ott;
  const known = !here.length && !elsewhere.length && !!o && (o.t === 0 || o.s === 1) && !!(o.sv || o.n);
  if (!here.length && !elsewhere.length && !known) return ""; // in cinemas / not out anywhere yet: hide the row
  const codes = [...new Set([...OTT_ORDER, cc])];
  const sel = `<select class="wtw-sel" data-wtw aria-label="Country">${codes.map((c) => `<option value="${esc(c)}"${c === cc ? " selected" : ""}>${esc(regName(c))}</option>`).join("")}</select>`;
  let rows = here.map(([l, a]) => `<div class="wtw-r"><span class="wtw-l">${esc(l)}</span><span class="wtw-v">${esc(a.join(" \u00B7 "))}</span></div>`).join("");
  const else_ = elsewhere.length ? `<p class="wtw-none ti-dim wtw-else">Elsewhere</p>` + elsewhere.map(([c, g]) => `<div class="wtw-r"><span class="wtw-l">${esc(regName(c))}</span><span class="wtw-v">${esc(g.map(([l, a]) => a.join(" \u00B7 ") + (l === "Stream" ? "" : " (" + l.toLowerCase() + ")")).join("; "))}</span></div>`).join("") : "";
  let note = "";
  if (known) {
    // The app knows it is out. With a service named, show it as a normal row; without, say so plainly. No source names (TMDB ...) in the popup.
    if (o.sv) {
      rows = `<div class="wtw-r"><span class="wtw-l">Stream</span><span class="wtw-v">${esc(o.sv)}${o.sc ? ` <span class="ti-dim">(${esc(regName(o.sc))})</span>` : ""}</span></div>`;
      note = o.wk ? "Not yet confirmed by a streaming guide" : /Watchmode/.test(o.n || "") ? "via Watchmode" : /Gemini/.test(o.n || "") ? "via Gemini search (JustWatch)" : "";
    } else rows = `<p class="wtw-none ti-dim">Expected on streaming, platform not confirmed yet</p>`;
  } else if (f.gemNote) note = f.gemNote === "wm" ? "via Watchmode" : "via Gemini search (JustWatch)";
  const noteLine = note ? `<p class="wtw-none ti-dim">${esc(note)}</p>` : "";
  return `<div class="wtw"><dt class="wtw-sr">Where to watch</dt><dd>${sel}${rows || `<p class="wtw-none ti-dim">Not on any service in ${esc(regName(cc))} yet</p>`}${else_}${noteLine}</dd></div>`;
}
function tinfoRows(f) {
  const pid = (f.crew && f.crew.pid) || {};
  // a name that has a TMDB person id is a button that opens that person's page; others stay plain text
  const link = (n) => (pid[n] ? `<button type="button" class="ti-person" data-pid="${esc(pid[n])}">${esc(n)}</button>` : esc(n));
  const links = (arr) => arr.map(link).join(", ");
  const cids = (f.crew && f.crew.cid) || {};
  const clink = (n) => (cids[n] ? `<button type="button" class="ti-person" data-cid="${esc(cids[n])}">${esc(n)}</button>` : esc(n));
  const rowL = (label, arr) => (arr && arr.length ? `<div><dt>${esc(label)}</dt><dd>${links(arr)}</dd></div>` : "");
  const row = (label, v) => (v ? `<div><dt>${esc(label)}</dt><dd>${esc(v)}</dd></div>` : "");
  // Starring: the first 6 names, then a lone + that opens the rest of the cast
  let star = "";
  if (f.cast.length) {
    const rest = f.cast.slice(6);
    star = `<div><dt>Starring</dt><dd>${links(f.cast.slice(0, 6))}${rest.length ? `<span id="tiCastRest" hidden>, ${links(rest)}</span> <button type="button" class="ti-plus" id="tiCastMore" aria-label="Show more cast" aria-expanded="false">+</button>` : ""}</dd></div>`;
  }
  // Series: "5 seasons · 62 episodes · Ended" (+ opens the episodes of each season); ongoing shows also get a Next episode row
  let sea = "";
  if (f.seasons) {
    const q = f.seasons;
    if (q.none) { // TMDB has nothing for it (some anime, brand-new shows) or the lookup failed
      sea = `<div><dt>Seasons</dt><dd class="ti-dim">${esc(q.failed ? "Could not load season info. Open again to retry." : "Not listed on TMDB or Wikidata yet")}</dd></div>`;
    } else {
      const per = q.list.length > 1 || (q.list.length === 1 && q.list[0].aired !== undefined) ? q.list.map(seasonPart).join(" \u00B7 ") : "";
      sea = `<div><dt>Seasons</dt><dd>${esc(seasonSummary(q))}${q.src ? ` <span class="ti-dim">(${esc(q.src)})</span>` : ""}${per ? ` <button type="button" class="ti-plus" id="tiSeasonMore" aria-label="Show episodes per season" aria-expanded="false">+</button><span id="tiSeasonRest" hidden>${esc(per)}</span>` : ""}</dd></div>`;
      if (q.next) sea += `<div><dt>${esc(q.nextLabel || "Next episode")}</dt><dd>${esc(q.next)}</dd></div>`;
    }
  }
  const c = f.crew || {};
  return wtwRow(f) + row("Language", f.lang) + sea + rowL(f.dirLabel, f.directors) + rowL("Music", c.music) + rowL("Cinematography", c.dop) + rowL("Editor", c.editor) + (f.studios.length ? `<div><dt>Production</dt><dd>${f.studios.map(clink).join(", ")}</dd></div>` : "") + star;
}
// The details come from the "similar" function when it is set up: it asks TMDB, then Wikidata, then OMDb for what is missing, and
// remembers the answer. The shared TMDB proxy only allows a plain title page (no cast / crew), so it is the fallback: that still
// gives the language, production house and summary.
// Seasons and episodes of a series (normal shows and anime): from TMDB's title page. "Specials" (season 0) are not counted.
// Ongoing shows: TMDB lists the episodes of the running season in advance, so "aired" is worked out from the next episode
// (everything before it has aired) and the season shows as "3 of 8 aired". A season with no episodes listed yet is left out.
const STATUS_LABEL = { "Returning Series": "Ongoing", "In Production": "Ongoing", "Pilot": "Pilot", "Planned": "Upcoming", "Ended": "Ended", "Canceled": "Cancelled" };
function seasonInfo(d, wtw) {
  if (!d) return null;
  const list = (d.seasons || []).filter((x) => x && x.season_number > 0 && x.episode_count > 0).map((x) => ({ n: x.season_number, e: x.episode_count }));
  const lim = isLimited(d);
  const st = lim ? "Limited series" : STATUS_LABEL[d.status] || "";
  const rawNx = d.next_episode_to_air && d.next_episode_to_air.season_number > 0 ? d.next_episode_to_air : null;
  const ls = d.last_episode_to_air && d.last_episode_to_air.season_number > 0 ? d.last_episode_to_air : null;
  // TMDB is edited by people and often lags a day or more on a new release (a binge drop especially): its "next episode" can be a date
  // that has already passed. A passed date means that episode is out. JustWatch says (via where-to-watch) the show is streaming:
  // then a premiere dated in the next 3 days counts as out too (released early, or another time zone).
  const todayIso = (() => { const t = new Date(); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); })();
  const streaming = !!(wtw && Object.values(wtw).some((r) => r && ((r.flatrate && r.flatrate.length) || (r.free && r.free.length) || (r.ads && r.ads.length))));
  const daysAhead = rawNx && rawNx.air_date ? Math.round((Date.parse(rawNx.air_date + "T00:00:00") - Date.parse(todayIso + "T00:00:00")) / 864e5) : 99;
  const lapsed = rawNx && (daysAhead <= 0 || (streaming && daysAhead <= 3 && (Number(rawNx.episode_number) || 1) <= 1)) ? rawNx : null;
  const nx = lapsed ? null : rawNx;
  let partial = false;
  if (!list.length && ls) { list.push({ n: ls.season_number, e: ls.episode_number }); partial = true; } // seasons missing but an aired episode is known (common for anime). Only a lower bound, so the progress check only warns
  if (nx) { // the running season: only the episodes before the next one have aired
    const cur = list.find((x) => x.n === nx.season_number);
    const aired = Math.max(0, (Number(nx.episode_number) || 1) - 1);
    if (cur) { if (aired < cur.e) cur.aired = aired; else if (aired > cur.e) cur.e = aired; } // TMDB's total can be behind what has aired
    else list.push({ n: nx.season_number, e: 0, aired: 0 }); // a new season TMDB has dated but not listed yet: no episode count to show
    list.sort((x, y) => x.n - y.n);
  }
  if (lapsed) { // that episode is out. First episode of a season = the whole season dropped; later episode = aired up to it
    const n0 = lapsed.season_number, e0 = Number(lapsed.episode_number) || 1;
    const cur = list.find((x) => x.n === n0);
    if (cur) { if (e0 > 1 && e0 < cur.e) cur.aired = e0; else if (e0 > cur.e) cur.e = e0; }
    else {
      const tot = (Number(d.number_of_seasons) || 0) <= 1 ? Number(d.number_of_episodes) || 0 : 0; // a one-season show: the total is that season
      list.push({ n: n0, e: Math.max(tot, e0) }); if (tot < 1) partial = true; // no count known: only a lower bound
      list.sort((x, y) => x.n - y.n);
    }
  }
  const eps = list.reduce((a, x) => a + x.e, 0) || Number(d.number_of_episodes) || 0;
  const airedEps = list.length ? list.reduce((a, x) => a + (x.aired !== undefined ? x.aired : x.e), 0) : eps;
  const n = list.filter((x) => x.e > 0).length || Number(d.number_of_seasons) || 0;
  if (!n && !eps && !st) return null;
  const live = streaming && !n && !eps; // TMDB has no counts yet but JustWatch lists it on a service: it is out
  const next = nx ? seasonNext(nx) : (st === "Ongoing" ? "Not announced yet" : ""); // a limited series has no next season to wait for
  // "Next season" when the next thing to come is a season premiere (or the running season has fully aired); "Next episode" while a season is still going
  const last = list.length ? list[list.length - 1] : null;
  const nextLabel = nx ? ((Number(nx.episode_number) || 1) <= 1 ? (nx.season_number === 1 ? "Premieres" : "Next season") : "Next episode") : (last && last.aired === undefined && last.e > 0 ? "Next season" : "Next episode");
  return { n, eps, airedEps, list, status: st, next, nextLabel, partial, live };
}
// "S3 E4 · 14 Nov" (the year only when it is not this year)
function seasonNext(e) {
  const dt = e.air_date ? new Date(e.air_date + "T00:00:00") : null;
  let when = "date not announced";
  if (dt && !isNaN(dt)) when = dt.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(dt.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
  return `S${e.season_number} E${e.episode_number || 1} \u00B7 ${when}`;
}
function seasonPart(x) {
  return !x.e ? `S${x.n}: not aired yet` : x.aired !== undefined ? `S${x.n}: ${x.aired} aired` : `S${x.n}: ${x.e}`;
}
// "5 seasons · 62 episodes · Ended"; running shows: "3 seasons · 21 of 24 episodes aired · Ongoing"
function seasonSummary(q) {
  const epText = !q.eps ? "" : q.airedEps < q.eps ? `${plural(q.airedEps, "episode")} aired` : plural(q.eps, "episode"); // a running show: what has aired, not the (often outdated) total
  const parts = [q.n ? plural(q.n, "season") : "", epText, q.status].filter(Boolean);
  if (!q.n && !q.eps) parts.unshift(q.live ? "Streaming now" : "Episodes not listed yet");
  return parts.join(" \u00B7 ");
}
// Second source when TMDB has no season numbers: Wikidata (already allowed by the app). It keeps "number of seasons" and
// "number of episodes" for many series, anime included, found through the TMDB id. Counts only; no per-season list, no next episode.
async function wikidataSeasons(id) {
  const q = `SELECT (MAX(?s) AS ?seasons) (MAX(?e) AS ?episodes) (MAX(?end) AS ?ended) WHERE {
    ?x wdt:P4983 "${Number(id)}" .
    OPTIONAL { ?x wdt:P2437 ?s } OPTIONAL { ?x wdt:P1113 ?e } OPTIONAL { ?x wdt:P582 ?end }
  }`;
  const r = await fetch(WD_URL + "?format=json&query=" + encodeURIComponent(q), { headers: { Accept: "application/sparql-results+json" }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const b = ((await r.json()).results.bindings || [])[0] || {};
  const n = b.seasons ? Math.round(Number(b.seasons.value)) || 0 : 0, eps = b.episodes ? Math.round(Number(b.episodes.value)) || 0 : 0;
  if (!n && !eps) return null;
  return { n, eps, ended: !!b.ended };
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/* Music, cinematography and editor for the details popup. TMDB first (its crew list); whatever TMDB does not have is asked from
   Wikidata; a row that neither knows is simply not shown. Never fails: on any error the rows are just missing. */
const CREW_JOBS = { music: ["Original Music Composer", "Music", "Composer", "Music Director"], dop: ["Director of Photography", "Cinematography"], editor: ["Editor"] };
function crewFrom(crew) {
  const out = {};
  for (const [k, jobs] of Object.entries(CREW_JOBS)) out[k] = [...new Set((crew || []).filter((c) => c && c.name && jobs.includes(c.job)).map((c) => c.name))].slice(0, 2);
  return out;
}
async function wikidataCrew(kind, id) {
  const q = `SELECT (GROUP_CONCAT(DISTINCT ?mL; separator="|") AS ?m) (GROUP_CONCAT(DISTINCT ?dL; separator="|") AS ?d) (GROUP_CONCAT(DISTINCT ?eL; separator="|") AS ?e) WHERE {
    ?x wdt:${kind === "tv" ? "P4983" : "P4947"} "${Number(id)}" .
    OPTIONAL { ?x wdt:P86 ?mi . ?mi rdfs:label ?mL . FILTER(LANG(?mL) = "en") }
    OPTIONAL { ?x wdt:P344 ?di . ?di rdfs:label ?dL . FILTER(LANG(?dL) = "en") }
    OPTIONAL { ?x wdt:P1040 ?ei . ?ei rdfs:label ?eL . FILTER(LANG(?eL) = "en") }
  }`;
  const r = await fetch(WD_URL + "?format=json&query=" + encodeURIComponent(q), { headers: { Accept: "application/sparql-results+json" }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const b = ((await r.json()).results.bindings || [])[0] || {};
  const list = (v) => (v && v.value ? [...new Set(v.value.split("|").map((x) => x.trim()).filter(Boolean))].slice(0, 2) : []);
  return { music: list(b.m), dop: list(b.d), editor: list(b.e) };
}
async function crewLoad(kind, id) {
  let c = { music: [], dop: [], editor: [] };
  const pid = {}, cid = {}; // name -> TMDB person id / production company id, so those names in the popup can be tapped
  try {
    const r = await tmdb("/" + kind + "/" + Number(id), { append_to_response: "credits" });
    c = crewFrom(r && r.credits && r.credits.crew);
    const put = (p) => { if (p && p.name && p.id && !pid[p.name]) pid[p.name] = p.id; };
    ((r && r.created_by) || []).forEach(put);
    ((r && r.production_companies) || []).forEach((p) => { if (p && p.name && p.id && !cid[p.name]) cid[p.name] = p.id; });
    ((r && r.credits && r.credits.cast) || []).slice(0, 40).forEach(put);
    ((r && r.credits && r.credits.crew) || []).forEach(put);
  } catch { /* try Wikidata */ }
  if (!c.music.length || !c.dop.length || !c.editor.length) {
    try { const w = await wikidataCrew(kind, id); for (const k of ["music", "dop", "editor"]) if (!c[k].length) c[k] = w[k] || []; } catch { /* optional */ }
  }
  c.pid = pid; c.cid = cid;
  return c;
}
const wtwAny = (res) => !!res && Object.values(res).some((c) => c && ["flatrate", "free", "ads", "rent", "buy"].some((k) => Array.isArray(c[k]) && c[k].length));
// TMDB lists no service anywhere yet (it lags JustWatch) for a title released in the last 60 days: ask the Gemini search (JustWatch pages),
// add what it finds to the "Where to watch" rows and redraw. The server saves each answer 3 hours.
// force = true is the "Check again" button: no date / tried / already-listed gates, and the server is told to skip its saved answer. Returns true when a service was found.
async function gemWhere(f, m, key, force) {
  const rd = m && m.ott && m.ott.rd;
  if (!SIMILAR_URL || !f || !m) return false;
  if (!force) {
    if (Date.now() < gemCool) return false;
    if (f.gemTried || wtwAny(f.wtw) || !rd || rd > todayIso() || daysSince(rd) > 60) return false;
    if (m.ott && m.ott.sv && !m.ott.wk) return false; // a service is already confirmed
  }
  f.gemTried = true; if (force) f.gemErr = "";
  try {
    const rr = await fetch(SIMILAR_URL + "?avail=1&type=" + kindOf(m) + "&id=" + Number(m.tmdbId) + (force ? "&fresh=1" : ""), { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON }, signal: AbortSignal.timeout(50000) });
    if (!rr.ok) { gemCoolCheck(rr.status === 429 ? "429" : ""); if (force) { f.gemTried = false; f.gemErr = rr.status === 429 ? "too many requests, wait a minute" : "HTTP " + rr.status; } return false; }
    const j = await rr.json();
    if (!j || !j.ok || !j.available) { gemCoolCheck(j && j.error); if (force) f.gemErr = (j && j.error) || (j && j.list ? "server too old (deploy similar)" : ""); return false; }
    const list = Array.isArray(j.entries) && j.entries.length ? j.entries : [{ country: j.country, service: j.service, type: j.type }];
    const KEY = { stream: "flatrate", free: "free", rent: "rent", buy: "buy" };
    f.wtw = f.wtw || {};
    if (m.ott && list[0] && list[0].service) {
      m.ott.sv = wtwName(list[0].service); m.ott.sc = list[0].country || ""; delete m.ott.wk; // confirmed: the list tag stops saying "not confirmed"
      if (m.ott.t === 1 && m.ott.s !== 1) { m.ott.s = 1; m.ott.at = Date.now(); }
      m.ott.g = Date.now(); save(); render();
    }
    for (const e of list) {
      const k = KEY[e.type];
      if (!k || !/^[A-Z]{2}$/.test(e.country || "") || !e.service) continue;
      const c = (f.wtw[e.country] = f.wtw[e.country] || {});
      (c[k] = c[k] || []).push({ provider_name: e.service });
    }
    f.gemNote = j.via === "watchmode" ? "wm" : true;
    if (!$("tinfo").hidden && (force || tinfoKey === key) && tinfoLast === f) $("tiRows").innerHTML = tinfoRows(f);
    return true;
  } catch { f.gemTried = false; /* optional: try again next time */ return false; }
}
async function tinfoLoad(kind, id) {
  let failed = false;
  const [f, sd, crew, wp] = await Promise.all([tinfoLoadBase(kind, id), kind === "tv" ? tmdb("/tv/" + Number(id)).catch(() => { failed = true; return null; }) : null, crewLoad(kind, id), tmdb("/" + kind + "/" + Number(id) + "/watch/providers").catch(() => null)]);
  f.crew = crew;
  f.wtw = wp && wp.results ? wp.results : null; // where to watch, every country (JustWatch data via TMDB); the region is picked when the row is drawn
  if (kind === "tv") {
    let si = seasonInfo(sd, wp && wp.results);
    if (!failed && (!si || (!si.n && !si.eps) || (si.partial && si.eps <= 1))) { // TMDB has no counts (or only a lower bound): ask Wikidata
      let w = null;
      try { w = await wikidataSeasons(id); } catch { /* optional */ }
      if (w && (!si || !si.partial || w.eps > si.eps)) si = { n: w.n, eps: w.eps, airedEps: w.eps, list: [], status: (si && si.status) || (w.ended ? "Ended" : ""), next: (si && si.next) || "", nextLabel: si && si.nextLabel, src: "Wikidata" };
    }
    f.seasons = si || { none: true, failed };
    if (failed) f.noCache = true; // a failed lookup is not remembered, so opening the card again tries again
  }
  return f;
}
async function tinfoLoadBase(kind, id) {
  if (SIMILAR_URL) {
    try {
      const r = await fetch(SIMILAR_URL + "?details=1&type=" + kind + "&id=" + Number(id), { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON }, signal: AbortSignal.timeout(7000) });
      if (r.ok) {
        const j = await r.json();
        const d = j && j.details;
        if (d) return { plot: d.plot || "", lang: langLabel(d.lang), directors: d.directors || [], studios: d.studios || [], cast: (d.cast || []).slice(0, 30), dirLabel: d.dirLabel || (kind === "tv" ? "Created by" : "Director") };
      }
    } catch { /* fall back to TMDB below */ }
  }
  return tinfoFacts(kind, await tmdb("/" + kind + "/" + id, { append_to_response: "credits" }));
}
async function openTinfo(m) {
  if (!m || !m.tmdbId || !canSearch()) return; // plain-text titles have nothing to look up
  const kind = kindOf(m), id = m.tmdbId, key = kind + ":" + id;
  tinfoKey = key;
  tinfoItem = m;
  const poster = m.poster || (m.posterPath ? IMG_SAVED + m.posterPath : "");
  $("tiTitle").textContent = m.title;
  $("tiSub").textContent = metaOf(m);
  // a sharper 342 px copy when online (the saved one is only 185 px, made small to keep the list light); offline or on any error it falls back to the saved one
  const pPath = m.posterPath || (typeof m.poster === "string" && m.poster.startsWith(IMG_SAVED) ? m.poster.slice(IMG_SAVED.length) : "");
  $("tiPoster").innerHTML = poster ? `<img src="${esc(poster)}" alt="" draggable="false">` : "";
  if (poster && pPath && navigator.onLine !== false) {
    const big = new Image();
    big.alt = ""; big.draggable = false;
    big.onload = () => { if (tinfoKey === key) { const cur = $("tiPoster").querySelector("img"); if (cur) cur.src = big.src; } }; // swap in only when it has loaded, so there is never a blank poster
    big.src = IMG_T + "w342" + pPath;
  }
  $("tiRows").innerHTML = "";
  $("tiPlot").hidden = true; $("tiPlot").className = "ti-plot"; $("tiPlotMore").hidden = true;
  $("tiStatus").textContent = "Loading details…";
  $("tiStatus").className = "panel-status";
  $("tinfo").hidden = false;
  $("tiClose").focus();
  try {
    let f = tinfoCache.get(key);
    if (!f && tinfoPending.has(key)) f = await tinfoPending.get(key);
    if (!f) {
      f = await tinfoLoad(kind, id);
      if (!f.noCache) tinfoCache.set(key, f);
    }
    if ($("tinfo").hidden || tinfoKey !== key) return; // closed or another tile opened meanwhile
    $("tiPlot").textContent = f.plot;
    $("tiPlot").hidden = !f.plot;
    $("tiPlotMore").hidden = true; setPlotBtn(false);
    if (f.plot) { const cut = $("tiPlot").scrollHeight > $("tiPlot").clientHeight + 1; $("tiPlot").classList.toggle("more", cut); $("tiPlotMore").hidden = !cut; } // cut off: show the + button
    tinfoLast = f;
    $("tiRows").innerHTML = tinfoRows(f);
    $("tiStatus").textContent = f.plot || $("tiRows").children.length ? "" : "No more details on file for this title.";
    gemWhere(f, m, key); // not awaited: the popup is already drawn, the rows update when the answer comes
  } catch {
    if ($("tinfo").hidden || tinfoKey !== key) return;
    $("tiStatus").textContent = "Could not load details. Check your internet connection.";
    $("tiStatus").className = "panel-status err";
  }
}
// warm the cache as soon as a finger / pointer goes down on a tile, so the popup is often instant
function prefetchTinfo(m) {
  if (!m || !m.tmdbId || !canSearch()) return;
  const kind = kindOf(m), key = kind + ":" + m.tmdbId;
  if (tinfoCache.has(key) || tinfoPending.has(key)) return;
  const pr = tinfoLoad(kind, m.tmdbId).then((f) => { if (!f.noCache) tinfoCache.set(key, f); return f; }).catch(() => null).finally(() => tinfoPending.delete(key));
  tinfoPending.set(key, pr);
}
function closeTinfo() { $("tinfo").hidden = true; tinfoKey = ""; }

/* ---- Calendar (Watching tab, "Calendar" switch) ----
   One agenda list: the next episode of every series in To watch / Watching, and the release date of every movie in To watch.
   Dates come from TMDB (one request per title, remembered on this device for a few hours, so reopening is instant).
   Premiere and finale tags come from TMDB's own episode data. No alerts: a web app cannot send them reliably when it is closed. */
const CAL_KEY = "movie-watchlist-cal-v2", CAL_TTL = 6 * 3600e3;
let calCache = null, calBusy = false, calErr = false;
const calLoad = () => { if (!calCache) { try { calCache = JSON.parse(localStorage.getItem(CAL_KEY)) || {}; } catch { calCache = {}; } } return calCache; };
const calSave = () => { try { localStorage.setItem(CAL_KEY, JSON.stringify(calCache)); } catch { /* storage full or blocked: dates are just asked again */ } };
const calToday = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const calDays = (iso) => Math.round((Date.parse(iso + "T00:00:00") - Date.parse(calToday() + "T00:00:00")) / 864e5);
const calKey = (m) => kindOf(m) + ":" + m.tmdbId;
function calCompact(kind, d, season) {
  if (kind !== "tv") return { rd: d.release_date || "" };
  const ep = (x) => (x && x.season_number > 0 && x.air_date ? { d: x.air_date, s: x.season_number, e: Number(x.episode_number) || 1, t: x.episode_type || "" } : null);
  // every dated episode of the airing season from a week ago to 45 days ahead (a show with two episodes a week shows both)
  const eps = ((season && season.episodes) || []).map((x) => ep({ ...x, season_number: x.season_number || (season && season.season_number) })).filter((x) => x && calDays(x.d) >= -7 && calDays(x.d) <= 45).slice(0, 40);
  return { v: 2, nx: ep(d.next_episode_to_air), ls: ep(d.last_episode_to_air), eps, end: d.status === "Returning Series" || d.status === "In Production" ? 0 : 1 };
}
// which titles belong in the calendar: series (running or not yet started) and movies that are not out for more than a week
function calEligible() {
  return items.filter((m) => {
    if (!m.tmdbId) return false;
    // a series you finished (Watched, with a season saved): it only shows when a newer season is dated, so a new season is never missed
    if (m.done) return kindOf(m) === "tv" && !!m.progress && m.progress.season !== undefined && m.progress.season !== "";
    if (!(inTab(m, "watch") || inTab(m, "watching"))) return false;
    if (kindOf(m) !== "movie") return true;
    return !(m.ott && m.ott.rd && calDays(m.ott.rd) < -7) && !inTab(m, "watching");
  });
}
function calFresh(c, m) {
  if (!c) return false;
  if (kindOf(m) === "movie") return (c.rd && calDays(c.rd) < -7) || Date.now() - c.at < 12 * 3600e3; // a date long past never comes back
  if (c.v !== 2) return false; // remembered by an older version: ask again
  if (c.nx && calDays(c.nx.d) < 0) return false; // the "next" episode has aired: ask for the new next one
  return Date.now() - c.at < (c.end ? 7 * 864e5 : CAL_TTL);
}
// An episode is "watched" when it is at or before the Season / Episode saved in the title's Progress. The calendar hides those.
const calWatched = (m, s, e) => {
  const p = m.progress;
  if (!p || p.season === undefined || p.season === "") return false;
  const ps = +p.season, pe = +p.episode || 0;
  return s < ps || (s === ps && e <= pe);
};
const calTag = (x) => (x.e === 1 ? [x.s === 1 ? "Series premiere" : "Season premiere", "wk"] : x.t === "finale" ? ["Finale", "wait"] : x.t === "mid_season" ? ["Mid-season finale", "wait"] : ["", ""]);
function calEntries() {
  const cache = calLoad(), out = [];
  for (const m of calEligible()) {
    const c = cache[calKey(m)];
    if (!c) continue;
    if (kindOf(m) === "movie") {
      if (c.rd && calDays(c.rd) >= -7) {
        const n = calDays(c.rd); // release day: say it plainly instead of a bare "release"
        const st = filmStage(m, c.rd, true); // the same rule as the To watch list
        const [tag, cls] = st ? [st[0], st[1]] : ["", ""];
        out.push({ m, date: c.rd, line: n > 1 ? "Movie \u00B7 release" : "Movie", tag, cls });
      }
      continue;
    }
    const seen = new Set();
    const add = (x) => { const k = x.s + "-" + x.e; if (seen.has(k)) return; seen.add(k); if (m.done && x.s <= (+m.progress.season || 0)) return; if (calWatched(m, x.s, x.e)) return; const [tag, cls] = calTag(x); out.push({ m, date: x.d, line: `S${x.s} E${x.e}`, tag, cls, s: x.s, e: x.e }); };
    (c.eps || []).forEach((x) => { const n = calDays(x.d); if (n >= -7 && n <= 30) add(x); }); // next 30 days and the last 7
    if (c.nx) add(c.nx); // the next episode is always shown, even when it is further away
    if (c.ls && calDays(c.ls.d) >= -7 && calDays(c.ls.d) <= 0) add(c.ls);
  }
  return out;
}
let calOpen = new Set(); // groups opened to show their single episodes
// Same series + same season + same day = one row. A weekly show (one episode a day) is left alone.
function calMerge(list) {
  const out = [], by = new Map();
  for (const e of list) {
    if (!e.s) { out.push(e); continue; }
    const k = e.m.id + "|" + e.date + "|" + e.s;
    let g = by.get(k);
    if (!g) { g = { eps: [] }; by.set(k, g); out.push(g); }
    g.eps.push(e);
  }
  return out.map((g) => {
    if (!g.eps) return g;
    if (g.eps.length === 1) return g.eps[0];
    const eps = g.eps.slice().sort((a, b) => a.e - b.e), f = eps[0], l = eps[eps.length - 1];
    const contig = eps.every((x, i) => i === 0 || x.e === eps[i - 1].e + 1);
    const tags = []; eps.forEach((x) => { if (x.tag && !tags.some((t) => t[0] === x.tag)) tags.push([x.tag, x.cls]); });
    return { m: f.m, date: f.date, s: f.s, e: l.e, e1: f.e, eps, tags, grp: f.m.id + "|" + f.date + "|" + f.s,
      line: contig ? `S${f.s} E${f.e}\u2013E${l.e} \u00B7 ${eps.length} episodes` : `S${f.s} \u00B7 ${eps.length} episodes` };
  });
}
function renderCalendar(noFetch) {
  const groups = [["Today", []], ["Tomorrow", []], ["This week", []], ["Later", []], ["Just released", []]];
  const entries = calEntries();
  entries.forEach((e) => {
    const n = calDays(e.date);
    groups[n < 0 ? 4 : n === 0 ? 0 : n === 1 ? 1 : n <= 7 ? 2 : 3][1].push(e);
  });
  const yr = new Date().getFullYear();
  const label = (iso) => { const t = new Date(iso + "T00:00:00"); return t.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(t.getFullYear() !== yr ? { year: "numeric" } : {}) }); };
  const row = (e, sub) => {
    const m = e.m, p = m.poster || (m.posterPath ? IMG_SAVED + m.posterPath : "");
    const thumb = p ? `<img src="${esc(p)}" alt="" loading="lazy" draggable="false">` : "";
    const tags = (e.tags || (e.tag ? [[e.tag, e.cls]] : [])).map(([t, c]) => ` <span class="ott-tag ${c}">${esc(t)}</span>`).join("");
    const rng = e.e1 && e.e1 < e.e ? `E${e.e1}\u2013E${e.e}` : `E${e.e}`;
    const tick = e.s && calDays(e.date) <= 0 ? `<button type="button" class="cal-tick" data-caltick="${m.id}:${e.s}:${e.e}${e.e1 ? ":" + e.e1 : ""}" aria-label="Mark S${e.s} ${rng} as watched" title="${e.eps ? "Mark all " + e.eps.length + " as watched" : "Mark as watched"}"><svg class="ico" viewBox="3.5 3.5 9 9" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></button>` : "";
    const chev = e.eps ? `<span class="cal-chev" aria-hidden="true">${calOpen.has(e.grp) ? "\u25BE" : "\u25B8"}</span>` : "";
    const attr = e.eps ? `data-calgrp="${esc(e.grp)}" aria-expanded="${calOpen.has(e.grp)}"` : `data-calrow="${m.id}"`;
    return `<div class="pp-row cal-row${e.eps ? " cal-grp" : ""}${sub ? " cal-sub" : ""}" ${attr}><div class="pp-thumb">${thumb}</div><div class="pp-info"><p class="pp-t">${esc(m.title)}</p><p class="pp-m">${esc(e.line)}${chev}${e.eps ? "" : tags}</p>${e.eps && tags ? `<p class="pp-m cal-tagline">${tags}</p>` : ""}</div><span class="cal-side">${tick}<span class="cal-date">${esc(label(e.date))}</span></span></div>`;
  };
  const rowAll = (e) => e.eps ? row(e) + (calOpen.has(e.grp) ? e.eps.map((x) => row(x, true)).join("") : "") : row(e);
  let html = "";
  groups.forEach(([name, list], i) => {
    if (!list.length) return;
    list.sort((a, b) => (i === 4 ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)) || a.m.title.localeCompare(b.m.title));
    html += `<h3 class="coll-sub">${name}</h3>` + calMerge(list).map(rowAll).join("");
  });
  if (!html) html = `<div class="empty">${calBusy ? "Loading dates\u2026" : calErr ? "Could not load dates. Check your internet connection." : "Nothing dated yet. Series with a next episode and movies with a release date show up here."}</div>`;
  else html += `<p class="cal-note">${calBusy ? "Updating dates\u2026" : calErr ? "Some dates could not be updated." : "Dates come from TMDB and can still move."}</p>`;
  $("list").innerHTML = html;
  if (!noFetch) calRefresh();
}
async function calRefresh(bg, only) { // bg: refreshing dates for release alerts while the calendar is not on screen
  if (calBusy || !canSearch() || navigator.onLine === false) return;
  const cache = calLoad();
  const todo = calEligible().filter((m) => (!only || only(m)) && !calFresh(cache[calKey(m)], m));
  if (!todo.length) return;
  calBusy = true; calErr = false;
  const live = () => bg || (tab === "watching" && calView);
  const show = () => !bg && tab === "watching" && calView;
  if (show()) renderCalendar(true); // shows "Loading dates…" at once when nothing is remembered yet
  try {
    for (const m of todo) {
      if (!live()) break; // left the calendar: the rest is asked next time
      try {
        const d = await tmdb("/" + kindOf(m) + "/" + Number(m.tmdbId));
        let season = null;
        const nx = kindOf(m) === "tv" && d && d.next_episode_to_air && d.next_episode_to_air.season_number > 0 ? d.next_episode_to_air.season_number : 0;
        if (nx) { await pause(1200); try { season = await tmdb("/tv/" + Number(m.tmdbId) + "/season/" + nx); } catch { /* the next episode alone is still shown */ } }
        cache[calKey(m)] = { at: Date.now(), ...calCompact(kindOf(m), d || {}, season) };
        calSave();
        if (show()) renderCalendar(true);
      } catch { calErr = true; break; }
      await pause(1200); // stay under the request limit
    }
  } finally {
    calBusy = false;
    if (show()) renderCalendar(true);
  }
}
$("calBtn").addEventListener("click", () => {
  calView = !calView;
  try { localStorage.setItem(CAL_VIEW_KEY, calView ? "1" : "0"); } catch { /* optional */ }
  render();
});
// the tick on an aired episode: saves it as your Progress (so the calendar and the Progress sheet agree) and hides it; Undo puts it back
$("list").addEventListener("click", (e) => {
  const t = e.target.closest("[data-caltick]");
  if (!t) return;
  e.stopPropagation();
  const [id, ss, ee, e1] = t.dataset.caltick.split(":");
  const m = items.find((x) => x.id === +id);
  if (!m) return;
  const was = { progress: m.progress ? { ...m.progress } : undefined, watching: m.watching, done: m.done, watchedAt: m.watchedAt };
  const base = m.progress || { th: "", tm: "", release: "", days: [], remind: false, remindTime: "" };
  const stale = base.release === "ended" || base.release === "out"; // a finished-season / finished-show status no longer fits a newer episode
  m.progress = { ...base, ...(stale ? { release: "" } : {}), season: String(+ss), episode: String(+ee), th: "", tm: "", updated: Date.now() };
  if (m.done) { m.done = false; m.watching = true; delete m.watchedAt; } // a finished show with a new season: watching it again
  else m.watching = true; // ticking an episode of a To watch show means you have started it
  save();
  render();
  toast(`${m.title} S${+ss} ${e1 && +e1 < +ee ? `E${+e1}\u2013E${+ee}` : `E${+ee}`} watched`, { label: "Undo", run: () => {
    if (was.progress) m.progress = was.progress; else delete m.progress;
    m.watching = was.watching; m.done = was.done;
    if (was.watchedAt !== undefined) m.watchedAt = was.watchedAt;
    save(); render();
  } });
}, true);
$("list").addEventListener("click", (e) => {
  const g = e.target.closest("[data-calgrp]");
  if (g && tab === "watching" && calView) { const k = g.dataset.calgrp; if (calOpen.has(k)) calOpen.delete(k); else calOpen.add(k); renderCalendar(true); return; }
  const r = e.target.closest("[data-calrow]");
  if (r && tab === "watching" && calView) openTinfo(items.find((x) => x.id === +r.dataset.calrow));
});


/* ---- Cast & crew: tap a name in the details popup to see that person's films and series, and add what you missed ----
   TMDB first (combined credits). Wikidata is asked as well and fills in titles TMDB does not list (it often knows more regional
   films); those rows have no poster. Only Wikidata titles that carry a TMDB id are shown, so every row can be added. */
const personCache = new Map();
let personKey = "", personState = null;
const SKIP_GENRES = new Set([10767, 10763]); // talk shows, news: appearances as oneself, not work
// What each job is called on TMDB, and which roles belong to which main department (Director is always allowed).
const PERSON_JOBS = {
  Composer: /^(Original Music Composer|Music|Composer|Music Director|Original Music|Score)$/i,
  Cinematographer: /^(Director of Photography|Cinematography)$/i,
  Editor: /^Editor$/i,
  Writer: /^(Writer|Screenplay|Story|Teleplay|Novel)$/i,
  Producer: /^(Producer|Executive Producer)$/i,
  Assistant: /^(Assistant Director|Associate Director|Second Unit Director|First Assistant Director)$/i, // v95: a director's early career (assistant / associate on other people's films)
};
const DEPT_ROLES = { Sound: ["Composer"], Camera: ["Cinematographer"], Editing: ["Editor"], Writing: ["Writer"], Production: ["Producer"], Directing: ["Writer", "Cinematographer", "Producer", "Editor", "Assistant"] }; // a director who also shot, wrote, produced or cut films (C. Prem Kumar: Pasanga) keeps those credits
const personRoleOk = (dept, role) => (DEPT_ROLES[dept] || []).includes(role);
// roles Wikidata may add for a department (it links some people to the wrong person, so a role that does not fit is dropped)
const WD_OK = { Acting: ["Actor", "Director"], Directing: ["Director", "Actor", "Writer", "Cinematographer", "Producer", "Editor"], Sound: ["Composer"], Camera: ["Cinematographer"], Editing: ["Editor"], Writing: ["Writer", "Director"], Production: ["Producer", "Director"] };
const DEPT_MAIN = { Acting: "Actor", Directing: "Director", Sound: "Composer", Camera: "Cinematographer", Editing: "Editor", Writing: "Writer", Production: "Producer" };
const GEM_MIN = 15; // fewer titles than this in the person's main job after TMDB and Wikidata: ask Gemini last
const PERSON_CHIPS = [["Actor", "Acting"], ["Director", "Directing"], ["Composer", "Music"], ["Cinematographer", "Cinematography"], ["Editor", "Editing"], ["Writer", "Writing"], ["Producer", "Producing"]];
function personCredits(r) {
  const map = new Map();
  const put = (c, role) => {
    if (!c || !c.id || (c.media_type !== "movie" && c.media_type !== "tv")) return;
    const date = c.release_date || c.first_air_date || "";
    const k = c.media_type + ":" + c.id;
    const cur = map.get(k) || { id: c.id, media_type: c.media_type, title: c.title || c.name || "", date, poster: c.poster_path || "", votes: c.vote_count || 0, roles: [], char: "", src: "tmdb", rating: c.vote_average || 0 };
    if (!cur.roles.includes(role)) cur.roles.push(role);
    if (role === "Actor" && c.character && !cur.char) cur.char = String(c.character).split("/")[0].trim();
    map.set(k, cur);
  };
  const cc = (r && r.combined_credits) || {};
  const dept = (r && r.known_for_department) || "";
  (cc.cast || []).forEach((c) => {
    if ((c.genre_ids || []).some((g) => SKIP_GENRES.has(g))) return;
    if (dept && dept !== "Acting" && c.media_type === "tv") return; // a composer / crew member on a TV special or concert is an appearance, not work
    if (/^(self|himself|herself|themselves)\b/i.test(c.character || "")) return;
    put(c, "Actor");
  });
  (cc.crew || []).forEach((c) => {
    if (c.job === "Director" || c.job === "Creator" || c.job === "Co-Director") { put(c, "Director"); return; }
    for (const [role, re] of Object.entries(PERSON_JOBS)) if (personRoleOk(dept, role) && re.test(c.job || "")) { put(c, role); return; }
  });
  return [...map.values()];
}
async function wikidataFilmography(tmdbPersonId) {
  const q = `SELECT ?filmLabel ?mv ?tv ?date ?role ?pd WHERE {
    ?p wdt:P4985 "${Number(tmdbPersonId)}" .
    { ?film wdt:P161 ?p . BIND("Actor" AS ?role) } UNION { ?film wdt:P57 ?p . BIND("Director" AS ?role) } UNION { ?film wdt:P86 ?p . BIND("Composer" AS ?role) } UNION { ?film wdt:P344 ?p . BIND("Cinematographer" AS ?role) } UNION { ?film wdt:P1040 ?p . BIND("Editor" AS ?role) } UNION { ?film wdt:P58 ?p . BIND("Writer" AS ?role) } UNION { ?film wdt:P162 ?p . BIND("Producer" AS ?role) }
    OPTIONAL { ?film wdt:P4947 ?mv } OPTIONAL { ?film wdt:P4983 ?tv } OPTIONAL { ?film wdt:P577 ?date }
    OPTIONAL { ?p schema:description ?pd . FILTER(LANG(?pd) = "en") }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } LIMIT 800`;
  const r = await fetch(WD_URL + "?format=json&query=" + encodeURIComponent(q), { headers: { Accept: "application/sparql-results+json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const rows = (await r.json()).results.bindings || [];
  const map = new Map();
  let desc = "";
  for (const b of rows) {
    if (!desc && b.pd && b.pd.value) desc = b.pd.value;
    const mv = b.mv && /^\d+$/.test(b.mv.value) ? b.mv.value : "", tv = b.tv && /^\d+$/.test(b.tv.value) ? b.tv.value : "";
    const title = b.filmLabel ? b.filmLabel.value : "";
    if ((!mv && !tv) || !title || /^Q\d+$/.test(title)) continue;
    const media_type = mv ? "movie" : "tv", id = +(mv || tv), k = media_type + ":" + id;
    const date = b.date && /^\d{4}/.test(b.date.value) ? b.date.value.slice(0, 10) : "";
    const cur = map.get(k) || { id, media_type, title, date, poster: "", votes: 0, roles: [], char: "", src: "wikidata", rating: 0 };
    if (!cur.roles.includes(b.role.value)) cur.roles.push(b.role.value);
    if (date && (!cur.date || date < cur.date)) cur.date = date;
    map.set(k, cur);
  }
  return { credits: [...map.values()], desc };
}
const PP_PAGE = 40;
function paintPerson() {
  const st = personState;
  if (!st) return;
  const f = st.filter;
  if (st.company) { // a production company: movies and series, All / Movies / Series, 10 at a time
    const both = st.src.movie.total > 0 && st.src.tv.total > 0;
    $("ppChips").innerHTML = both ? [["all", "All"], ["movie", "Movies"], ["tv", "Series"]].map(([k, l]) => `<button type="button" class="coll-chip${f === k ? " on" : ""}" data-ppf="${k}">${esc(l)}</button>`).join("") : "";
    const list = compFiltered(st), shown = list.slice(0, st.shown);
    $("ppList").innerHTML = shown.map(personRow).join("") + (st.shown < list.length || compMore(st) ? `<button type="button" class="coll-more pp-more" id="ppMore">${st.busy ? "Loading\u2026" : "Load more"}</button>` : "");
    $("ppStatus").textContent = shown.length || st.busy ? "" : "Nothing listed for this company.";
    return;
  }
  const today = todayIso();
  const isUp = (c) => !!c.date && c.date.slice(0, 10) > today; // not released yet (v95)
  const upN = st.credits.filter(isUp).length;
  const list = st.credits.filter((c) => f === "up" ? isUp(c) : !isUp(c) && (f === "all" || c.media_type === f)); // released titles in All / Movies / Series; unreleased only under Upcoming
  if (f === "up") list.sort((x, y) => x.date.localeCompare(y.date)); // soonest first
  else list.sort((x, y) => (y.votes || 0) - (x.votes || 0) || (y.date || "").localeCompare(x.date || "")); // most famous first (TMDB vote count)
  const chips = [["all", "All"], ["movie", "Movies"], ["tv", "Series"], ...(upN ? [["up", "Upcoming"]] : [])];
  $("ppChips").innerHTML = chips.map(([k, l]) => `<button type="button" class="coll-chip${f === k ? " on" : ""}" data-ppf="${k}">${esc(l)}</button>`).join("");
  const shown = list.slice(0, st.shown);
  $("ppList").innerHTML = shown.map(personRow).join("") + (list.length > shown.length ? `<button type="button" class="coll-more pp-more" id="ppMore">Show more (${list.length - shown.length})</button>` : "");
  $("ppStatus").textContent = list.length ? (st.loadingGem ? "Looking for more titles\u2026" : "") : (st.loadingGem ? "Looking for more titles\u2026" : st.loadingWd ? "Looking for more on Wikidata\u2026" : f === "up" ? "Nothing announced yet." : "Nothing listed for this filter.");
}
function personRow(c) {
  {
    const on = !!findPartItem({ id: c.id, media_type: c.media_type });
    const meta = [c.media_type === "tv" ? "Series" : "Movie", c.date.slice(0, 10) > todayIso() ? "Releases " + c.date.slice(0, 10) : c.date.slice(0, 4), c.roles.join(" & ") + (c.char ? " as " + c.char : "")].filter(Boolean).join(" \u00B7 ");
    const thumb = c.poster ? `<img src="${esc(IMG_T + "w92" + c.poster)}" alt="" loading="lazy" draggable="false">` : esc(c.date.slice(0, 4) || "\u2013");
    return `<div class="pp-row" data-k="${esc(c.media_type + ":" + c.id)}"><div class="pp-thumb">${thumb}</div><div class="pp-info"><p class="pp-t">${esc(c.title)}</p><p class="pp-m">${esc(meta)}${c.src === "wikidata" ? " \u00B7 from Wikidata" : c.src === "gemini" ? " \u00B7 from Gemini" : c.src === "imdb" ? " \u00B7 from IMDb" : ""}</p></div>${on ? `<span class="pp-on">On your list</span>` : `<button type="button" class="pp-add" data-ppadd="${esc(c.media_type + ":" + c.id)}">Add</button>`}</div>`;
  }
}
// upcoming first, then newest to oldest; undated last
function sortCredits(a) {
  return a.sort((x, y) => (x.date ? 0 : 1) - (y.date ? 0 : 1) || (y.date || "").localeCompare(x.date || "") || y.votes - x.votes);
}
async function openPerson(pid, fallbackName) {
  const id = Number(pid);
  if (!id || !canSearch()) return;
  const key = String(id);
  personKey = key;
  $("ppName").textContent = fallbackName || "";
  $("ppSub").textContent = ""; $("ppPhoto").classList.remove("pp-logo"); $("ppPhoto").innerHTML = ""; $("ppBio").hidden = true; $("ppBioMore").hidden = true;
  $("ppChips").innerHTML = ""; $("ppList").innerHTML = "";
  $("ppStatus").textContent = "Loading\u2026"; $("ppStatus").className = "panel-status";
  personState = null;
  $("person").hidden = false;
  $("ppClose").focus();
  try {
    let d = personCache.get(key);
    if (!d) {
      let r = null, stored = null;
      // v96: the server keeps every person in its own database (TMDB + Wikidata + Wikipedia) and refreshes it by itself: ask it first
      if (SIMILAR_URL) {
        try {
          const rr = await fetch(SIMILAR_URL + "?personfull=1&id=" + id, { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON }, signal: AbortSignal.timeout(25000) });
          if (rr.ok) { const j = await rr.json(); if (j && j.tmdb && j.tmdb.id) { r = j.tmdb; stored = j; } }
        } catch { /* server not reachable: the live lookups below are used */ }
      }
      if (!r) r = await tmdb("/person/" + id, { append_to_response: "combined_credits" });
      d = { name: r.name || fallbackName || "", bio: String(r.biography || "").trim(), photo: r.profile_path || "", born: r.birthday || "", died: r.deathday || "", place: String(r.place_of_birth || ""), dept: r.known_for_department || "", credits: personCredits(r), wd: stored && stored.wd && Array.isArray(stored.wd.credits) ? stored.wd : null, imdb: stored && Array.isArray(stored.imdb) ? stored.imdb : [] };
      if (stored && stored.bio && stored.bio.bio && stored.bio.bio.length >= d.bio.length * 1.3) { d.wbio = stored.bio.bio + "\n\nFrom Wikipedia"; d.wbioTried = true; }
      personCache.set(key, d);
    }
    if ($("person").hidden || personKey !== key) return;
    $("ppName").textContent = d.name;
    const bornTxt = (() => { if (!d.born) return ""; const t = new Date(d.born + "T00:00:00"); return "Born " + (isNaN(t) || d.born.length < 10 ? d.born.slice(0, 4) : t.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })); })();
    const placeTxt = d.place.split(",").map((x) => x.trim()).filter(Boolean).slice(-2).join(", ");
    $("ppSub").textContent = [d.dept, bornTxt, placeTxt, d.died ? "Died " + d.died.slice(0, 4) : ""].filter(Boolean).join(" \u00B7 ");
    $("ppPhoto").innerHTML = d.photo ? `<img src="${esc(IMG_T + "w185" + d.photo)}" alt="" draggable="false">` : "";
    const showBio = (t) => {
      $("ppBio").textContent = t; $("ppBio").hidden = !t; $("ppBio").className = "ti-plot"; $("ppBioMore").hidden = true;
      if (t) { const cut = $("ppBio").scrollHeight > $("ppBio").clientHeight + 1; $("ppBio").classList.toggle("more", cut); $("ppBioMore").hidden = !cut; }
    };
    showBio(d.wbio || d.bio);
    // TMDB's biography is often a couple of lines: ask the server for the fuller Wikipedia text (saved 30 days for everyone) and use it when it says more
    if (SIMILAR_URL && !d.wbio && d.bio.length < 700 && !d.wbioTried) {
      d.wbioTried = true;
      fetch(SIMILAR_URL + "?personbio=1&id=" + id, { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON }, signal: AbortSignal.timeout(15000) })
        .then((rr) => rr.ok ? rr.json() : null)
        .then((j) => {
          if (!j || !j.bio || j.bio.length < d.bio.length * 1.3) { if (!j || j.error) d.wbioTried = false; return; } // nothing better (a failed call is tried again next time)
          d.wbio = j.bio + "\n\nFrom Wikipedia";
          if (!$("person").hidden && personKey === key) showBio(d.wbio);
        }).catch(() => { d.wbioTried = false; });
    }
    personState = { credits: sortCredits(d.credits.slice()), filter: "all", shown: PP_PAGE, loadingWd: !d.wd };
    paintPerson();
    // Wikidata: titles TMDB does not list (and a one-line description when TMDB has no bio)
    let wd = d.wd;
    if (!wd) {
      try { wd = d.wd = await wikidataFilmography(id); } catch { wd = { credits: [], desc: "" }; } // a failed lookup is not remembered, so the next open tries again
    }
    if ($("person").hidden || personKey !== key) return;
    const have = new Set(d.credits.map((c) => c.media_type + ":" + c.id));
    const okR = WD_OK[d.dept]; // only the roles that fit this person's department
    const extra = wd.credits.concat((d.imdb || []).filter((c) => !wd.credits.some((w) => w.media_type === c.media_type && w.id === c.id))).map((c) => (okR ? { ...c, roles: c.roles.filter((x) => okR.includes(x)) } : c)).filter((c) => c.roles.length && !have.has(c.media_type + ":" + c.id));
    if (!d.bio && !d.wbio && wd.desc) showBio(wd.desc.charAt(0).toUpperCase() + wd.desc.slice(1) + " (Wikidata)");
    personState.credits = sortCredits(d.credits.concat(extra));
    personState.loadingWd = false;
    paintPerson();
    // Last fallback: Gemini names more titles (the server checks each one on TMDB). Only when the list is still short.
    const mainRole = DEPT_MAIN[d.dept] || "Actor";
    if (SIMILAR_URL && personState.credits.filter((c) => c.roles.includes(mainRole)).length < GEM_MIN) {
      let g = d.gem;
      if (!g) {
        personState.loadingGem = true; paintPerson();
        try {
          const rr = await fetch(SIMILAR_URL + "?person=1&id=" + id, { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON }, signal: AbortSignal.timeout(60000) });
          if (rr.ok) { const j = await rr.json(); if (j && !j.error && Array.isArray(j.credits)) g = d.gem = j.credits; }
        } catch { /* optional: nothing is added */ }
      }
      if ($("person").hidden || personKey !== key || !personState) return;
      personState.loadingGem = false;
      if (g && g.length) {
        const seen = new Set(personState.credits.map((c) => c.media_type + ":" + c.id));
        personState.credits = sortCredits(personState.credits.concat(g.filter((c) => !seen.has(c.media_type + ":" + c.id))));
      }
      paintPerson();
    }
  } catch {
    if ($("person").hidden || personKey !== key) return;
    $("ppStatus").textContent = "Could not load this page. Check your internet connection.";
    $("ppStatus").className = "panel-status err";
  }
}
// Production company page: its movies and series, most popular first, 10 at a time. Each kind is asked from TMDB one page at a time
// (discover/movie and discover/tv), and only the kinds the current filter needs are asked for more.
const COMP_KINDS = { all: ["movie", "tv"], movie: ["movie"], tv: ["tv"] };
const compFiltered = (st) => st.credits.filter((c) => st.filter === "all" || c.media_type === st.filter);
const compMore = (st) => COMP_KINDS[st.filter].some((k) => st.src[k].page < st.src[k].pages);
async function companyLoadPage(st) {
  st.busy = true;
  try {
    const kinds = COMP_KINDS[st.filter].filter((k) => st.src[k].page < st.src[k].pages);
    const res = await Promise.allSettled(kinds.map((k) => tmdb("/discover/" + k, { with_companies: st.cid, sort_by: "popularity.desc", page: st.src[k].page + 1 })));
    let okAny = !kinds.length;
    res.forEach((x, i) => {
      const k = kinds[i], src = st.src[k];
      if (x.status !== "fulfilled") { if (k === "tv" && src.page === 0) { src.page = src.pages = 1; src.total = 0; } return; } // an older server without discover/tv: movies still work
      okAny = true;
      const r = x.value;
      (r.results || []).forEach((m) => {
        if (!m || !m.id || st.credits.some((c) => c.id === m.id && c.media_type === k)) return;
        st.credits.push({ id: m.id, media_type: k, title: (k === "tv" ? m.name : m.title) || "", date: (k === "tv" ? m.first_air_date : m.release_date) || "", poster: m.poster_path || "", votes: m.vote_count || 0, pop: m.popularity || 0, roles: [], char: "", src: "tmdb", rating: m.vote_average || 0 });
      });
      src.page += 1; src.pages = Math.min(r.total_pages || 1, 500); src.total = r.total_results || 0;
    });
    st.credits.sort((a, b) => b.pop - a.pop);
    return okAny;
  } catch { return false; } finally { st.busy = false; }
}
const companyCache = new Map();
const companyInitials = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
async function companyInfo(id) {
  if (companyCache.has(id)) return companyCache.get(id);
  try {
    const r = await tmdb("/company/" + id);
    const info = { logo: r.logo_path || "", country: r.origin_country || "", hq: r.headquarters || "", desc: String(r.description || "").trim() };
    companyCache.set(id, info);
    return info;
  } catch { return null; } // not remembered, so the next open tries again
}
async function openCompany(cid, name) {
  const id = Number(cid);
  if (!id || !canSearch()) return;
  const key = "c" + id;
  personKey = key;
  $("ppName").textContent = name || ""; $("ppSub").textContent = "Production company"; $("ppPhoto").innerHTML = ""; $("ppBio").hidden = true; $("ppBioMore").hidden = true;
  $("ppChips").innerHTML = ""; $("ppList").innerHTML = "";
  $("ppStatus").textContent = "Loading\u2026"; $("ppStatus").className = "panel-status";
  const st = personState = { company: true, cid: id, credits: [], shown: 10, busy: false, filter: "all", src: { movie: { page: 0, pages: 1, total: 0 }, tv: { page: 0, pages: 1, total: 0 } } };
  $("person").hidden = false;
  $("ppClose").focus();
  // logo, country and description come from TMDB's company record, fetched alongside the movie list; studios without a logo get a letter tile
  const paintInfo = (info) => {
    if ($("person").hidden || personKey !== key) return;
    const ph = $("ppPhoto");
    ph.classList.add("pp-logo");
    ph.innerHTML = info && info.logo ? `<img src="${esc(IMG_T + "w300" + info.logo)}" alt="" draggable="false">` : `<span class="pp-mono">${esc(companyInitials(name))}</span>`;
    if (info) {
      $("ppSub").textContent = ["Production company", info.country, info.hq].filter(Boolean).join(" \u00B7 ");
      if (info.desc) { $("ppBio").textContent = info.desc; $("ppBio").hidden = false; $("ppBio").className = "ti-plot"; }
    }
  };
  paintInfo(companyCache.get(id) || null);
  companyInfo(id).then(paintInfo);
  const ok = await companyLoadPage(st);
  if ($("person").hidden || personKey !== key) return;
  if (!ok) { $("ppStatus").textContent = "Could not load this page. Check your internet connection."; $("ppStatus").className = "panel-status err"; return; }
  paintPerson();
}
async function companyMore() {
  const st = personState;
  if (!st || !st.company || st.busy) return;
  const key = personKey;
  st.shown += 10;
  if (compFiltered(st).length < st.shown && compMore(st)) {
    paintPerson();
    const ok = await companyLoadPage(st);
    if (personKey !== key) return;
    if (!ok) { st.shown -= 10; paintPerson(); $("ppStatus").textContent = "Could not load more. Try again."; $("ppStatus").className = "panel-status err"; return; }
  }
  paintPerson();
  $("ppStatus").className = "panel-status";
}
// a chip on a company page: show that kind, asking TMDB for it when fewer than 10 are loaded
async function companyFilter(f) {
  const st = personState;
  if (!st || !st.company || st.filter === f) return;
  const key = personKey;
  st.filter = f; st.shown = 10;
  paintPerson();
  if (compFiltered(st).length < st.shown && compMore(st) && !st.busy) {
    await companyLoadPage(st);
    if (personKey !== key) return;
    paintPerson();
  }
}
function closePerson() { $("person").hidden = true; personKey = ""; personState = null; }
function addFromPerson(k) {
  const st = personState;
  const c = st && st.credits.find((x) => x.media_type + ":" + x.id === k);
  if (!c || findPartItem({ id: c.id, media_type: c.media_type })) return;
  const item = {
    id: Date.now(), title: c.title || "Untitled", stars: 3, note: "", done: false, year: c.date.slice(0, 4), type: c.media_type === "tv" ? "tv" : "movie",
    rating: c.rating ? Math.round(c.rating * 10) / 10 : null, poster: c.poster ? IMG_SAVED + c.poster : "", posterPath: c.poster || "", tmdbId: c.id, tmdbTitle: c.title || "",
  };
  insertNew(item);
  save();
  forgetTitleKeys(item);
  warmRelated(item.tmdbId, item.type);
  render();
  paintPerson();
  toast(`Added \u201C${item.title}\u201D to To watch`);
}
$("ppClose").addEventListener("click", closePerson);
$("person").addEventListener("click", (e) => { if (e.target === $("person")) closePerson(); });
$("tiRows").addEventListener("click", (e) => {
  const b = e.target.closest(".ti-person");
  if (!b) return;
  if (b.dataset.cid) openCompany(b.dataset.cid, b.textContent);
  else openPerson(b.dataset.pid, b.textContent);
});
$("ppChips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ppf]");
  if (!b || !personState) return;
  if (personState.company) { companyFilter(b.dataset.ppf); return; }
  personState.filter = b.dataset.ppf; personState.shown = PP_PAGE;
  paintPerson();
});
$("ppList").addEventListener("click", (e) => {
  const a = e.target.closest("[data-ppadd]");
  if (a) { addFromPerson(a.dataset.ppadd); return; }
  if (e.target.closest("#ppMore") && personState) {
    if (personState.company) companyMore();
    else { personState.shown += PP_PAGE; paintPerson(); }
  }
});
$("ppBio").addEventListener("click", () => { if ($("ppBio").classList.contains("more") || $("ppBio").classList.contains("open")) { const o = $("ppBio").classList.toggle("open"); $("ppBioMore").textContent = o ? "\u2212" : "+"; $("ppBioMore").setAttribute("aria-expanded", o ? "true" : "false"); } });
$("ppBioMore").addEventListener("click", () => $("ppBio").click());

$("tiClose").addEventListener("click", closeTinfo);
$("tiShare").addEventListener("click", () => { if (tinfoItem) shareTitle(tinfoItem); });
document.addEventListener("pointerdown", (e) => {
  if (tab !== "watch" && tab !== "done") return;
  const row = e.target.closest && e.target.closest("#list [data-row]");
  if (row && !e.target.closest("button,a,input,select,textarea")) prefetchTinfo(items.find((x) => x.id === +row.dataset.row));
}, { passive: true });
// The same round + as after the cast: + opens the whole summary, − closes it again
function setPlotBtn(open) {
  const b = $("tiPlotMore");
  b.textContent = open ? "\u2212" : "+";
  b.setAttribute("aria-expanded", open ? "true" : "false");
  b.setAttribute("aria-label", open ? "Show less" : "Read more");
}
const togglePlot = () => { setPlotBtn($("tiPlot").classList.toggle("open")); };
$("tiPlot").addEventListener("click", togglePlot);
$("tiPlotMore").addEventListener("click", togglePlot);
$("tiRows").addEventListener("click", (e) => { // the + after the seasons shows the episodes of every season
  const sb = e.target.closest("#tiSeasonMore"), sr = $("tiSeasonRest");
  if (!sb || !sr) return;
  const open = sr.hidden;
  sr.hidden = !open;
  sb.textContent = open ? "\u2212" : "+";
  sb.setAttribute("aria-expanded", open ? "true" : "false");
  sb.setAttribute("aria-label", open ? "Hide episodes per season" : "Show episodes per season");
});
$("tiRows").addEventListener("click", (e) => { // the + after the cast shows the rest of the names and turns into a − that hides them again
  const b = e.target.closest("#tiCastMore"), rest = $("tiCastRest");
  if (!b || !rest) return;
  const open = rest.hidden; // hidden now = about to open
  rest.hidden = !open;
  b.textContent = open ? "\u2212" : "+";
  b.setAttribute("aria-expanded", open ? "true" : "false");
  b.setAttribute("aria-label", open ? "Show less cast" : "Show more cast");
});
$("tinfo").addEventListener("click", (e) => { if (e.target === $("tinfo")) closeTinfo(); }); // tap outside the card

$("collClose").addEventListener("click", closeColl);
$("collAdd").addEventListener("click", addCollectionParts);
$("coll").addEventListener("change", updateCollAdd);
let repTimer = null;
$("coll").addEventListener("input", (e) => {
  if (e.target.id !== "repQ" || !collState) return;
  const d = collState;
  d.reportQ = e.target.value;
  clearTimeout(repTimer);
  const q = d.reportQ.trim();
  if (q.length < 2) { d.reportRes = []; $("repRes").innerHTML = repResHtml(d); return; }
  repTimer = setTimeout(async () => {
    try {
      const r = await searchMulti(q);
      if (collState !== d || d.reportQ.trim() !== q) return; // the panel or the text changed meanwhile
      const have = new Set([...(d.parts || []).map((p) => "movie:" + p.id), ...(d.related || []).map((x) => x.media_type + ":" + x.id)]);
      d.reportRes = (r.results || []).filter((x) => (x.media_type === "movie" || x.media_type === "tv") && (x.release_date || x.first_air_date) && !have.has(x.media_type + ":" + x.id)).slice(0, 6);
      d.reportMsg = d.reportRes.length ? "" : "Nothing found, or it is already in the list.";
      if ($("repRes")) $("repRes").innerHTML = repResHtml(d);
    } catch { /* search failed: keep what is shown */ }
  }, 350);
});
$("coll").addEventListener("click", (e) => {
  if (e.target.closest("#collMore") && collState) loadRelated(collState);
  if (e.target.closest("#collRefresh") && collState) { refreshRelated(collState); return; }
  if (e.target.closest("#collReport") && collState) {
    collState.reportOpen = true;
    renderRelated();
    const q = $("repQ"); if (q) q.focus(); // the person just tapped "Report": the keyboard is wanted here
    return;
  }
  const rep = e.target.closest("[data-rep]");
  if (rep && collState) {
    const d = collState;
    const [type, id] = rep.dataset.rep.split(":");
    d.reportSent = [...(d.reportSent || []), rep.dataset.rep]; // shown as reported at once; undone if sending fails
    d.reportMsg = "Thanks. It is added to the list once enough people report it.";
    $("repRes").innerHTML = repResHtml(d);
    reportRelated(d, type, +id).catch((err) => {
      d.reportSent = (d.reportSent || []).filter((k) => k !== rep.dataset.rep);
      d.reportMsg = err && err.code === "not_listable" ? "That one can't be listed (a short, a documentary, an extra, or no release date). Pick another."
        : err && err.code === "not_saved" ? "The report could not be saved on the server."
        : "Could not send the report. Try again.";
      if (collState === d && $("repRes")) $("repRes").innerHTML = repResHtml(d);
    });
    return;
  }
  const chip = e.target.closest("[data-relf]");
  if (chip && collState) { collState.relFilter = chip.dataset.relf; renderRelated(); }
});

/* ---- header sync button ---- */
const SYNC_ICON = `<svg class="ico" viewBox="1.5 1.5 13 13" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 0 1-9.6 3.7"/><path d="M2.5 8a5.5 5.5 0 0 1 9.6-3.7"/><path d="M12.5 1.5v3h-3"/><path d="M3.5 14.5v-3h3"/></svg>`;
const CLOUD_ICON = `<svg class="ico" viewBox="2 2 20 20" aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;

function updateSyncBtn() {
  const b = $("syncBtn");
  if (!window.Sync || !Sync.configured()) { b.hidden = true; return; }
  b.hidden = false;
  const signedIn = !!Sync.getSession();
  b.classList.toggle("spin", syncState.kind === "syncing");
  b.classList.toggle("err", signedIn && (syncState.kind === "error" || syncState.kind === "offline"));
  b.classList.toggle("off", signedIn && !Sync.getMeta().enabled);
  b.classList.toggle("txt", signedIn);
  const icon = signedIn ? (syncState.kind === "syncing" ? "Syncing…" : "Sync now") : CLOUD_ICON;
  if (b.dataset.icon !== icon) { if (signedIn) b.textContent = icon; else b.innerHTML = icon; b.dataset.icon = icon; }
  let tip = "Sign in to back up & sync";
  if (signedIn) {
    if (!Sync.getMeta().enabled) tip = "Sync is off. Click to turn it on";
    else if (syncState.kind === "syncing") tip = "Syncing…";
    else if (syncState.kind === "offline") tip = "Offline. Click to try again";
    else if (syncState.kind === "error") tip = "Could not sync. Click to try again";
    else tip = "Sync now" + (syncState.at ? " · synced " + ago(syncState.at) : "");
  }
  b.title = tip;
  b.setAttribute("aria-label", tip);
  if (b.dataset.signed !== String(signedIn)) { // the install card's wording depends on being signed in
    b.dataset.signed = String(signedIn);
    try { refreshInstallCard(); } catch {}
    try { refreshWarnCard(); } catch {}
  }
}

$("syncBtn").addEventListener("click", async () => {
  if (!Sync.getSession()) return openAccount();
  if (!Sync.getMeta().enabled) return afterLogin();
  if (syncing) return;
  await runSync();
  if (syncState.kind === "ok") toast("Synced.");
  else if (syncState.kind === "offline") toast("No internet connection. Will sync when you are back online.");
  else if (syncState.kind === "error") toast("Could not sync. Will try again soon.");
});
setInterval(updateSyncBtn, 30000);

/* ---- sign in / out ---- */
let accMode = "in";
// The pause after wrong tries survives closing the app. (The server also limits attempts.)
const LOCK_KEY = "watchlist-authlock-v1";
let authFails = 0;
let authLockUntil = 0;
try {
  const o = JSON.parse(localStorage.getItem(LOCK_KEY));
  authFails = Math.max(0, +o.fails || 0);
  authLockUntil = Math.max(0, +o.until || 0);
} catch {}
function saveLock() { try { localStorage.setItem(LOCK_KEY, JSON.stringify({ fails: authFails, until: authLockUntil })); } catch {} }

function setAccStatus(text, kind = "") {
  const s = $("accStatus");
  s.textContent = text;
  s.className = "panel-status " + kind;
}

function renderRules() {
  const list = $("accRules");
  if (accMode !== "up") { list.hidden = true; return; }
  const rules = Sync.passwordRules($("accPass").value, Sync.normEmail($("accUser").value), $("accPin").value);
  list.hidden = false;
  list.innerHTML = rules.map((r) => `<li class="${r.ok ? "ok" : ""}">${esc(r.text)}</li>`).join("");
}

function setAccMode(mode) {
  accMode = mode;
  const up = mode === "up";
  document.querySelectorAll("#account [data-acc]").forEach((b) => b.classList.toggle("on", b.dataset.acc === mode));
  $("accPass2Wrap").hidden = !up;
  $("accPin2Wrap").hidden = !up;
  $("accAckWrap").hidden = !up;
  $("accPass").setAttribute("autocomplete", up ? "new-password" : "current-password");
  $("accGo").textContent = up ? "Create account" : "Sign in";
  $("accPass").value = ""; $("accPass2").value = ""; $("accPin").value = ""; $("accPin2").value = "";
  $("accAck").checked = false;
  setAccStatus("");
  renderRules();
}

function openAccount() {
  try { refreshWarnCard(); } catch {}
  $("accUser").value = "";
  setAccMode("in");
  $("account").hidden = false;
  focusSoft($("accUser"));
}
function closeAccount() {
  $("account").hidden = true;
  ["accPass", "accPass2", "accPin", "accPin2"].forEach((id) => { $(id).value = ""; });
  focusSearch();
}

async function doAuth() {
  const wait = Math.ceil((authLockUntil - Date.now()) / 1000);
  if (wait > 0) { setAccStatus(`Too many attempts. Wait ${wait} seconds.`, "err"); return; }

  const email = Sync.normEmail($("accUser").value);
  const pass = $("accPass").value;
  const pin = $("accPin").value;
  const create = accMode === "up";

  const userErr = Sync.checkEmail(email);
  if (userErr) { setAccStatus(userErr, "err"); return; }
  if (create) {
    const bad = Sync.passwordRules(pass, email, pin).find((r) => !r.ok);
    if (bad) { setAccStatus("Password: " + bad.text.charAt(0).toLowerCase() + bad.text.slice(1) + ".", "err"); return; }
    const pinErr = Sync.checkPin(pin);
    if (pinErr) { setAccStatus(pinErr, "err"); return; }
    if (pass !== $("accPass2").value) { setAccStatus("The two passwords do not match.", "err"); return; }
    if (pin !== $("accPin2").value) { setAccStatus("The two PINs do not match.", "err"); return; }
    if (!$("accAck").checked) { setAccStatus("Please confirm that you saved your details.", "err"); return; }
  } else if (!pass || !/^\d{6}$/.test(pin)) {
    setAccStatus("Enter your password and your 6-digit PIN.", "err");
    return;
  }

  $("accGo").disabled = true;
  setAccStatus(create ? "Creating account…" : "Signing in…");
  try {
    if (create) await Sync.signUp(email, pass, pin);
    else await Sync.signIn(email, pass, pin);
  } catch (e) {
    $("accGo").disabled = false;
    if (e.badLogin) {
      authFails++;
      // A short, growing pause after 5 wrong tries. The server limits attempts as well.
      if (authFails >= 5) authLockUntil = Date.now() + Math.min(600, 30 * 2 ** (authFails - 5)) * 1000;
      saveLock();
    }
    if (e.taken) { setAccStatus(e.message, "err"); $("accUser").focus(); return; }
    setAccStatus(e.offline ? "No internet connection." : e.message || "Could not sign in.", "err");
    return;
  }
  $("accGo").disabled = false;
  authFails = 0; authLockUntil = 0; saveLock();
  closeAccount();
  afterLogin();
}

$("accGo").addEventListener("click", doAuth);
$("accCancel").addEventListener("click", closeAccount);
["accUser", "accPass", "accPin"].forEach((id) => $(id).addEventListener("input", renderRules));
["accUser", "accPass", "accPass2", "accPin", "accPin2"].forEach((id) =>
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") doAuth(); }));
// The PIN fields only take digits.
["accPin", "accPin2"].forEach((id) =>
  $(id).addEventListener("input", () => { $(id).value = $(id).value.replace(/\D/g, "").slice(0, 6); }));
document.querySelectorAll("#account [data-acc]").forEach((b) => b.addEventListener("click", () => setAccMode(b.dataset.acc)));

// Signed in. First this device takes one of the account's 3 places, then the list is compared.
async function afterLogin() {
  if (!Sync.getSession()) return;
  if (!(await ensureDevice())) return;
  await continueLogin();
}

async function ensureDevice() {
  try {
    const r = await Sync.registerDevice();
    if (r && r.ok) return true;
    if (r && r.reason === "limit") { showDevices("limit", r.devices || []); return false; }
    throw new Error("Unexpected answer");
  } catch (e) {
    toast(e.notSetUp ? "The device limit is not set up on the server yet. Run the updated supabase/setup.sql."
      : e.offline ? "No internet connection. Try signing in again later."
      : "Could not register this device. Try again.");
    await Sync.signOut({ release: false });
    updateSyncBtn();
    return false;
  }
}

async function continueLogin() {
  const sess = Sync.getSession();
  if (!sess) return;
  let meta = Sync.getMeta();
  const other = !!meta.userId && meta.userId !== sess.user.id; // the list here was last used with another account
  if (meta.userId !== sess.user.id) meta = Object.assign(Sync.defaultMeta(), { userId: sess.user.id }); // a different account
  meta.enabled = false;
  meta.cursor = ""; // always compare everything when sync is first turned on
  Sync.setMeta(meta);
  try {
    const rows = await Sync.fetchRows("");
    const prev = Sync.merge({ items, tombs: meta.tombs, dirty: meta.dirty, orderTs: meta.orderTs, orderDirty: meta.orderDirty }, rows, true);
    const st = prev.stats;
    const here = items.length;
    if (other && !here) return enableSync();
    if (!other && !st.pulled && !st.pushed && !st.updated && !st.removed) return enableSync();
    const lines = [];
    if (st.pushed) lines.push(`${st.pushed} ${st.pushed === 1 ? "title" : "titles"} from this device will be added to your account`);
    if (st.pulled) lines.push(`${st.pulled} ${st.pulled === 1 ? "title" : "titles"} from your account will be added here`);
    if (st.updated || st.removed) lines.push("newer changes from your account will be applied here");
    const base = `This device has ${here} ${here === 1 ? "title" : "titles"}. ` + lines.join(", and ") + ".";
    $("consentText").textContent = other ? "The list on this device was last used with a different account. " + base : base;
    $("consentNote").textContent = other
      ? "Sync adds this device's titles to this account. Start fresh clears the list on this device only and loads this account's list instead. Your other account is not changed."
      : "Nothing is deleted. Titles on both sides are combined, and after that changes sync automatically until you sign out.";
    $("consentFresh").hidden = !other;
    $("consent").hidden = false;
    $("consentYes").focus();
  } catch (e) {
    toast(e.offline ? "No internet connection. Try signing in again later." : "Could not reach your account. Try again.");
    await Sync.signOut();
  }
}

// Clear this device's list and load the signed-in account's list instead.
function startFresh() {
  items = [];
  resetSigs();
  saveQuiet();
  const meta = Sync.getMeta();
  meta.dirty = []; meta.tombs = {}; meta.orderDirty = false; meta.orderTs = 0;
  Sync.setMeta(meta);
  render();
  enableSync();
}

function enableSync() {
  const meta = Sync.getMeta();
  meta.enabled = true;
  meta.cursor = "";
  Sync.setMeta(meta);
  $("consent").hidden = true;
  updateSyncBtn();
  runSync();
}
async function declineSync() {
  $("consent").hidden = true;
  Sync.setMeta(Sync.defaultMeta());
  await Sync.signOut();
  updateSyncBtn();
}
$("consentYes").addEventListener("click", enableSync);
$("consentNo").addEventListener("click", declineSync);
$("consentFresh").addEventListener("click", startFresh);

async function doLogout() {
  clearTimeout(syncTimer);
  const meta = Sync.getMeta();
  meta.enabled = false; // stop syncing; deletions made now are still remembered for the next sign-in
  Sync.setMeta(meta);
  await Sync.signOut();
  syncState = { kind: "", at: 0 }; updateSyncBtn();
  toast(fileStore ? "Signed out. Your list stays on this device." : "Signed out. Your list stays on this device but is no longer backed up.");
}

/* ---------------- Devices (at most 3 per account) ---------------- */
let devMode = "list"; // "list" = viewing from the menu, "limit" = this device could not sign in because 3 are in use

function setDevStatus(text, kind = "") {
  const el = $("devStatus");
  el.textContent = text;
  el.className = "panel-status " + kind;
}

function renderDevices(list) {
  const max = Sync.DEVICE_MAX;
  $("devTitle").textContent = devMode === "limit" ? "Device limit reached" : "Your devices";
  $("devText").textContent = devMode === "limit"
    ? `This account is already signed in on ${max} devices. Remove one to sign in on this device.`
    : `${list.length} of ${max} devices in use. A removed device stops syncing and must sign in again.`;
  $("devClose").textContent = devMode === "limit" ? "Cancel" : "Close";
  $("devList").innerHTML = list.map((d) => {
    const t = new Date(d.last_seen).getTime();
    const seen = Number.isFinite(t) ? "Last used " + ago(t) : "";
    return `<div class="dev">
      <div class="dev-body"><b>${esc(d.name || "Device")}</b>${d.current ? `<span class="badge ok">This device</span>` : ""}${seen ? `<small>${esc(seen)}</small>` : ""}</div>
      ${d.current ? "" : `<button type="button" data-dev-remove="${esc(d.id)}">Remove</button>`}
    </div>`;
  }).join("");
}

function showDevices(mode, list) {
  devMode = mode;
  setDevStatus("");
  renderDevices(list);
  $("devices").hidden = false;
  $("devClose").focus();
}

async function openDevices() {
  devMode = "list";
  $("devList").textContent = "";
  $("devTitle").textContent = "Your devices";
  $("devText").textContent = "";
  $("devClose").textContent = "Close";
  setDevStatus("Loading…");
  $("devices").hidden = false;
  try {
    showDevices("list", await Sync.listDevices());
  } catch (e) {
    setDevStatus(e.offline ? "No internet connection." : "Could not load your devices.", "err");
  }
}

async function closeDevices() {
  $("devices").hidden = true;
  if (devMode === "limit") { // gave up: this device stays signed out
    devMode = "list";
    await Sync.signOut({ release: false });
    updateSyncBtn();
  }
  focusSearch();
}

$("devClose").addEventListener("click", closeDevices);
$("devList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-dev-remove]");
  if (!b) return;
  b.disabled = true;
  setDevStatus("Removing…");
  try {
    await Sync.removeDevice(b.dataset.devRemove);
    if (devMode === "limit") {
      const r = await Sync.registerDevice();
      if (r && r.ok) { devMode = "list"; $("devices").hidden = true; await continueLogin(); return; }
      renderDevices((r && r.devices) || []);
    } else {
      renderDevices(await Sync.listDevices());
    }
    setDevStatus("");
  } catch (err) {
    b.disabled = false;
    setDevStatus(err.offline ? "No internet connection." : "Could not remove that device. Try again.", "err");
  }
});

/* ---------------- About / developer ---------------- */
function openAbout() { $("about").hidden = false; $("aboutClose").focus(); }
function closeAbout() { $("about").hidden = true; focusSearch(); }
$("aboutClose").addEventListener("click", closeAbout);
$("about").addEventListener("click", (e) => { if (e.target.id === "about") closeAbout(); });
document.querySelectorAll("#about a.link").forEach((a) => {
  a.addEventListener("click", (e) => {
    if (window.api && window.api.openExternal) { e.preventDefault(); window.api.openExternal(a.href); }
  });
});

/* ---------------- "your list is only on this device" warning (web / phone, not signed in) ---------------- */
function localOnlyWarning() {
  if (fileStore || !window.Sync || !Sync.configured() || Sync.getSession()) return "";
  const iosBrowser = !!(window.__isIOS && !window.__isStandalone && !window.Capacitor);
  if (iosBrowser) return "Your list is saved only in Safari on this iPhone. Safari can delete it after about 7 days without a visit, or when website data is cleared. It cannot be recovered without a backup.";
  if (window.Capacitor) return "Your list is saved only inside this app. Clearing the app's storage or uninstalling it deletes the list for good, unless you have a backup.";
  return "Your list is saved only in this browser. Clearing browsing data or site data deletes it for good, unless you have a backup.";
}
function warnVisible() {
  let hidden = false;
  try { hidden = Date.now() < Number(localStorage.getItem("watchlist-warn-hide-v1") || 0); } catch {}
  return !!localOnlyWarning() && !hidden;
}
function refreshWarnCard() {
  const box = $("warnCard"), acc = $("accWarn");
  const msg = localOnlyWarning();
  if (acc) { acc.textContent = msg ? msg + " Sign in or create an account to keep a copy in the cloud." : ""; acc.hidden = !msg; }
  if (!box) return;
  let hidden = false;
  try { hidden = Date.now() < Number(localStorage.getItem("watchlist-warn-hide-v1") || 0); } catch {}
  if (!msg || hidden) { box.hidden = true; return; }
  box.innerHTML = `<span class="ic-text"><strong>Your list can be lost</strong>${esc(msg)}</span>` +
    `<button type="button" class="ic-go" data-wc="go">Back up</button>` +
    `<button type="button" class="ic-x" data-wc="x" aria-label="Dismiss">×</button>`;
  box.hidden = false;
}
$("warnCard").addEventListener("click", (e) => {
  const b = e.target.closest("[data-wc]");
  if (!b) return;
  if (b.dataset.wc === "x") { try { localStorage.setItem("watchlist-warn-hide-v1", String(Date.now() + 3 * 864e5)); } catch {} refreshWarnCard(); refreshInstallCard(); return; }
  openAccount();
});
refreshWarnCard();

/* ---------------- install card, Home Screen guide, list transfer (web / phone) ---------------- */
const INSTALL_HIDE_KEY = "watchlist-install-hide-v1";
function installHidden() { try { return Date.now() < Number(localStorage.getItem(INSTALL_HIDE_KEY) || 0); } catch { return false; } }
function hideInstall(days) { try { localStorage.setItem(INSTALL_HIDE_KEY, String(Date.now() + days * 864e5)); } catch {} }

function refreshInstallCard() {
  const box = $("installCard");
  if (!box) return;
  const ios = !!(window.__showIOSInstall && window.__showIOSInstall());
  const can = !!(window.__canInstall && window.__canInstall());
  // One notice at a time on a small screen: the "your list can be lost" warning goes first, the install offer follows once it is dismissed.
  if (installHidden() || !(ios || can) || warnVisible()) { box.hidden = true; return; }
  const signed = !!(window.Sync && Sync.getSession());
  const text = ios
    ? (signed ? "Add it to your Home Screen, then sign in there to get your list."
              : "Add it to your Home Screen. Sign in to Back up &amp; sync first so your list comes with you.")
    : "Add it to your home screen or desktop.";
  box.innerHTML = `<span class="ic-text"><strong>Install Watchlist</strong>${text}</span>` +
    `<button type="button" class="ic-go" data-ic="go">${ios ? "How" : "Install"}</button>` +
    `<button type="button" class="ic-x" data-ic="x" aria-label="Dismiss">×</button>`;
  box.hidden = false;
}
$("installCard").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ic]");
  if (!b) return;
  if (b.dataset.ic === "x") { hideInstall(14); refreshInstallCard(); return; }
  if (window.__showIOSInstall && window.__showIOSInstall()) openHowto();
  else if (window.__installApp) window.__installApp();
});
window.__onInstallChange = () => { refreshInstallCard(); refreshWarnCard(); }; // pwa.js calls this when it knows what the browser can do
refreshInstallCard();

const HOWTO_STEPS = `<li>Tap the <b>Share</b> button <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg> in Safari's toolbar.</li>` +
  `<li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>, then open Watchlist from your Home Screen.</li>`;
const HOWTO_INAPP = `<li>This page is open inside another app. Tap its <b>⋯</b> menu (or the compass icon) and choose <b>Open in Safari</b>.</li><li>Then open this guide again from Safari.</li>`;
function openHowto() {
  const signed = !!(window.Sync && Sync.getSession());
  $("howtoSteps").innerHTML = window.__iosInApp ? HOWTO_INAPP : HOWTO_STEPS;
  $("howtoNote").innerHTML = signed
    ? "<b>You are signed in.</b> After adding it, open the Home Screen app and sign in there: your list appears. The app keeps its own storage, separate from Safari."
    : "<b>Do this first:</b> the Home Screen app keeps its own storage, so it starts empty. Sign in to <b>Back up &amp; sync</b> here, then sign in again in the app and your list appears. No account? Use <b>Move my list</b>.";
  $("howtoSync").hidden = signed;
  $("howto").hidden = false;
  $("howtoClose").focus();
}
function closeHowto() { $("howto").hidden = true; focusSearch(); }
$("howtoClose").addEventListener("click", closeHowto);
$("howto").addEventListener("click", (e) => { if (e.target.id === "howto") closeHowto(); });
$("howtoSync").addEventListener("click", () => { closeHowto(); openAccount(); });
$("howtoMove").addEventListener("click", () => { closeHowto(); openXfer(); });

function setXferStatus(msg, kind) { const s = $("xferStatus"); s.textContent = msg || ""; s.className = "panel-status" + (kind ? " " + kind : ""); }
function openXfer() { $("xferText").value = ""; setXferStatus(""); $("xfer").hidden = false; $("xferClose").focus(); }
function closeXfer() { $("xfer").hidden = true; focusSearch(); }
$("xferClose").addEventListener("click", closeXfer);
$("xfer").addEventListener("click", (e) => { if (e.target.id === "xfer") closeXfer(); });

async function xferCopy() {
  const text = JSON.stringify({ watchlist: 1, items: items.map((m) => Sync.slim(m)) });
  const n = items.length;
  try {
    await navigator.clipboard.writeText(text);
    setXferStatus(`Copied ${n} ${n === 1 ? "title" : "titles"}. Open Watchlist in the other place and paste it below.`, "ok");
  } catch {
    $("xferText").value = text; $("xferText").focus(); $("xferText").select();
    setXferStatus("Could not copy by itself. The list is in the box: select all, copy it, then paste it in the other place.", "err");
  }
}
const sameTitle = (a, b) => (a.tmdbId && b.tmdbId)
  ? String(a.tmdbId) === String(b.tmdbId) && (a.type === "tv") === (b.type === "tv")
  : String(a.title || "").trim().toLowerCase() === String(b.title || "").trim().toLowerCase();
// How far along a title is: 0 To watch, 1 Watching (or has progress), 2 Watched
const xferState = (m) => (m.done ? 2 : m.watching || m.progress ? 1 : 0);
// Moving a list: new titles are added; a title you already have takes the copied one when the copy is further along
// (To watch -> Watching -> Watched) or, at the same stage, edited more recently. It never goes back a stage, so no progress is lost.
function xferMergeList(local, incoming, seed) {
  const out = local.slice();
  let added = 0, updated = 0;
  incoming.forEach((m, i) => {
    const d = Object.assign({}, m);
    const hit = out.find((x) => String(x.id) === String(d.id) && sameTitle(x, d)) || out.find((x) => sameTitle(x, d));
    if (!hit) {
      const clash = out.find((x) => String(x.id) === String(d.id));
      if (!Number.isFinite(Number(d.id)) || clash) d.id = seed + i + 1e6; // never overwrite a different title
      out.push(d); added++;
      return;
    }
    const w = xferState(d) > xferState(hit) || (xferState(d) === xferState(hit) && (Number(d.updatedAt) || 0) > (Number(hit.updatedAt) || 0));
    if (!w) return;
    const k = out.indexOf(hit);
    out[k] = Object.assign({}, d, { id: hit.id }); // keeps this device's id and place in the list
    updated++;
  });
  return { items: out, added, updated };
}
function xferAdd() {
  const raw = $("xferText").value.trim();
  let data = null;
  try { const at = raw.search(/[\[{]/); data = JSON.parse(at >= 0 ? raw.slice(at) : raw); } catch {}
  const list = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : null;
  const clean = list ? list.slice(0, 5000).filter((m) => m && typeof m === "object" && typeof m.title === "string" && m.title.trim()) : [];
  if (!clean.length) { setXferStatus("That does not look like a copied list. Copy it again and paste the whole text.", "err"); return; }
  const res = xferMergeList(items, clean, Date.now());
  items = res.items.map(normalizeItem);
  save(); render(); hydratePosters();
  const bits = [];
  if (res.added) bits.push(`Added ${res.added} ${res.added === 1 ? "title" : "titles"}`);
  if (res.updated) bits.push(`${res.added ? "updated" : "Updated"} ${res.updated} with your progress`);
  setXferStatus(bits.length ? bits.join(", ") + "." : "Nothing new: those titles are already in your list.", bits.length ? "ok" : "");
  if (bits.length) $("xferText").value = "";
}
$("xferCopy").addEventListener("click", xferCopy);
$("xferAdd").addEventListener("click", xferAdd);

/* ---------------- anonymous usage count ---------------- */
// Sends the platform and a random device id once a minute while the app is open and visible.
// No titles, no email, no computer name. The server adds the country.
function usagePlatform() {
  const ua = navigator.userAgent || "";
  if (window.api) return /win/i.test(navigator.platform || ua) ? "Windows app" : "Mac app";
  if (window.Capacitor && /Android/i.test(ua)) return "Android app";
  return /Android|iPhone|iPad|Mobile/i.test(ua) ? "Web (phone)" : "Web (computer)";
}
function usagePing() {
  if (document.visibilityState === "visible" && window.Sync && Sync.pingUsage) Sync.pingUsage(usagePlatform());
}
setInterval(usagePing, 60000);
document.addEventListener("visibilitychange", usagePing);
usagePing();

/* ---------------- share a title ---------------- */
// A shared link is short: <site>/m603 (movie) or <site>/t1396 (series), the TMDB number after one letter.
// The website answers it with a small page that carries the poster for the WhatsApp / iMessage preview,
// then opens the app at ?add=m603 (see worker/_worker.js). The web version uses its own address;
// the Mac, Windows and Android apps use SHARE_BASE from config.js.
const SHARE_BASE = String(window.SHARE_BASE || "").trim().replace(/\/+$/, "");
function shareBase() {
  if (!window.api && !window.Capacitor && /^https?:$/.test(location.protocol)) return location.origin;
  return SHARE_BASE;
}
function shareUrl(kind, id) {
  const base = shareBase();
  return base ? `${base}/${kind === "tv" ? "t" : "m"}${Number(id)}` : `https://www.themoviedb.org/${kind === "tv" ? "tv" : "movie"}/${Number(id)}`;
}
async function copyText(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* try the old way */ }
  try {
    const t = document.createElement("textarea");
    t.value = text; t.setAttribute("readonly", ""); t.style.cssText = "position:fixed;top:-100px;opacity:0";
    document.body.appendChild(t); t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  } catch { return false; }
}
// Opens the phone's own share sheet; where there is none (most computers, the Mac / Windows apps) the link is copied.
function shareTitle(m) {
  if (!m || !m.tmdbId) return;
  const kind = kindOf(m);
  const url = shareUrl(kind, m.tmdbId);
  const name = m.year ? `${m.title} (${m.year})` : m.title;
  // *bold* is WhatsApp's bold. The link is sent as its own item (not typed into the text), so WhatsApp on iPhone shows it as a short tappable link.
  const text = `*${name}*\nI think you'd like this.\n\n*Add to your list*`;
  const copy = async () => toast((await copyText(url)) ? "Link copied. Paste it in any chat." : "Could not copy the link: " + url);
  // Android app: the phone's own share sheet through the Capacitor Share plugin (the app's web view has no navigator.share).
  const cap = window.Capacitor;
  const native = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.Share;
  if (native) {
    native.share({ title: name, text, url, dialogTitle: "Share with" }).catch((e) => { if (!/cancel|abort|dismiss/i.test(String(e && (e.message || e.name || e)))) copy(); });
  } else if (navigator.share && !window.api) { // iPhone / Android browser and the Home Screen app
    navigator.share({ title: name, text, url }).catch((e) => { if (!e || e.name !== "AbortError") copy(); }); // cancelling the sheet is not an error
  } else copy(); // computers and the Mac / Windows apps have no share sheet
}

/* ---------------- opened from a shared link ---------------- */
let shareIn = null; // { kind, id, d, dup }
function closeShareIn() {
  $("shareIn").hidden = true;
  shareIn = null;
  focusSearch();
}
function shareInStatus(msg, kind = "") { const s = $("siStatus"); s.textContent = msg || ""; s.className = "panel-status" + (kind ? " " + kind : ""); }
async function openSharedTitle(kind, id) {
  shareIn = { kind, id, d: null, dup: null };
  const mine = shareIn;
  $("siFrom").textContent = "A friend recommended";
  $("siTitle").textContent = "";
  $("siSub").textContent = "";
  $("siPoster").innerHTML = "";
  $("siPlot").hidden = true;
  $("siAdd").disabled = true;
  $("siAdd").textContent = "Add to my list";
  shareInStatus("Loading…");
  $("shareIn").hidden = false;
  closeMenu(); closeResults();
  try {
    const d = await tmdb("/" + kind + "/" + id);
    if (shareIn !== mine) return; // closed, or another link opened meanwhile
    const title = d.title || d.name || "";
    if (!title) throw new Error("no title");
    mine.d = d;
    const year = (d.release_date || d.first_air_date || "").slice(0, 4);
    const genres = (d.genres || []).slice(0, 2).map((g) => g.name).join(", ");
    $("siTitle").textContent = title;
    const si = kind === "tv" ? seasonInfo(d) : null;
    $("siSub").textContent = [kind === "tv" ? "Series" : "Movie", year, genres, si ? seasonSummary(si) : ""].filter(Boolean).join(" \u00B7 ");
    $("siPoster").innerHTML = d.poster_path ? `<img src="${esc(IMG_T + "w342" + d.poster_path)}" alt="" draggable="false">` : "";
    const plot = String(d.overview || d.tagline || "").trim();
    $("siPlot").textContent = plot; $("siPlot").hidden = !plot;
    mine.dup = items.find((m) => m.tmdbId === id && kindOf(m) === kind) || null;
    if (mine.dup) {
      shareInStatus(`Already in your list (${statusLabel(mine.dup)}).`, "ok");
      $("siAdd").textContent = "Open my list";
    } else {
      shareInStatus(window.__iosInApp ? "Tip: open this link in Safari so the title is saved in your own list." : "");
    }
    $("siAdd").disabled = false;
    $("siAdd").focus();
  } catch {
    if (shareIn !== mine) return;
    shareInStatus("Could not load this title. Check your internet connection and open the link again.", "err");
  }
}
async function addSharedTitle() {
  const s = shareIn;
  if (!s || !s.d) return;
  if (s.dup) { // already there: just show where it is
    tab = s.dup.done ? "done" : s.dup.watching ? "watching" : "watch";
    closeShareIn(); render();
    return;
  }
  const d = s.d, title = d.title || d.name;
  const id = Date.now();
  const posterUrl = d.poster_path ? IMG_SAVED + d.poster_path : "";
  const item = {
    id, title, stars: 3, note: "Recommended by a friend", done: false,
    year: (d.release_date || d.first_air_date || "").slice(0, 4), type: s.kind,
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    poster: posterUrl, posterPath: d.poster_path || "", tmdbId: s.id, tmdbTitle: title,
  };
  insertNew(item);
  save();
  forgetTitleKeys(item);
  warmRelated(item.tmdbId, item.type);
  tab = "watch";
  closeShareIn();
  render();
  // Added with Medium priority and a note saying who it came from. One tap to change either.
  toast(`${title} added to To watch`, { label: "Edit", run: () => { const m = items.find((x) => x.id === id); if (m) openEdit(m); } });
  hydratePosters();
  if (posterUrl) {
    try {
      const data = await toDataUrl(posterUrl);
      const m = items.find((x) => x.id === id);
      if (m) { m.poster = data; save(); render(); }
    } catch { /* the poster is loaded from TMDB when online */ }
  }
}
$("siAdd").addEventListener("click", addSharedTitle);
$("siSkip").addEventListener("click", closeShareIn);
$("shareIn").addEventListener("click", (e) => { if (e.target === $("shareIn")) closeShareIn(); });
// The link opens the app as ?add=m603 / ?add=t1396. Read it once, then clean the address so a refresh does not ask again.
function handleSharedLink() {
  let v = "";
  try { v = new URLSearchParams(location.search).get("add") || ""; } catch { return; }
  const m = /^([mt])(\d{1,9})$/.exec(v);
  if (!v) return;
  try { history.replaceState(history.state, "", location.pathname + location.hash); } catch { /* old browser */ }
  if (!m || !canSearch()) return;
  openSharedTitle(m[1] === "t" ? "tv" : "movie", Number(m[2]));
}

/* ---------------- start ---------------- */
applyTheme(theme);
checkReminders();
queueNativeReminders();
if (window.api && window.api.setTheme) window.api.setTheme(theme);
render();
if (syncActive()) runSync();
if (!canSearch()) openPanel();
else focusSearch();
hydratePosters();
handleSharedLink();

/* ---- phone keyboard: keep the sheet (and the field you are typing in) above the keyboard ----
   On iPhone the keyboard covers the bottom of a fixed sheet and the page does not always scroll to the field. We measure the part of the screen the keyboard takes
   (visualViewport) and lift the sheet by that much, then bring the field into view. */
(function () {
  const vv = window.visualViewport;
  if (!vv) return;
  const set = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--kb", kb > 80 ? kb + "px" : "0px"); // under 80 px is just the browser bar moving, not a keyboard
  };
  vv.addEventListener("resize", set);
  vv.addEventListener("scroll", set);
  set();
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!t || !t.matches || !t.matches("textarea, input, select") || !t.closest(".panel")) return;
    [120, 350, 700].forEach((ms) => setTimeout(() => { // the keyboard takes a moment to open; measure again as it settles
      set();
      if (document.activeElement === t) { try { t.scrollIntoView({ block: "center", behavior: "auto" }); } catch { /* old browser */ } }
    }, ms));
  });
  document.addEventListener("focusout", () => setTimeout(set, 250));
})();

/* Scroll lock: while any popup (.panel: details card, cast page, filters, account, ...) is open, the page behind it must not scroll.
   Fixing the body in place is the only way that also works on iOS Safari; the scroll position is put back when the last popup closes. */
(() => {
  const panels = Array.from(document.querySelectorAll(".panel"));
  let locked = false, savedY = 0;
  const sync = () => {
    const open = panels.some((p) => !p.hidden);
    const root = document.documentElement;
    if (open && !locked) {
      locked = true;
      savedY = window.scrollY || root.scrollTop || 0;
      document.body.style.top = -savedY + "px";
      root.classList.add("scroll-locked");
    } else if (!open && locked) {
      locked = false;
      root.classList.remove("scroll-locked");
      document.body.style.top = "";
      window.scrollTo(0, savedY);
    }
  };
  const mo = new MutationObserver(sync);
  panels.forEach((p) => mo.observe(p, { attributes: true, attributeFilter: ["hidden"] }));
  sync();
})();

$("tiRows").addEventListener("change", (e) => { // country picker in "Where to watch"
  const sel = e.target.closest && e.target.closest("[data-wtw]");
  if (!sel || !tinfoLast) return;
  try { localStorage.setItem(WTW_KEY, sel.value); } catch { /* storage blocked: it applies until the card closes */ }
  $("tiRows").innerHTML = tinfoRows(tinfoLast);
});

/* ---- Release-day alerts (optional, off by default) ----
   One notification a day, at 9:00 or when the app is next opened after that, listing what comes out today: movies in To watch and
   the next episode of every series you follow (episodes you ticked as watched are left out). Needs the app to be open or running,
   like the airing reminders; turned on / off with the switch under the calendar. */
const REL_KEY = "movie-watchlist-relnotify", REL_SEEN = "movie-watchlist-relseen", REL_TIME = "09:00";
const relOn = () => { try { return localStorage.getItem(REL_KEY) === "1"; } catch { return false; } };
const relSeenDate = () => { try { return (JSON.parse(localStorage.getItem(REL_SEEN)) || {}).d || ""; } catch { return ""; } };
function checkReleaseAlerts() {
  if (!relOn() || nowHM() < REL_TIME) return;
  const date = todayStr();
  if (relSeenDate() === date) return; // already told today
  if (canSearch() && navigator.onLine !== false && !calBusy) calRefresh(true).then(() => fireReleaseAlert(date), () => {}); // dates up to date first
  else fireReleaseAlert(date);
}
function fireReleaseAlert(date) {
  if (relSeenDate() === date) return;
  const today = calEntries().filter((x) => calDays(x.date) === 0);
  try { localStorage.setItem(REL_SEEN, JSON.stringify({ d: date })); } catch { /* optional */ }
  if (!today.length) return;
  const names = today.map((x) => (x.s ? `${x.m.title} S${x.s} E${x.e}` : `${x.m.title} (movie)`));
  const body = names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4} more` : "");
  let shown = false;
  try { if ("Notification" in window && Notification.permission === "granted") { new Notification("Out today", { body }); shown = true; } } catch { /* fall back to the toast */ }
  if (!shown) toast("Out today: " + body);
}
function relToggle(on) {
  try { localStorage.setItem(REL_KEY, on ? "1" : "0"); localStorage.removeItem(REL_SEEN); } catch { /* optional */ }
  if (on) { askNotifyPermission(); checkReleaseAlerts(); }
}
setInterval(checkReleaseAlerts, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkReleaseAlerts(); });
setTimeout(checkReleaseAlerts, 4000);

if ($("calRel")) $("calRel").addEventListener("change", (e) => relToggle(e.target.checked));

/* ---- What to watch tonight (dice button in the To watch header) ----
   1. A series you are following (Watching) that is still airing and has an aired episode you have not ticked comes first: catch up
      before starting anything new. The calendar's Season / Episode progress decides what counts as watched.
   2. Otherwise one pick from To watch: only titles that are out and watchable now (not "Not released", "In cinemas" or "Awaiting OTT"),
      weighted by the star priority (pinned ones count double), never the same one twice until the list has been seen.
   3. Series from To watch are never picked while any series sits in Watching; they would only add to the pile. */
let tnSeen = new Set(), tnCur = null;
function tnBehind() {
  const cache = calLoad(), out = [];
  items.forEach((m) => {
    if (m.done || !inTab(m, "watching") || kindOf(m) !== "tv") return;
    const c = cache[calKey(m)];
    if (!c || c.v !== 2 || c.end) return; // no dates yet, or the show is not airing
    if (m.progress && m.progress.release === "out") return;
    const seen = new Set(), eps = [];
    [...(c.eps || []), c.ls].forEach((x) => { if (!x) return; const k = x.s + "-" + x.e; if (seen.has(k)) return; seen.add(k); if (calDays(x.d) <= 0 && !calWatched(m, x.s, x.e)) eps.push(x); });
    if (!eps.length) return;
    eps.sort((a, b) => a.s - b.s || a.e - b.e);
    out.push({ m, eps });
  });
  return out.sort((a, b) => b.eps.length - a.eps.length || a.eps[0].d.localeCompare(b.eps[0].d));
}
function tnPool() {
  const seriesWatching = items.some((m) => !m.done && inTab(m, "watching") && kindOf(m) === "tv");
  const today = todayIso();
  return items.filter((m) => {
    if (m.done || !inTab(m, "watch")) return false;
    if (seriesWatching && kindOf(m) === "tv") return false;
    const o = m.ott;
    if (o && o.rd && o.rd > today) return false; // not out yet
    if (o && o.t === 1 && o.s !== 1) return false; // tracked and not streaming yet (in cinemas / awaiting OTT)
    return true;
  });
}
const tnPoster = (m) => { const p = m.poster || (m.posterPath ? IMG_SAVED + m.posterPath : ""); return p ? `<img src="${esc(p)}" alt="" draggable="false">` : ""; };
function tnPaintBehind(list) {
  $("tnTitle").textContent = "Catch up first";
  $("tnAgain").hidden = true;
  const rows = list.map(({ m, eps }) => {
    const first = eps[0], more = eps.length > 1 ? ` <span class="ti-dim">+${eps.length - 1} more aired</span>` : "";
    return `<div class="tn-row"><div class="pp-thumb">${tnPoster(m)}</div><div class="pp-info"><p class="pp-t">${esc(m.title)}</p><p class="pp-m">Next up: S${first.s} E${first.e}${more}</p></div></div>`;
  }).join("");
  $("tnBody").innerHTML = `<p class="tn-lead">${list.length > 1 ? "These shows are" : "This show is"} still airing and you are behind. Watch ${list.length > 1 ? "them" : "it"} before starting something new.</p>${rows}<div class="panel-actions tn-acts"><button type="button" class="solid" data-tn="cal">Open calendar</button><button type="button" class="ghost" data-tn="movie">Pick a movie anyway</button></div>`;
}
function tnPick() {
  const pool = tnPool();
  $("tnTitle").textContent = "Tonight";
  if (!pool.length) {
    $("tnAgain").hidden = true;
    $("tnBody").innerHTML = `<p class="tn-lead">Nothing to pick right now. Titles in To watch that are not out yet, still in cinemas or waiting for OTT are left out.</p>`;
    return;
  }
  let left = pool.filter((m) => !tnSeen.has(m.id));
  if (!left.length) { tnSeen = new Set(); left = pool; }
  const w = left.map((m) => m.stars * m.stars * (m.pin ? 2 : 1));
  let r = Math.random() * w.reduce((a, b) => a + b, 0), pick = left[left.length - 1];
  for (let i = 0; i < left.length; i++) { r -= w[i]; if (r <= 0) { pick = left[i]; break; } }
  tnSeen.add(pick.id);
  tnCur = pick;
  const why = [pick.stars >= 4 ? LABELS[pick.stars] : "", pick.pin ? "Pinned" : ""].filter(Boolean).join(" \u00B7 ");
  $("tnBody").innerHTML = `<div class="ti-head"><div class="ti-poster">${tnPoster(pick)}</div><div class="ti-body"><h3 class="ti-title tn-name">${esc(pick.title)}</h3><p class="ti-sub">${esc(metaOf(pick))}</p>${why ? `<p class="tn-why">${esc(why)}</p>` : ""}<div class="tn-where" id="tnWhere"></div><button type="button" class="tn-link" data-tn="det">Details</button></div></div><p class="ti-dim tn-count">${pool.length} ${pool.length === 1 ? "title is" : "titles are"} ready in To watch.</p>`;
  $("tnAgain").hidden = pool.length < 2;
  if (pick.tmdbId && canSearch() && navigator.onLine !== false) { // where it streams, for the saved country
    const id = pick.id;
    tmdb("/" + kindOf(pick) + "/" + Number(pick.tmdbId) + "/watch/providers").then((r) => {
      if (!tnCur || tnCur.id !== id || $("tonight").hidden) return;
      const el = $("tnWhere");
      if (el) el.innerHTML = wtwGroups(r && r.results, wtwRegion()).map(([l, a]) => `<div class="wtw-r"><span class="wtw-l">${esc(l)}</span><span class="wtw-v">${esc(a.join(" \u00B7 "))}</span></div>`).join(""); // same Stream / Free / Rent or buy rows as the details popup
    }).catch(() => {});
  }
}
async function openTonight() {
  $("tnTitle").textContent = "Tonight";
  $("tnAgain").hidden = true;
  $("tnBody").innerHTML = `<p class="ti-dim">Checking your series\u2026</p>`;
  $("tonight").hidden = false;
  $("tnClose").focus();
  if (canSearch() && navigator.onLine !== false) { try { await calRefresh(true, (m) => inTab(m, "watching")); } catch { /* use what is remembered */ } }
  if ($("tonight").hidden) return;
  const behind = tnBehind();
  if (behind.length) tnPaintBehind(behind); else tnPick();
}
$("tonightBtn").addEventListener("click", openTonight);
$("tnClose").addEventListener("click", () => { $("tonight").hidden = true; tnCur = null; });
$("tnAgain").addEventListener("click", tnPick);
$("tonight").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tn]");
  if (e.target === $("tonight")) { $("tonight").hidden = true; tnCur = null; return; }
  if (!b) return;
  const act = b.dataset.tn;
  if (act === "movie") tnPick();
  else if (act === "det" && tnCur) openTinfo(tnCur);
  else if (act === "cal") { $("tonight").hidden = true; tnCur = null; tab = "watching"; calView = true; try { localStorage.setItem(CAL_VIEW_KEY, "1"); } catch { /* optional */ } render(); }
});
