// Builds the website into ./web:  /  = download page,  /web/ = the online app.
// Usage: npm run build:web
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const out = path.join(root, "web");
const app = path.join(out, "web"); // the online app lives at /web/ (inside the ./web build folder)

const appFiles = ["index.html", "styles.css", "renderer.js", "franchises.js", "sync.js", "config.js", "pwa.js", "sw.js", "manifest.webmanifest"];
const dirs = ["assets", "fonts", "icons"];

if (!fs.existsSync(path.join(root, "config.js"))) {
  console.error("config.js is missing. Copy config.example.js to config.js and fill in your Supabase values.");
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });

// Online app -> /web/
for (const f of appFiles) fs.copyFileSync(path.join(root, f), path.join(app, f));
for (const d of dirs) fs.cpSync(path.join(root, d), path.join(app, d), { recursive: true });

// Download page -> /
for (const f of fs.readdirSync(path.join(root, "site"))) fs.copyFileSync(path.join(root, "site", f), path.join(out, f));
for (const d of ["assets", "fonts", "icons"]) fs.cpSync(path.join(root, d), path.join(out, d), { recursive: true });
fs.copyFileSync(path.join(root, "icons", "favicon-32.png"), path.join(out, "favicon.ico"));
fs.copyFileSync(path.join(root, "_headers"), path.join(out, "_headers"));
// Share links (/m603, /t1396): a Cloudflare Worker (worker/index.js) answers them with a poster preview, then opens the app.
// wrangler.jsonc tells `wrangler deploy` to upload ./web as the site and run the worker beside it. Run: npm run deploy
{
  const cfg = fs.readFileSync(path.join(root, "config.js"), "utf8");
  const pick = (name) => { const m = cfg.match(new RegExp(name + "\\s*=\\s*[\"']([^\"']*)[\"']")); return m ? m[1].trim().replace(/\/+$/, "") : ""; };
  const wr = path.join(root, "wrangler.jsonc");
  let name = "watchlist";
  try { const old = fs.readFileSync(wr, "utf8").match(/"name"\s*:\s*"([^"]+)"/); if (old) name = old[1]; } catch {} // keep the Worker name you set
  fs.writeFileSync(wr, JSON.stringify({
    name, main: "worker/index.js", compatibility_date: "2025-09-01",
    assets: { directory: "./web", binding: "ASSETS" },
    preview_urls: false,
    vars: { SUPABASE_URL: pick("SUPABASE_URL"), SUPABASE_ANON: pick("SUPABASE_ANON_KEY") },
  }, null, 2) + "\n");
}
// Private usage dashboard. Not linked anywhere and not shipped in the Mac/Windows/Android apps.
const ADMIN_DIR = "check";
const adminSrc = path.join(root, ADMIN_DIR);
if (fs.existsSync(adminSrc)) {
  const adminOut = path.join(out, ADMIN_DIR);
  fs.mkdirSync(adminOut, { recursive: true });
  const cfgText = fs.readFileSync(path.join(root, "config.js"), "utf8");
  const m = cfgText.match(/SUPABASE_URL\s*=\s*["']([^"']+)["']/);
  const supaUrl = m ? m[1].replace(/\/+$/, "") : "";
  for (const f of fs.readdirSync(adminSrc)) {
    let data = fs.readFileSync(path.join(adminSrc, f));
    if (f === "index.html") data = data.toString().replace("__SUPABASE_URL__", supaUrl);
    fs.writeFileSync(path.join(adminOut, f), data);
  }
  fs.copyFileSync(path.join(root, "config.js"), path.join(adminOut, "config.js"));
  console.log("Private dashboard ready at /" + ADMIN_DIR + "/");
}
console.log("Web build ready in ./web  (download page at /, online app at /web/). Upload the web folder.");
