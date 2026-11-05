/* Service worker: lets the web version load instantly and work offline.
   - App files: cached on first load, refreshed in the background.
   - Posters from TMDB: cached (up to 700).
   - Search, sync and sign-in requests are never cached. */
const VERSION = "wl-v140";
const SHELL = `${VERSION}-shell`;
const POSTERS = "wl-posters"; // not tied to the version: an app update must not throw away the saved poster pictures
const SCOPE = new URL("./", self.location).href; // e.g. https://host/web/
const FILES = [
  "index.html", "styles.css", "renderer.js", "franchises.js", "sync.js", "config.js", "pwa.js",
  "manifest.webmanifest", "assets/logo.svg",
  "fonts/sans-regular.woff2", "fonts/sans-medium.woff2", "fonts/sans-bold.woff2",
  "fonts/cond-medium.woff2", "fonts/cond-bold.woff2",
  "icons/icon-192.png", "icons/icon-512.png",
];

/* Safari and Chrome refuse to show a page that a service worker serves from a response that went through a
   redirect ("Response served by service worker has redirections"). Static hosts do redirect (/web/index.html
   -> /web/, with or without a trailing slash). So every response that was redirected is rebuilt as a plain one
   before it is cached or served. Only the content type is copied: the body is already decoded, so copying
   Content-Encoding / Content-Length would corrupt it. */
async function clean(res) {
  if (!res || !(res.redirected || res.type === "opaqueredirect")) return res;
  const headers = new Headers();
  const type = res.headers.get("content-type");
  if (type) headers.set("content-type", type);
  return new Response(await res.blob(), { status: 200, statusText: "OK", headers });
}

// The app is one page. Always fetch the folder address itself and let the network follow any redirect.
async function fetchShell() {
  const res = await fetch(SCOPE, { cache: "no-cache", credentials: "same-origin", redirect: "follow" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return clean(res);
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    try { const out = await fetchShell(); await c.put(SCOPE, out.clone()); await c.put(new URL("index.html", SCOPE).href, out.clone()); } catch {}
    await Promise.all(FILES.filter((f) => f !== "index.html").map(async (f) => {
      try {
        const res = await fetch(f, { cache: "reload" });
        if (res.ok) await c.put(f, await clean(res));
      } catch {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION) && k !== POSTERS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// Page loads: show the saved copy at once (works offline), refresh it in the background.
async function navigate(e) {
  const c = await caches.open(SHELL);
  const refresh = async () => { const out = await fetchShell(); await c.put(SCOPE, out.clone()); return out; };
  const hit = await c.match(SCOPE);
  if (hit) {
    e.waitUntil(refresh().catch(() => {}));
    return clean(hit);
  }
  try { return await refresh(); }
  catch { const alt = await c.match(new URL("index.html", SCOPE).href); return alt ? clean(alt) : Response.error(); }
}

// Posters: cache first. Fetched with CORS so the cached copy has its real (small) size instead of an opaque one.
async function poster(req) {
  const c = await caches.open(POSTERS);
  const hit = await c.match(req.url);
  if (hit) return hit;
  try {
    let res;
    try { res = await fetch(req.url, { mode: "cors", credentials: "omit" }); } catch { res = await fetch(req); }
    if (res.ok || res.type === "opaque") { c.put(req.url, res.clone()).then(() => trim(c, 700)).catch(() => {}); }
    return res;
  } catch { return Response.error(); }
}

// Other app files: serve the saved copy now, refresh it in the background.
async function asset(e, req) {
  const c = await caches.open(SHELL);
  const hit = await c.match(req, { ignoreSearch: true });
  const net = fetch(req).then(async (res) => {
    const out = await clean(res);
    if (out.ok && out.status === 200) { try { await c.put(req, out.clone()); } catch {} }
    return out;
  }).catch(() => null);
  if (hit) { e.waitUntil(net); return clean(hit); }
  return (await net) || Response.error();
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.hostname === "image.tmdb.org") { e.respondWith(poster(req)); return; }
  // Everything else on another origin (APIs, sync, sign-in): straight to the network.
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") { e.respondWith(navigate(e)); return; }
  e.respondWith(asset(e, req));
});
