# Web, phone, Mac and Windows

One codebase runs everywhere. Desktop window size and layout are unchanged.

## Website + phone (installable PWA)
1. `npm run build:web` creates the `web/` folder.
2. Upload `web/` to Cloudflare Pages / Netlify / Vercel (drag and drop works).
3. Open the link on a phone:
   - Android / Chrome / Edge: menu -> **Install app**.
   - iPhone / iPad: Share -> **Add to Home Screen**.
Works offline after the first load. Test locally with `npm run serve` (http://localhost:8080).

Your list lives in each browser's own storage. Use **Back up & sync** (sign-in) to keep the same list on phone, web, Mac and Windows.

## Supabase checklist for the website
- The `tmdb-proxy` and `related` functions must allow your site's origin in CORS (or use `*`).
- If you restrict allowed origins/redirect URLs in Supabase, add your site address.

## Mac
`npm run build:mac` -> `dist/*.dmg` (universal: Apple Silicon + Intel). Run it on a Mac.

## Windows
`npm run build:win` -> `dist/Watchlist Setup x.y.z.exe` (installer) and a portable `.exe`.
Run it on Windows (or on a Mac with Wine). The menu bar is hidden so it looks like the Mac app.

## Download page
`npm run build:web` now makes the download page at `/` and the online app at `/web/`.
1. Build the apps: `npm run build` (Mac) and `npm run build:win` (Windows).
2. Create a GitHub Release (repo set in `site/downloads.js`) and upload from `dist/`:
   `Watchlist-mac.dmg` and `Watchlist-Setup.exe`. Keep these exact names.
3. The page's buttons always point to the latest release. New version = new release, no page change.

## Where the list is saved (web / phone)
- Browser or Home Screen app: `localStorage` under `movie-watchlist-v1` (list), `watchlist-session-v1` (sign-in), `watchlist-sync-v1` (sync bookkeeping).
  It belongs to one site address in one browser. Only the small poster path is saved; the poster picture is re-loaded from TMDB.
- **iPhone:** Safari and the Home Screen app have separate storage, so the app starts empty. Sign in (or use Move my list) to bring the list over.
  Safari also clears a site's storage after about 7 days without a visit; Home Screen apps are exempt. Signing in is the real backup.
  Safari and the Home Screen app each take one of the account's 3 device places.
- **Android:** Chrome and the installed app share storage, so the list is already there. The Android APK keeps its own list.

## If a phone shows "Response served by service worker has redirections"
Deploy this version (service worker `wl-v5`) and open the site once or twice so the phone picks up the new worker.
If it is still stuck: iPhone -> Settings -> Apps -> Safari -> Advanced -> Website Data -> remove the site, or delete the Home Screen icon and add it again.
Android -> Chrome menu -> Settings -> Site settings -> delete the site's data.
