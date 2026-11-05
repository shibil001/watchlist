# Cloud backup & sync: one-time setup (free)

The app works without any of this. Do it once to turn on the optional sign-in.
Accounts use an **email + password + 6-digit PIN**. Password reset is not included yet.

1. Create a free project at https://supabase.com (Dashboard -> New project).
2. Open **SQL Editor -> New query**, paste all of `supabase/setup.sql`, press **Run**.
3. Open **Authentication -> Providers -> Email** and turn **off** "Confirm email".
   (Needed so the app can tell a person that an account with that email already exists. With it off, anyone can create an account with any email address, since emails are not verified yet.)
4. Open **Project Settings -> API** and copy the **Project URL** and the **anon / publishable** key into
   `config.js` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`). Never use the `service_role` key.
5. Run the app. The menu now shows "Back up & sync".

## How the three login parts are used
- The password and the PIN are combined with the email into one long secret on the device (PBKDF2, 210,000 rounds).
  Supabase only ever receives that secret, never the password or the PIN.
- Changing any one of the three gives a completely different secret, so all three are required.
- A wrong login always says "The email, password or PIN is not right" (it never says which part).
- The app pauses sign-in after 5 wrong tries, and Supabase also rate-limits attempts per address
  (Authentication -> Rate Limits).

## Keep the free project awake
Free Supabase projects pause after 7 days with no activity. Active users keep it awake. To be safe, add a free
monitor (for example UptimeRobot) that opens `https://YOUR-PROJECT.supabase.co/auth/v1/health` every day.

## Known limits
- Losing the password or the PIN means losing access to the cloud copy. The list on each device is unaffected.
- Phone and Android apps: the same `index.html`, `renderer.js`, `sync.js` run inside a Capacitor wrapper (next step).

## Movie search without shipping a TMDB key

The TMDB key is kept as a secret on Supabase, so it is never inside the app.

1. Install the Supabase CLI and log in: `supabase login`, then `supabase link --project-ref YOUR_PROJECT_REF`
2. Store the key (get a free v3 key at themoviedb.org -> Settings -> API):
   `supabase secrets set TMDB_API_KEY=your_tmdb_v3_key`
3. Deploy the function from this folder:
   `supabase functions deploy tmdb-proxy --no-verify-jwt`
