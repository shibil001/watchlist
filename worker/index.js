// Cloudflare Worker (with static assets). Share links reach it because no file matches them; every other request is the static site.
//
//   https://your-site/m603     movie  (TMDB id 603)
//   https://your-site/t1396    series (TMDB id 1396)
//
// It answers with a server-rendered title page: poster, facts, genres and overview are in the HTML itself (no script needed),
// plus Open Graph tags (WhatsApp, iMessage, Telegram, Instagram show a thumbnail card) and schema.org JSON-LD.
// A person's browser runs a one-line script and is sent straight on to the app (/web/?add=m603), which shows the "Add to my list" button.
// Link-preview bots and crawlers do not run scripts, so they read the full page. Without JavaScript the page stays and has its own button.
// Deploy with `npm run deploy`. The Supabase address and public key come from wrangler.jsonc (written by build-web.js from config.js).

const IMG = "https://image.tmdb.org/t/p/";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function lookup(kind, id, env) {
  const SUPABASE_URL = String(env.SUPABASE_URL || ""), SUPABASE_ANON = String(env.SUPABASE_ANON || "");
  if (!SUPABASE_URL) return null;
  try {
    const u = `${SUPABASE_URL}/functions/v1/tmdb-proxy?path=/${kind}/${id}`;
    const r = await fetch(u, { headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + SUPABASE_ANON }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d && (d.title || d.name) ? d : null;
  } catch { return null; }
}

const jsonLd = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
const runtime = (min) => { const n = Number(min) || 0; return n ? (n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? " " + (n % 60) + "m" : ""}` : `${n}m`) : ""; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Server-rendered title page: everything a person (or a crawler) needs is in the HTML, no script required.
function page({ origin, code, kind, d }) {
  const target = `/web/?add=${code}`;
  const title = d ? (d.title || d.name) : "A title for your Watchlist";
  const date = d ? (d.release_date || d.first_air_date || "") : "";
  const year = date.slice(0, 4);
  const name = year ? `${title} (${year})` : title;
  const genreList = d ? (d.genres || []).map((g) => g.name) : [];
  const genres = genreList.slice(0, 2).join(", ");
  const facts = [kind === "tv" ? "Series" : "Movie", genres].filter(Boolean).join(" · ");
  const desc = d ? `${facts}. A friend thinks you'd like this. Tap to add it to your Watchlist.` : "A friend shared this with you. Tap to add it to your Watchlist.";
  const image = d && d.poster_path ? `${IMG}w500${d.poster_path}` : `${origin}/icons/icon-512.png`;
  const w = d && d.poster_path ? 500 : 512, h = d && d.poster_path ? 750 : 512;
  const url = `${origin}/${code}`;

  // the facts line under the title
  const meta = [];
  if (d) {
    meta.push(kind === "tv" ? "Series" : "Movie");
    if (year) meta.push(year);
    if (kind === "tv") {
      if (d.number_of_seasons) meta.push(plural(d.number_of_seasons, "season"));
      if (d.status) meta.push(d.status);
    } else if (runtime(d.runtime)) meta.push(runtime(d.runtime));
    if (d.vote_count > 0 && d.vote_average) meta.push(`★ ${Number(d.vote_average).toFixed(1)}`);
  }
  const overview = d && d.overview ? String(d.overview) : "";
  const tagline = d && d.tagline ? String(d.tagline) : "";

  const ld = d ? {
    "@context": "https://schema.org",
    "@type": kind === "tv" ? "TVSeries" : "Movie",
    name: title,
    ...(date ? { datePublished: date } : {}),
    ...(overview ? { description: overview } : {}),
    ...(genreList.length ? { genre: genreList } : {}),
    ...(d.poster_path ? { image: image } : {}),
    ...(kind === "tv" && d.number_of_seasons ? { numberOfSeasons: d.number_of_seasons } : {}),
    ...(d.vote_count > 0 && d.vote_average ? { aggregateRating: { "@type": "AggregateRating", ratingValue: Number(d.vote_average).toFixed(1), ratingCount: d.vote_count, bestRating: 10 } } : {}),
    url,
  } : null;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(name)} · Watchlist</title>
<meta name="description" content="${esc(overview ? overview.slice(0, 160) : desc)}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Watchlist">
<meta property="og:title" content="${esc(name)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="${w}">
<meta property="og:image:height" content="${h}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(name)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
${ld ? `<script type="application/ld+json">${jsonLd(ld)}</script>\n` : ""}<style>
:root{--bg:#121212;--fg:#eee;--mut:#a7a7a7;--acc:#f08a4b;--line:#2a2a2a}
*{box-sizing:border-box}
html{background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
body{margin:0;min-height:100vh;padding:max(20px,env(safe-area-inset-top)) 20px max(28px,env(safe-area-inset-bottom))}
main{max-width:640px;margin:0 auto}
.brand{font-weight:800;letter-spacing:.08em;font-size:13px;color:var(--mut);text-transform:uppercase;margin:0 0 20px}
.card{display:flex;gap:20px;flex-wrap:wrap}
.poster{width:160px;max-width:40%;aspect-ratio:2/3;border-radius:8px;object-fit:cover;background:#1e1e1e;flex:none}
.info{flex:1 1 240px;min-width:0}
h1{margin:0 0 6px;font-size:26px;line-height:1.2}
.meta{color:var(--mut);margin:0 0 10px;font-size:14px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;padding:0;list-style:none}
.tags li{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:13px;color:var(--mut)}
.tag{font-style:italic;color:var(--mut);margin:0 0 8px}
.ov{margin:0 0 20px}
.btn{display:inline-block;background:#f2f2f2;color:#111;font-weight:800;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;padding:14px 22px;border-radius:8px}
.btn:focus-visible{outline:3px solid var(--acc);outline-offset:2px}
.sub{margin:14px 0 0;font-size:14px;color:var(--mut)}
a{color:var(--acc)}
</style>
</head><body><main>
<p class="brand">Watchlist</p>
<article class="card">
${d && d.poster_path ? `<img class="poster" src="${esc(image)}" width="160" height="240" alt="Poster of ${esc(title)}">` : ""}
<div class="info">
<h1>${esc(title)}</h1>
${meta.length ? `<p class="meta">${meta.map(esc).join(" · ")}</p>` : ""}
${genreList.length ? `<ul class="tags">${genreList.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}
${tagline ? `<p class="tag">${esc(tagline)}</p>` : ""}
${overview ? `<p class="ov">${esc(overview)}</p>` : `<p class="ov">${d ? "No description yet." : "A friend shared a title with you."}</p>`}
<a class="btn" href="${esc(target)}">Add to my list</a>
<p class="sub">Opens the Watchlist app. <a href="/web/">Open without adding</a></p>
</div>
</article>
</main>
<script>location.replace(${JSON.stringify(target)});</script>
</body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = /^\/([mt])(\d{1,9})\/?$/.exec(url.pathname);
    if (!m || (request.method !== "GET" && request.method !== "HEAD")) return env.ASSETS.fetch(request);

    const kind = m[1] === "t" ? "tv" : "movie";
    const id = Number(m[2]);
    const code = m[1] + id;

    // One lookup per title per day, shared by everyone who opens or previews the link.
    const cache = caches.default;
    const key = new Request(`${url.origin}/__share/v3/${code}`);
    const hit = await cache.match(key);
    if (hit) return hit;

    const d = await lookup(kind, id, env);
    const res = new Response(request.method === "HEAD" ? null : page({ origin: url.origin, code, kind, d }), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // A failed lookup is kept for a minute only, so a hiccup does not stick.
        "cache-control": d ? "public, max-age=3600" : "public, max-age=60",
        "x-robots-tag": "noindex",
      },
    });
    if (request.method === "GET") { try { await cache.put(key, res.clone()); } catch { /* not cached this time */ } }
    return res;
  },
};