4. Make sure `config.js` has your `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

The app then searches through `<SUPABASE_URL>/functions/v1/tmdb-proxy`. The function only allows
`/search/multi`, `/search/movie`, `/search/tv`, `/configuration`, `/movie/{id}`, `/tv/{id}` (with `/recommendations`
or `/similar`) and `/collection/{id}`. It limits each IP to 60 requests a minute (change it with
`supabase secrets set RATE_LIMIT_PER_MIN=120`) and keeps answers in memory for a while, so repeated lookups
do not reach TMDB again.

**Spelling-tolerant search.** The search box asks for `fuzzy=1`. The function then cleans the text (accents,
curly quotes, `&`, extra spaces, `4` / `four` / `IV`), and if TMDB's answer does not look like what was typed
it tries other spellings and shortened forms, then ranks the results by how close they are to the typed text.
"interstelar", "inceptoin" and "the godfater" now find the right title. This all happens in one request
from the app. Other features (collections, similar taste, bulk matching) do not send `fuzzy`, so they get
TMDB's plain answers as before.

## Device limit (3 per account)

`supabase/setup.sql` also creates the `devices` table and its functions. One account can be signed in
on at most 3 devices. A 4th device sees a "Device limit reached" screen and must remove one first.
People can see and remove their devices under menu -> Devices. Signing out frees a place, and a device
unused for 60 days frees its place automatically. Run the whole file again after every update (it is safe to repeat).

## Collections (prequels and sequels)

The Collections tab lists every franchise that has one of your titles in it. The data comes from TMDB
through the `tmdb-proxy` function, which allows `/movie/{id}`, `/tv/{id}` and `/collection/{id}`.
After changing `supabase/functions/tmdb-proxy/index.ts`, deploy it again:
`supabase functions deploy tmdb-proxy --project-ref YOUR_PROJECT_REF --no-verify-jwt`

## Similar taste (sparkle button on the Watched tab)

The `similar` function blends TMDB (recommendations, similar, keywords, cast), Wikidata (genre, subject, "based on"),
plot-text similarity, and optionally IMDb / Rotten Tomatoes / Metacritic scores (OMDb) and Trakt "related". Language is checked first (a Malayalam title gets Malayalam suggestions; with fewer than 20 good ones, its good titles are kept and the list is filled from Tamil / Telugu / Kannada, then the rest of India, then the world, each farther step needing a higher score). How dark / intense a title is (genres, keywords, plot words, age rating) and the director / writer / composer are compared too, so a comedy does not show up for a violent thriller. Candidates come from TMDB and from what fans of the related titles also watch; genre is only a filter. The best candidates are then read more closely (their Wikipedia plot / themes / reception and TMDB user reviews) and compared with the original's story. The same text is also read for how a film *feels* (slow-burn, twisty, emotional, dark, funny, great performances ...): a "vibe" match, plus a small "audience" signal from the tone and star ratings of up to 8 TMDB reviews. At most one title per franchise. The server keeps up to 50 titles per list; the app shows 10 and draws a new 10 every 24 hours (better matches more often, titles already seen less often). Lists are rebuilt weekly: after 7 days the saved list is still shown at once and rebuilt in the background. Rough inputs (TMDB details and lists, Wikipedia, reviews, Wikidata, Trakt) are saved in `similar_raw`, so a title is never asked about twice.
Nothing is scraped. Letterboxd has no public API, so it is not used.

1. Run `supabase/similar.sql` once in Supabase -> SQL Editor (safe to run again).
2. Deploy: `supabase functions deploy similar --project-ref YOUR_PROJECT_REF --no-verify-jwt`
   (uses the `TMDB_API_KEY` secret you already set for `related`).
3. Optional, for IMDb / Rotten Tomatoes scores: get a free key at omdbapi.com, then `supabase secrets set OMDB_API_KEY=your_key`
   OMDb's free plan is 1000 calls a day, so the function spares it: each IMDb id is looked up once and the score is reused by
   every list for 90 days; titles OMDb does not know are remembered for 14 days; an expired score is only refreshed when quota
   is left; calls are counted per day in the database and stop at 900 (or as soon as OMDb says "limit reached"). If the quota
   runs out mid-build, the list is still shown and quietly rebuilt about a day later. Keep the key only as this secret, never in
   `config.js` or the app code. Re-run `supabase/similar.sql` after updating (it adds the counter) and redeploy `similar`.
   The same function also fills the title popup (tap a tile in To watch / Watched): `GET ?details=1&type=movie&id=...` asks TMDB, then Wikidata, then OMDb for director, production house, cast and a longer summary, and saves the answer for 30 days. No extra SQL is needed for this.
4. Optional, for Trakt: create an app at trakt.tv/oauth/applications, then `supabase secrets set TRAKT_CLIENT_ID=your_client_id`

How it learns: when you tick titles and press Add selected, ticked titles count as a yes and the others on screen as a weak no.
The shared weights (table `similar_weights`) learn from everyone, slowly and within safe limits; each device also keeps a small
personal adjustment in its own storage. Weights are kept per language group (`similar_weights_g`). Lists are cached 7 days; "similar_cache" rows can be deleted to force a rebuild. Re-run `supabase/similar.sql` and redeploy `similar` (it now has two files: `index.ts` and `logic.ts`).

## If you change Supabase project

The page may only contact your own project. Edit `connect-src` in the `Content-Security-Policy` line of
`index.html` and put the new project address there, or sync and search will be blocked.

## Related films & series (shared list)

The collection panel has a "Show related films & series" link. The list is built once on the server and kept in Supabase,
so everybody gets the same list instantly and TMDB is only asked once. Set it up once:

1. Open **SQL Editor -> New query**, paste all of `supabase/related.sql`, press **Run**.
   (It creates the `franchises` and `related_cache` tables and fills in Marvel, Star Wars, John Wick, Middle-earth and Harry Potter.)
2. Deploy the function (it uses the same `TMDB_API_KEY` secret as `tmdb-proxy`):
   `supabase functions deploy related --project-ref YOUR_PROJECT_REF --no-verify-jwt`
3. **Self-filling lists (new):** in **SQL Editor** run `supabase/related-auto.sql` once, then deploy the function again (step 2).
   After that, the list teaches itself: when someone adds a title (movie or series) or opens a related list, the function asks
   Wikidata which franchise it belongs to, saves the members as an `auto` franchise and records every title in `title_franchise`.
   Everyone after that gets the saved list instantly. Titles with no franchise are remembered for 30 days (`title_nofranchise`),
   auto lists are re-learned and rebuilt weekly, shorts/documentaries/"making of" extras are filtered out, and a franchise holds at most 80 titles.
   Your hand-written lists are never overwritten. If you edit the `items` of an `auto` list in the Table Editor it becomes `manual`.
   People can press **Report missing titles**; see them with `select franchise_id, count(*) from franchise_reports group by 1 order by 2 desc;`
4. Done. The first person to open a Marvel collection waits a few seconds while it is built; everyone after that is instant.

**Adding a title or a whole franchise:** open **Table Editor -> franchises**. Edit the `items` cell (`["t","Title",2026]`, t = series,
m = movie, then the year) or add a row. `match` lists the collection names (lower case, no "collection") that use it.
The list is rebuilt the next time someone opens it, and every 3 days anyway so new release dates show up.
To force everything to rebuild now: `update public.related_cache set built_at = null;`

If the function is not deployed, the app still works: it falls back to building the list on the device (slow, about a minute).


## Discover tab
The **Discover** tab (after Collections) shows 5 titles a day picked at random from a pool that fits the titles you watched, this week's trending ranked by your taste, and plain trending.
The server also counts what was shown and what was added, for everyone (only keys and counts), so titles many people add rank higher.

1. Run `supabase/discover.sql` once in Supabase -> SQL Editor (safe to run again).
2. Deploy: `supabase functions deploy discover --project-ref YOUR_PROJECT_REF --no-verify-jwt` (uses the `TMDB_API_KEY` secret you already set).
