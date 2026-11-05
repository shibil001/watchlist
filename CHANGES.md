# Review changes

## Extra films from IMDb's text files, matched to TMDB (v97)
- Only people who were opened in the app are looked up (never the whole of IMDb). A daily GitHub Action (`.github/workflows/imdb-sync.yml`, `scripts/imdb-sync.js`) takes up to 200 saved people (most opened first, older than 7 days or never looked up), reads IMDb's free `title.principals` and `title.basics` files once, keeps only those people's rows, matches each title to TMDB with `/find`, and saves a small JSON per person in `person_store.imdb` (id, type, title, date, poster, votes, roles). Titles already on TMDB's / Wikidata's list are skipped.
- The person page shows these under All / Movies / Series / Upcoming like any other title, marked "from IMDb". A first-time person shows the usual list; the IMDb extras appear after the next daily run.
- Only movie, TV movie, series and mini-series are kept (no episodes, shorts, video).
- **Deploy:** 1) run `supabase/imdb_extras.sql`. 2) `npx supabase functions deploy similar --project-ref avbhykskutojxgesacxo --no-verify-jwt`. 3) Put the project in a GitHub repo and add secrets SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TMDB_API_KEY (Settings -> Secrets and variables -> Actions). 4) Actions tab -> "IMDb extra films" -> Run workflow once to test. 5) `npm run build:web`, `npm run deploy`, hard-reload twice. Service worker wl-v140.


## Person pages kept in the database and refreshed by themselves (v96)
- **Upcoming:** unreleased titles show only under the **Upcoming** chip (already in v95; checked again, All / Movies / Series hold released titles only).
- **Stored people:** every director / actor / composer page that anyone opens is now saved in Supabase (`person_store`: TMDB profile + filmography, Wikidata filmography, Wikipedia bio) and served from there. The app asks `similar?personfull=1&id=<TMDB person id>` first; if the server cannot be reached it falls back to the old live lookups.
- **Self-updating:** a saved person older than 7 days (1 day when they have an upcoming title) is still shown at once and refreshed in the background. A schedule (pg_cron, every 6 hours) also refreshes the oldest 25 people, most opened first, so new releases and corrections arrive without anyone opening the page. If TMDB, Wikidata or Wikipedia fails during a refresh, the saved data is kept.
- More of a person's films: the stored record includes the Wikidata list, so titles TMDB lacks stay available without a live Wikidata call each time.
- **Deploy:** 1) run `supabase/person_store.sql` in SQL Editor. 2) `npx supabase secrets set PERSON_REFRESH_TOKEN=<any long random text> --project-ref avbhykskutojxgesacxo`. 3) `npx supabase functions deploy similar --project-ref avbhykskutojxgesacxo --no-verify-jwt`. 4) In SQL Editor, run the commented schedule block at the bottom of `person_store.sql` (fill in project ref, anon key, same token). 5) `npm run build:web`, `npm run deploy`, hard-reload twice. Service worker wl-v139.


## Person page: one list, Upcoming tag, more credits kept (v95)
- The role chips (Directing, Cinematography, Writing...) and the "Most famous first" chip are gone. Chips are now **All / Movies / Series / Upcoming**; the role stays in the grey line under each title. Order is most famous first.
- **Upcoming** (shows only when there is something): titles with a release date after today, soonest first, with "Releases <date>". They no longer appear in All / Movies / Series.
- A director's page now also keeps Producer, Editor and Assistant / Associate / Co-Director credits (before: only Director, Writer, Cinematographer).
- Deploy: `npm run build:web`, then `npm run deploy`, hard-reload twice. Service worker wl-v138.

## Fuller director / cinematographer / actor pages (v94)
- The person page showed only TMDB's biography, often one or two lines (C. Prem Kumar). The server now also reads the person's **Wikipedia** text (found through Wikidata's TMDB person id) and the page uses it when it says more than TMDB. Cut at a sentence end, about 1800 characters, ends with "From Wikipedia". A "+" opens the rest as before.
- The line under the name now also shows the full birth date, the birthplace and a death year when TMDB has them (for example "Directing - Born 4 Dec 1982 - Chennai, India").
- New server call `?personbio=1&id=<TMDB person id>` in `similar`: saved 30 days ("nothing found" 3 days), no Gemini credit used. The person's TMDB page itself is also in the new hot cache.
- **More of a director's films:** a director who also worked as cinematographer now keeps those films too (C. Prem Kumar: Pasanga, Naduvula Konjam Pakkatha Kaanom), with a new "Cinematographer" chip. Before, only Director and Writer credits were kept for the Directing department.
- **Most famous first:** the person page now lists films by TMDB vote count by default; one chip switches to "Newest first".
- Deploy: `npx supabase functions deploy similar --project-ref avbhykskutojxgesacxo --no-verify-jwt`, then `npm run deploy`, hard-reload twice. Service worker wl-v137.

## Watchmode as a second source, Gemini last; database cache for most searched titles and people (v93)
- **Streaming check order (whole chain):** 1) TMDB, 2) Wikidata, 3) **Watchmode**, 4) **Gemini search (last)**. Steps 3 and 4 are one server call that checks the saved answer first, then Watchmode, then Gemini. Gemini credit runs out first, so it is only asked when Watchmode has nothing. A Watchmode "found" is returned at once (no Gemini call). If Watchmode has nothing and Gemini cannot answer (no credit, resting, busy), the empty answer is saved 30 minutes as "not available" instead of being retried every time.
- **Watchmode is never over-used:** the free plan is about 1000 calls a month, so each call is counted in the database (`api_usage`) and stops at 900 a month and 50 a day (secrets `WATCHMODE_MONTHLY_CAP`, `WATCHMODE_DAILY_CAP` change this). If the counter table is missing, Watchmode is skipped (safe), not called without a limit.
- **Popup:** a service found by Watchmode says "via Watchmode"; one found by Gemini still says "via Gemini search (JustWatch)".
- **Hot cache (`tmdb-proxy`):** every TMDB request is counted in the database (`hot_cache`). Once the same one has been asked twice, its answer is saved, so the most searched films, series, directors and actors are answered from Supabase, not TMDB. Lifetimes: search 6 h, film/series 6 h (release dates can change), where-to-watch 3 h, people 3 days. Rows nobody asks for are removed automatically (under 3 hits after 3 days, anything unused for 30 days). Top list: `select k, hits from hot_cache order by hits desc limit 50;`
- **Similar titles during a Gemini outage:** the list is still built from TMDB, Wikipedia, Wikidata, Trakt and OMDb. A list built while Gemini could not answer (no credit, rate limit) is kept only about 6 hours, not 7 days, so it is rebuilt with the Gemini picks once Gemini is back.
- Gemini-heavy answers that were already saved long-term are unchanged (similar-titles lists 7 days, film details 30 days, a person's missing films 30 days, film "hearts" forever).
- **Deploy (in this order):** 1) run `supabase/cache_and_quota.sql` in Supabase -> SQL Editor. 2) `npx supabase secrets set WATCHMODE_API_KEY=<your key> --project-ref avbhykskutojxgesacxo`. 3) `npx supabase functions deploy similar --project-ref avbhykskutojxgesacxo --no-verify-jwt` and `npx supabase functions deploy tmdb-proxy --project-ref avbhykskutojxgesacxo --no-verify-jwt`. 4) `npm run deploy`, hard-reload twice. Service worker wl-v136.

## Streaming titles with no platform named: retry, Check again, honest wording (v90)
- The Mongoose and Blind Game showed "Out on streaming, but the platform is not listed yet" while JustWatch already named the service. Cause: such a film was counted as \"settled\" after its first Gemini answer and never looked at again, and the server kept a \"not found\" answer for 3 hours.
- **Retry:** a film that counts as streaming but has no service named is asked again (Gemini search only, no TMDB round) every hour, for up to 180 days.
- **Server (`supabase/functions/similar`):** a "not found" is saved 30 minutes (a "found" still 3 hours); `&fresh=1` skips the saved answer (limit 6 per minute per IP).
- **Popup:** the line now reads "Expected on streaming, platform not confirmed yet", (no button: the background checks do the work).
- A search that used no streaming guide, or whose answer cannot be read, is now an error (not saved, asked again) instead of a saved "not available". The film retry asks TMDB's provider list first, then Gemini.
- **Similar titles come first (v90):** the Gemini key is shared, and the free tier allows only a few requests a minute. The streaming check now waits while any similar-titles call is running, stays quiet 5 minutes after a 429 (kept in `similar_cache` row `avail:pause`, so every instance obeys it), spaces its calls 8 seconds apart, and allows only 6 checks a minute per IP (3 for Check again). The app asks Gemini one title at a time, 6 seconds apart, at most 3 per pass, and stops for 5 minutes after a rate-limit or busy answer.
- No buttons in the popup: the platform is found by the background checks only (TMDB first, then the Gemini search, hourly), so there is no Check again or Set platform button.
- **Deploy the function first:** `npx supabase functions deploy similar --project-ref avbhykskutojxgesacxo --no-verify-jwt`. Then `npm run deploy`, hard-reload twice. Service worker wl-v135.

## "Limited series" bubble follows the same rule as the other release tags (v89)
- Akka (out 30 Oct, added today) showed "Limited series · 5 episodes". Like "Available to stream", the bubble now shows only for a series that was added BEFORE it was out. One that was already out when added gets no bubble (the details popup still says "Limited series").
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v134.

## One release-tag rule for the list and the calendar, and date fixes (v88)
- **One rule:** the To watch list and the calendar each had their own tag logic, so they could disagree (the calendar said "Available to stream" for a film that was already streaming when added; the list did not). Both now use one function (`filmStage`): reached a service after you added it -> "Available to stream" (30 days); out today -> "Out today in cinemas"; out tomorrow -> "Out tomorrow in cinemas"; later -> "Not released yet" (list only, the calendar shows the date); 1 to 45 days out -> "In cinemas"; 46 to 400 days -> "Awaiting OTT". A film already streaming when added gets no tag.
- **Dates:** a bare date like 2026-11-04 was read as midnight UTC, so for some hours each day every age was off by one day (a film out yesterday could count as "today"). All release ages now count whole calendar days on your device (`daysSince`): "In cinemas" 45-day and "Awaiting OTT" 400-day limits, the 14-day recheck window, the 60-day Gemini window, the 45-day small-country rule, and the "episode in the last 21 days" rule. A TMDB digital date counts from the day after it. The "Add to collection" check for unreleased titles also used a UTC date; it now uses your date.
- **Series:** a new season dated today shows "S2 out today" (and "S2 out now" after), no longer "S2 starts 5 Nov" (Black Doves).
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v133.

## A digital date that has passed counts from the next day (v87)
- The Mongoose streamed on 4 Nov but still showed "In cinemas": a film that played in cinemas waited 3 days on its TMDB digital date. Now it counts from the day after that date (at once when the date is in India or the film never played in cinemas). The popup says "Not yet confirmed by a streaming guide" until a guide or the Gemini search names the service.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v132.

## "Digital release" tag removed (v86)
- The Mongoose showed "Digital release 4 Nov": a TMDB date from one country (Brazil) that says nothing about India or about a real service. The tag is gone. A film that played in cinemas and has only a TMDB digital date keeps its normal tag ("In cinemas" / "Awaiting OTT") until a streaming guide or the Gemini search finds a service.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v131.

## "Available to stream" only for titles added before they reached a service (v85)
- The tag showed on every film that was streaming while still in its first 45 days, even when it was already streaming the day you added it (Your Mother Your Mother Your Mother). Now only a title that was NOT streaming when added, and reached a service afterwards, gets the tag (for 30 days). A title already streaming when added gets no tag. Series are unchanged.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v130.

## Limited series bubble (v84)
- The list bubble for a limited series said "Ongoing · S1: 3 episodes aired" (TMDB keeps it as a running show). It now says "Limited series · 3 episodes". A short season (8 episodes or fewer) whose episodes all came out within one week now counts as limited, not only the same day.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v129.

## Limited series, and the platform no longer depends on TMDB (v83)
- **Limited series:** Taken: Natalee Holloway (3 episodes, all out on one day) showed "Ongoing" and "Next season: Not announced yet". A mini-series, or one short season (8 episodes or fewer) that came out in one go with nothing dated after it, now shows "Limited series" with no next-season row, and no "Ongoing" tag in the list. Its first and last episode date are the same day. If a second season or a dated next episode appears later on TMDB, it stops being limited by itself. Regular series with more seasons are unchanged.
- **Platform:** the "Where to watch" row now shows the service as a normal row (for example "Stream: Netflix") and never "Found: TMDB ...". A TMDB network name or digital date is only a hint now: a streaming-guide listing or the Gemini search (JustWatch) has to name the service. A series from a streaming network that has premiered still counts at once, but the Gemini search is asked to confirm it and the popup says "Not yet confirmed by a streaming guide" until it does. A film's TMDB digital date counts at once when the film never played in cinemas (Dilwali Diwali); for a film that did, it counts after 3 days, and until then the tag says "Digital release <date>" while the Gemini search looks for it (Dilwali Diwali no longer says "Not on any service" and "Found" together).
- The Gemini search now also runs for titles TMDB had marked streaming on a date or network alone (it used to be skipped, so no platform was ever found), and in the popup even when TMDB's where-to-watch list is missing.
- Answers saved earlier that rested on a TMDB date, network or Wikidata alone, and every series, are checked once again after this update.
- No server change: only `npm run deploy`, then hard-reload twice. Service worker wl-v128.

## Tags no longer wait for the Gemini search (v81)
- "In cinemas" took 3-5 minutes: the Gemini search ran inside the loop, before each tag was saved, and one answer takes 10-40 seconds.
- Now every tag is saved and shown first. The Gemini search runs afterwards, two titles at a time, and only changes a tag when it finds the title streaming.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v127.

## Details popup: services from the Gemini search when TMDB has none (v80)
- The Mongoose showed "Found: TMDB digital release (BR ...)": TMDB's where-to-watch list is empty for it, and the Gemini search never ran because the title was already marked streaming from TMDB's Brazil date.
- Now the popup asks the Gemini search (JustWatch pages) when TMDB lists no service anywhere for a title released in the last 60 days, and shows what it finds as normal rows with "via Gemini search (JustWatch)". The popup is drawn first; the rows update when the answer arrives. The server saves each answer 3 hours.
- **Deploy the function first:** `supabase functions deploy similar --project-ref avbhykskutojxgesacxo --no-verify-jwt`. Then `npm run deploy`, hard-reload twice. Service worker wl-v126.

## Details popup: where it streams when not in your country (v79)
- The "Where to watch" row was hidden when a title was not on a service in your country, so The Mongoose (streaming in other countries) showed nothing. It now says "Not on any service in <country> yet", then "Elsewhere" with up to 4 main countries and their services. If TMDB lists no service anywhere but the app found one (TMDB digital date / Gemini search), the popup shows that line.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v125.

## Streaming film with no release date gets its tag (v78)
- Primetime (streaming, but TMDB has no release date) showed no tag: the "first 45 days" rule needs a date. It now shows "Available to stream" for 30 days from the first check.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v124.

## Streaming check: Gemini with live search as the last fallback (v77)
- Order: TMDB (dates + where-to-watch) -> Wikidata -> Gemini (Google Search, told to read JustWatch's page for the title in each main country).
- Only for a released title under 60 days old that nothing else found streaming, at most every 3 hours per title; saved 3 hours for everyone (similar_cache key avail:v1:<kind>:<id>).
- An answer counts only if Gemini's search really used a known source (JustWatch, TMDB, IMDb, a streaming service's site ...). The tag's tooltip says "per Gemini search".
- **Deploy the function first:** `supabase functions deploy similar --project-ref avbhykskutojxgesacxo --no-verify-jwt`. Then `npm run deploy`, hard-reload twice. Service worker wl-v123.

## "Available to stream" in any main market (v76)
- A title out for streaming (subscription, free, ads, rent or buy) in ANY main market now gets the tag at once, whichever country you are in. The India-first rule for rent / buy and the second look for a title first seen abroad are gone.
- New releases (within 14 days) are rechecked every 3 hours, not 12.
- A film in cinemas AND streaming shows "Available to stream" (list and calendar), not "In cinemas".
- The tag text "OTT released" is now "Available to stream".
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v122.

## Person page: Gemini as the last fallback (v75)
- Order: TMDB -> Wikidata -> Gemini. Gemini is asked only when the person still has fewer than 15 titles in their main job (Composer for a composer ...).
- Gemini only names titles. The `similar` function checks each one on TMDB (name and year must match) before it is sent, so an invented film never shows; rows say "from Gemini". Saved 30 days in similar_cache (key person:v1:<id>).
- **Deploy the function first:** `supabase functions deploy similar --project-ref avbhykskutojxgesacxo --no-verify-jwt` (uses the existing GEMINI_API_KEY). Then `npm run deploy`, hard-reload twice. Service worker wl-v121.

## Person page lists the person's own work (v74)
- **Bug:** tapping a composer (Govind Vasantha, Anirudh) showed only a few titles: the page kept TMDB's acting and directing credits and threw the music credits away. It also listed TV appearances (concerts, specials) as "Actor".
- **Fix:** TMDB crew credits by the person's main department (Composer, Cinematographer, Editor, Writer, Producer); TV appearances are no longer listed for people who are not actors; Wikidata also reads those roles and ignores roles that do not fit the department; the chips (Acting, Music, Directing ...) show every role the person has.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v120.

## Grouped calendar row: tag on its own line (v73)
- On a phone the tag of a grouped row wrapped under the text with a small indent. It is now on its own line, flush left, and the open / close arrow is a bit bigger.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v119.

## Calendar groups a day's episodes of one series (v72)
- A season that drops at once (The Greatest, 8 episodes) was 8 rows. Same series + season + day is now one row: "S1 E1-E8 · 8 episodes", with the Series premiere / Finale tags.
- Tap the row to open the single episodes. The tick on the group marks all of them watched (Progress becomes the last episode; Undo works). A weekly show is unchanged.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v118.

## Series capsule no longer says "No OTT release yet" for a show that is out (v71)
- **Bug:** The Greatest (all episodes on Prime Video since 4 Nov) showed "No OTT release yet" in the list while the details popup was already right. The capsule waited for JustWatch only.
- **Fix:** same order as films: 1) TMDB (first episode date has passed and the network is a streaming service) -> 2) JustWatch -> 3) Wikidata. Titles still waiting get one fresh check right after this update.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v117.

## Films that go straight to streaming (v70)
- **Bug:** a film released straight on a streaming service (never in cinemas) showed "In cinemas" until JustWatch listed it.
- **Order of sources:** 1) TMDB's own release dates (never in cinemas + digital date passed in a main market; or digital date passed in India) -> 2) JustWatch listing, as before -> 3) Wikidata, last: a film with no cinema release whose original broadcaster is a streaming service.
- The tmdb-proxy now allows `release_dates`. Deploy it first: `supabase functions deploy tmdb-proxy --project-ref avbhykskutojxgesacxo --no-verify-jwt`. An old proxy still works (the app falls back to the old request).
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v116.

## First season says "Premieres" (v69)
- A show's first episode was labelled "Next season". It now reads "Premieres" (later seasons still say "Next season", mid-season says "Next episode").
- Last safety net for a premiere that is already out: if TMDB has no season size, Wikidata is asked for the real episode count (a lower bound of 1 no longer stays).
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v115.

## New release no longer stuck on "0 episodes aired" (v68)
- **Bug:** a series that had just premiered (e.g. The Greatest, all 8 episodes out on 4 Nov) kept showing "Next season S1 E1 · 4 Nov", "0 episodes aired" because TMDB had not updated its next-episode date, and the app trusted it.
- **Fix:** a next-episode date that has passed now counts as aired (first episode of a season = the whole season is out). JustWatch (where-to-watch) is a second signal: if the title is streaming, a premiere dated within 3 days also counts, and a show with no counts at all shows "Streaming now".
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v114.

## Slot machine icon redrawn to match the calendar (v58)
- Same rounded box, divider line and line weight as the calendar icon: three reels with a coin in each, and a coin slot below.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v113.

## Discover country stays where you put it (v57)
- **Bug:** while the first (automatic) country answer was still loading, picking another country could be overwritten by it, so you ended up on the wrong country's titles. An answer for a country you have since left is now dropped, and the new one is asked for at once (a recent failure no longer blocks a new pick).
- **Automatic country:** it used the browser language first, so an English (UK) browser outside the UK got United Kingdom. It now uses the device time zone first (e.g. Asia/Kolkata gives India), then the language.
- The country list is now alphabetical, with the chosen one selected, instead of the chosen one pinned to the top.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v112.

## Slot machine icon for "What to watch tonight" (v56)
- The shuffle icon in To watch is now a slot machine (three reels and a lever), same size and line as the other icons.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v111.

## Shuffle icon for "What to watch tonight" (v55)
- The dice in To watch is now a shuffle icon (two crossing arrows), same size and line as the other icons.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v110.

## Icons smaller (v54)
- All icons and the "Notify me" checkbox are now 13 px (were 16 px), with a 1.5 px line. One setting, `--ico` in styles.css, sizes them all together.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v109.

## Every icon the same size and line (v53)
- All icons are now drawn the same way: a 16 px box and a 1.6 px line that does not scale with the drawing. Covers the dice, calendar, search, menu (three lines), three dots, similar-titles sparkle, cloud, sync and the episode tick. The calendar was being drawn larger by a separate CSS rule (21 px, 28 px on phone); that rule is gone. The "Notify me on release days" checkbox is the same 16 px.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v108.

## Calendar icon weight (v52)
- The calendar icon has more lines than the search icon, so it looked heavier at the same stroke. Its line is now thinner (1.6 instead of 2) so the two read as the same weight.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v107.

## Header icons and the release-days checkbox match (v51)
- The dice, calendar and search icons are redrawn on the same 16-unit box, so they look the same size (the calendar used to look bigger than the search icon).
- The "Notify me on release days" checkbox is now 16 px, the same size as those icons, on desktop and phone (it was 15 px on desktop and 20 px on phone).
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v106.

## Move my list keeps Watching and progress (v50)
- A title you already had on the other side (even as plain To watch) used to win over the copied one, so its Watching status and Season / Episode progress were lost. Now a copied title replaces yours when it is further along (To watch, then Watching, then Watched), or at the same stage when it was edited more recently. It never moves a title back a stage. The message says how many were added and how many updated.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v105.

## Button styles match in Move my list and the Home Screen guide (v49)
- **Move my list:** Copy my list and Add to my list had no style class, so they showed as plain grey boxes. Copy is now outlined, Add to my list is the filled main action, and Close is outlined, like every other dialog. Same fix for Back up & sync / Move my list in the Home Screen guide and the Close button in About.
- Deploy: `npm run deploy`, hard-reload twice. Service worker wl-v104.

## Company pages show series, new seasons of finished shows (v48)
- **Production company pages** list movies **and series** (All / Movies / Series chips, most popular first, 10 at a time). The chips appear when the company has both.
- **New season of a show you finished:** a series in Watched (with a season saved in Progress) now shows in the Watching calendar as soon as TMDB dates a season after the one you finished ("Season premiere"), and the 9:00 AM release-day alert includes it. Nothing shows for a finished show until a newer season exists. Ticking an episode of it moves it back to Watching.
- Deploy: **the edge function first** (it now allows TMDB `discover/tv`): `npx supabase functions deploy tmdb-proxy --no-verify-jwt`, then `npm run deploy`, hard-reload twice. Service worker wl-v103. Without the edge function, company pages still show movies only.

## Status checked against the real season data, "Airing now" removed (v47)
- **Finished this season** is blocked when the episode is below the season's total (Vampire Diaries S8 E15 of 16), or when the season is still airing. **Finished the show** is blocked on a show that is still ongoing, on a season before the last, or on an episode before the last one. Shows with no counts, or only partial ones, are never blocked. A running show's newest season only warns (TMDB totals lag).
- The message shows under the Status buttons and updates as you type; Save is blocked with it.
- **Airing now** is gone (TMDB already gives the airing tag, and the calendar gives the days). Its day picker and per-show reminder went with it; the calendar's release-day alert stays. A show saved as Airing opens with no status.
- The calendar tick clears an old Finished-season / Finished-show status, since it no longer fits the newer episode.
- Website only: `npm run deploy`, hard-reload twice. Service worker wl-v102.

## Where to watch, tidier (v46)
- No "Where to watch" heading, no service logos, no "Data from JustWatch" under it (the JustWatch credit moved to About, next to the TMDB line). The country picker comes first, with room for its arrow; below it, one plain line per group: Stream, Free, Rent or buy.
- The same service under several names counts once (Prime Video, "with Ads", "Free with Ads"; MX Player, "Amazon MX Player"), and a service shows only in its best group. The "tonight" card uses the same names.
- Website only: `npm run deploy`, hard-reload twice. Service worker wl-v91. Mac and Android need a rebuild. No edge function change.

## What to watch tonight, square tick, alerts first (v45)
- **What to watch tonight:** dice button at the top right of the To watch list (left of the priority filter). First it checks Watching: a series that is still airing with an aired episode you have not ticked comes first ("Catch up first", with Open calendar). Otherwise it picks one title from To watch that is out and watchable (left out: not released, in cinemas, awaiting OTT), weighted by star priority (pinned counts double), no repeats until the list has been seen, with where it streams in your country. Series from To watch are never picked while any series sits in Watching. Pick another / Details are in the card.
- The episode tick in the calendar is a square now. The release-day alert switch is the first thing in the calendar and says **9:00 AM**.
- Website only: `npm run deploy`, then hard-reload twice. Service worker wl-v90. Android and the Mac app need a rebuild. No edge function change since v44.

## Where to watch, release alerts, episode tick-off, studio logos, smaller tags (v44)
- **Smaller tags on phones:** Finale / Between seasons / Awaiting OTT / In cinemas are 10px with slim padding (they were bigger than on desktop).
- **Calendar movies:** the release row says **Out today**, **Out tomorrow** or **In cinemas** (released in the last 7 days) instead of a bare "release".
- **Popups lock the page behind them** (no background scrolling while a card or sheet is open; the scroll position comes back on close).
- **Studio pages show the logo** (light tile; a letter tile when TMDB has none), plus country, headquarters and description when TMDB has them. Needs the edge function below.
- **Where to watch** row at the top of the details card: Stream / Free / Rent-buy chips with logos, for the country you pick (no location permission: saved choice, else India for an Indian time zone, else the device language region, else India). Data from JustWatch via TMDB.
- **Release-day alerts:** switch under the calendar. One notification at 9:00 (or the next time the app is open after that) for what comes out today. Works while the app is open or running; off by default.
- **Episode tick-off:** a tick on every aired episode in the calendar saves it as your Progress (Season / Episode), hides it and the earlier ones, with Undo. Ticking a To watch show moves it to Watching.
- Deploy: **the edge function first** (it now allows TMDB company pages): `npx supabase functions deploy tmdb-proxy --no-verify-jwt`, then `npm run deploy` and hard-reload twice. Service worker wl-v89. Android needs a rebuild. Without the edge function everything still works except the studio logo, which shows the letter tile.

## Tags a bit larger on phones (v43)
- The status tags (Announced, Awaiting OTT, In cinemas, Not released yet, OTT released, Airing weekly...) were the same 11px on phone and desktop. On a phone (screen narrower than 520px) they are now 12.5px with a little more padding and space above, and a long tag wraps instead of running off the screen. Desktop is unchanged.
- Website only: `npm run deploy`, then hard-reload twice. Service worker wl-v88. Android needs a rebuild.

## Calendar shows every episode, "Announced" tag (v42)
- **Calendar:** a show with two episodes a week (like Dar-E-Nijaat on Fri and Sat) now shows **both**. TMDB's "next episode" is only one, so the calendar also reads the whole airing season and lists every dated episode from the last 7 days to the next 30. The next episode is always shown even when it is further away. One extra request per airing series.
- **Announced tag:** a movie TMDB has no release date for (e.g. The Cage, Marco 2) now shows a grey **Announced** tag with a tooltip, instead of nothing. It becomes "Not released yet" / "In cinemas" once TMDB has a date.
- Dates remembered by the previous version are asked again once.
- Deploy: the edge function first (it now allows TMDB season pages): `npx supabase functions deploy tmdb-proxy`, then `npm run deploy` and hard-reload twice. Service worker wl-v87. Without the edge function, the calendar still works but shows only the next episode. Mac / Windows / Android need a rebuild.

## Calendar icon, plain names, popup stacking (v41)
- The List / Calendar buttons are gone. The Watching tab now has a small **calendar icon** next to the search icon; tap it to show the release calendar, tap it again to go back to the list. It stays highlighted while the calendar is on and is remembered on this device. The search icon is hidden while the calendar is showing.
- Cast, crew and production names in the details popup look like normal text again (no dotted underline). They are still tappable and turn orange when you hover.
- **Fix:** a person or production page now opens **on top of** the details popup. It used to open behind it, so you had to close the popup first.
- Website only: `npm run deploy`, then hard-reload twice. Service worker wl-v86. Mac / Windows / Android need a rebuild.

## Release calendar in Watching (v40)
- The Watching tab has a **List / Calendar** switch (remembered on this device). Calendar is one simple agenda: **Today, Tomorrow, This week, Later, Just released** (last 7 days).
- It shows the next episode of every series in Watching and To watch ("S2 E5"), and the release date of every movie in To watch. Series that have a next episode dated, or a season about to start, appear; ended series and movies released more than a week ago do not.
- **Tags** from TMDB's own episode data: **Series premiere**, **Season premiere**, **Finale**, **Mid-season finale**. A finale is only tagged when TMDB marks it as one.
- Tap a row to open the title's details. Dates are asked from TMDB one title at a time (about 1 per second) and remembered for a few hours, so reopening is instant. First open with many titles takes a few seconds to fill in.
- No alerts: a web app cannot send them reliably when it is closed. Release dates can still move.
- Website only: `npm run deploy`, then hard-reload twice. Service worker wl-v85. Mac / Windows / Android need a rebuild. No edge function change (this version).

## Production company pages (v39)
- The **Production** names in the details popup are tappable too. A company page lists its movies, most popular first, **10 at a time**: "Load more" shows the next 10 (TMDB is asked for the next batch only when needed). Each row has Add / "On your list". Nothing else on the page (no bio, no filters).
- Movies only. TV networks (Netflix, HBO and so on) are not linked. A company name TMDB gives no id for stays plain text.
- Deploy: the edge function again (it now allows TMDB `discover/movie` for one company): `npx supabase functions deploy tmdb-proxy`, then `npm run deploy` and hard-reload twice. Service worker wl-v84. Mac / Windows / Android need a rebuild.

## Cast & Crew pages (v38)
- In the title details popup, every name (Director / Created by, Music, Cinematography, Editor, Starring) is now tappable. It opens that person's page: photo, short bio and their films and series, newest first, upcoming first.
- Filter chips: All, Movies, Series, and Acting / Directing when the person has both. Each row has **Add** (goes to To watch, medium priority, at the end of the list) or "On your list". Talk-show and "Self" appearances are left out.
- **Wikidata fills the gaps:** TMDB's list is shown first, then Wikidata is asked for more (it often knows regional films TMDB lacks). Extra titles are marked "from Wikidata" and have no poster. Only Wikidata titles that have a TMDB id are shown, so every row can be added. If TMDB has no bio, Wikidata's one-line description is shown.
- Names found only through Wikidata (no TMDB person id) stay plain text.
- **Deploy two things:** the edge function (it now allows TMDB person pages): `npx supabase functions deploy tmdb-proxy`, then the website: `npm run deploy`, then hard-reload twice. Service worker wl-v83. Mac / Windows / Android need a rebuild. Until the edge function is redeployed, person pages say "Could not load this page".

## Details popup: Music, Cinematography, Editor (v37)
- The title details popup now has **Music** (composer), **Cinematography** (director of photography) and **Editor**, placed after Director and before Production.
- Names come from TMDB's crew list. Anything TMDB does not have is asked from Wikidata. A row that neither knows is not shown, so there are no empty rows. Up to 2 names per row; sound / dialogue editors are not counted as the editor.
- Works for movies and series. A failed lookup just leaves the rows out. Loaded in the same moment as the other details and remembered until the app is closed.
- App files only (no edge function change): `npm run deploy`, then hard-reload twice. Service worker wl-v82. Mac / Windows / Android need a rebuild to get it.

## To watch order and OTT tags (v36)
- **Order added:** a new title (movie or series) now goes to the end of the list, so To watch shows titles in the order you added them. Before, it was slotted in by priority, which could put a new movie above an older series. Drag or Move up / down still changes the order.
- **Out of cinemas:** a released film with no streaming listing shows **In cinemas** for its first 45 days, then **Awaiting OTT** (purple), instead of nothing.
- **Rent / buy abroad no longer counts as OTT:** a store rental in the US (premium VOD) used to mark a film "already streaming", and such films got no tag. Rent / buy now only counts in India. Subscription, free and ad-supported listings still count in every main market.
- Saved OTT answers are dropped once and asked again.
- Website only: `npm run deploy`, then hard-reload twice. Service worker wl-v81. Mac / Windows / Android need a rebuild to get it.

## Server-rendered title pages (v35)
- Share links (`/m603`, `/t1396`) are now real server-rendered pages (Cloudflare Worker): poster, title, year, runtime or seasons, rating, genres, tagline and overview are in the HTML itself, no script needed. Before, the page was empty and redirected at once.
- Added schema.org JSON-LD (Movie / TVSeries) and a proper description. Link previews (WhatsApp, Telegram, iMessage) are unchanged.
- People's browsers are still sent straight on to the app, as before (one line of script). Link-preview bots, crawlers and visitors without JavaScript see the full page, which has an "Add to my list" button and an "Open without adding" link.
- Still `noindex`. Remove that line in `worker/index.js` only if you want these pages in search results.
- Cached for a day per title; cache key bumped (v3) so old preview pages are replaced.
- Deploy: `npm run deploy` (the worker is part of it). Edge function and app files unchanged.

## Airing shows: episode check now blocks (v33)
- On a show that is still airing, an episode above what has aired is now **blocked** (red hint, Save refused): "Only 6 episodes of Season 1 have aired. Pick 1 to 6." Before it only warned. A season that has not started airing says so. The placeholder shows the aired range.
- Works even when the season box is left empty, if the show has one known season.
- A value saved earlier that is already too high (e.g. Episode 8 when 6 have aired) is only flagged in amber, so you can still change the time or other fields.
- Based on TMDB's aired count (from the next episode). If TMDB is behind, the check follows TMDB.
- Website only: `npm run deploy`. Service worker wl-v80.

## OTT check, sturdier (v32)
- **Missing release date:** a listing only in small countries no longer counts when TMDB has no release date. The date is filled in (TMDB, or Wikidata) and the next check decides.
- **Second look for young titles:** a title under 45 days old that shows up for the first time outside India (e.g. a US rent listing) is checked again about an hour later (when the app is open) before it turns into "OTT released". A listing in India still counts at once.
- **Clearer reason:** the saved reason now picks subscription first, then India, then the other main markets, then small countries (before, it could name Andorra even when India also listed the title). It is on the green tag's tooltip.
- The blue **In cinemas** tag now has a tooltip too.
- Answers from the previous check are dropped once and asked again.
- Deploy: website only, `npm run deploy` (the edge function is not changed). Service worker wl-v79.

## OTT tag on To watch (v29)
- **Bad streaming data in small countries.** TMDB listed Jailer 2 on Sun NXT in Andorra, Albania, Malta and others while it was still in cinemas. Now a listing in a main market (India, US, UK, Gulf, Singapore, Australia, Europe's big ones, and a few more) counts at once, and a listing only in other countries counts once the title is 45 days old. Saved answers are asked again once.
- **Search** also reads page 2 and the movie / series searches, and puts titles named exactly as typed first, so a brand-new title (e.g. Titans 2026) is no longer hidden behind popular ones. Deploy the edge function again.
- **Airing series show progress only** ("Airing weekly · S1: 27 episodes aired"), never a total: TMDB's season totals are often out of date. The details card does the same for the running season.
- Answers saved by earlier versions of the OTT check are dropped once and asked again (a wrong "already streaming" answer could stay forever). The reason a title counted as available is saved with it (hover the green tag).
- The details card row now says **Next season** (not "Next episode") when the next thing to come is a season premiere or the running season has fully aired, e.g. "Next season: Not announced yet". While a season is still airing it stays "Next episode".
- Each To watch title shows a small tag. While a recent title is on no streaming service anywhere it says **No OTT release yet**; when it reaches a service in any country (subscription, free, ad-supported, rent or buy) it turns into a green **OTT released** tag for 30 days, and a message pops up if the app is open.
- A title whose release date is still in the future shows an amber **Not released yet** tag instead (the date comes from TMDB). Once the date passes and it is still not streaming, a movie shows a blue **In cinemas** tag (for about 5 months after release; a series or an older title shows "No OTT release yet"). When it reaches OTT the tag becomes **OTT released**.
- **Series that are still airing** get their own tag, shown whatever the OTT state: orange **Airing weekly · S4: 3 of 10 aired** when episodes come about 7 days apart, blue **Ongoing · S4: 3 of 10 aired** otherwise, **S5 starts 14 Jan** when the next season is dated, and **Between seasons** when it is not. Rechecked every 12 hours, so the count moves as episodes air. Ended or cancelled series use the movie rules.
- **Wikidata** is a third source, used only when TMDB says "not streaming" (and at most every 3 days per title). It fills in a missing release date, and counts a title as OTT when Wikidata lists a streaming service (Netflix, Prime Video, Disney+, Hotstar, HBO / Max, Apple TV+ and others) as its broadcaster or distributor and the date has passed (a film needs 30 days). A film is no longer judged by its distributor (that is often just the company that bought the OTT rights, not proof it is streaming); only a series' original broadcaster counts. It cannot give weekly schedules, so the airing tags are TMDB only.
- Faster: the check starts at once, asks TMDB for details and streaming in ONE request, and shows each tag as soon as it is known. Deploy the edge function again for this (an older one still works, just slower).
- Titles that were already streaming when first checked (e.g. when you add them) never get a tag. Only titles added before their OTT release do.
- Rent / buy counts as a digital release too. "No OTT release yet" is hidden for titles older than last year.
- Checked when the app opens or comes back to the front, at most once every 12 hours per title. The state syncs with the rest of the list.
- **Deploy the edge function again** (`supabase functions deploy tmdb-proxy --no-verify-jwt`): it now allows `/watch/providers`. Without it the tag simply stays empty.
- Service worker wl-v78.

## Sharper posters (v28)
- List tiles, search results, collection parts and Discover rows now pick the poster size by screen: a 3x phone gets w185 / w342, a plain desktop screen w92 / w154. Before, the list used w185 and search used w92 for everyone, which looked soft on phones.
- Only what the screen needs is downloaded, so it stays light. Offline copies saved by the Mac / Windows / Android apps are unchanged.
- Service worker wl-v77.

## Progress sheet: season / episode check (v27)
- Uses the TMDB season info (Wikidata as fallback), the same as the details card. Placeholders show the real range, e.g. `1-5` and `1-7`.
- Ended / cancelled show with counts: a wrong season or episode shows a red hint under the field and blocks Save (S1 E10 on a 7-episode season, season 6 of 5).
- Ongoing show: older seasons are checked the same way; the newest season and anything beyond it only warn (amber, "Latest known is S4 E6. Saving anyway.").
- No counts: nothing is checked. Only a season total: season is checked. Only an episode total: a higher episode only warns. Only the last aired episode known: warns only.
- Season or episode alone is allowed. Minimum is 1, minutes 0 to 59 as before.
- Service worker wl-v76.

## Seasons: ongoing shows, missing data, Wikidata (v26)
- Ongoing series: the summary counts only what has aired. Example: `3 seasons · 21 of 24 episodes aired · Ongoing`. The + shows `S3: 5 of 8 aired`. A new **Next episode** row shows `S3 E6 · 14 Nov`, or "Not announced yet" while the show is between seasons.
- A series TMDB has no season data for (some anime, brand-new shows) now shows `Seasons: Not listed on TMDB or Wikidata yet` instead of nothing. If TMDB has only the status, you still get `Episodes not listed yet · Upcoming`. If TMDB has no season list but knows the last aired episode, that is used.
- If the lookup fails (offline, TMDB busy), the row says so and opening the card again retries; before, the empty answer was remembered until the app was closed.
- Statuses: Ongoing, Pilot, Upcoming, Ended, Cancelled. The shared-link screen uses the same wording.
- If TMDB has no season or episode numbers, the app now asks **Wikidata** (found by the TMDB id; no new permission needed). It gives the season and episode counts, marked "(Wikidata)", and Ended when Wikidata has an end date. No per-season list or next episode from there. If both are empty the row says "Not listed on TMDB or Wikidata yet".
- Service worker wl-v74.

## Share a title (v24)
- Every title with TMDB details has **Share**: in its ••• menu and on its details card (also from Discover). On phones it opens the normal share sheet (WhatsApp, Instagram, anywhere). Where there is no share sheet (computers, Mac / Windows / Android apps) it copies the link.
- Phones never copy: iPhone and Android browsers open the phone's share sheet, and the Android app does too (new plugin `@capacitor/share`: run `npm install` once, then `npm run build:android`). Copying is only the fallback if the share sheet fails, and what the Mac / Windows apps and computers do.
- The link is short: `your-site/m603` for a movie, `your-site/t1396` for a series (the TMDB number after one letter).
- In WhatsApp, iMessage, Telegram and similar apps the link shows a small card with the poster, the title and year, genres and rating.
- Tapping it opens the app on a screen with the poster, a short summary and one big **Add to my list** button. One tap adds it to To watch with Medium priority and the note "Recommended by a friend"; the message after adding has an **Edit** button. If the title is already in the list, the button says **Open my list**.
- It cannot add on its own: with no login the app has no way to put a title into someone's list unless they open it. One tap is the closest possible.
- Without the app, the link opens the web version, so it works for anyone.
- Deploy (Cloudflare **Workers**, not the drag-and-drop uploader, which cannot run the share worker):
  1. Open `wrangler.jsonc` and set `"name"` to your existing Worker's name (Cloudflare dashboard -> Workers & Pages), so it updates that site.
  2. Terminal in this folder: `npx wrangler login` (once), then `npm run deploy`. It builds `web/` and uploads the site and the worker together.
  The worker is `worker/index.js`; the Supabase address comes from config.js through wrangler.jsonc.
- Mac / Windows / Android apps: set `SHARE_BASE` in config.js to your website address. Empty = they share a themoviedb.org link instead.
- Installed web app (Home Screen) updates itself: the new version is saved in the background and the app refreshes only while it is in the background, so opening never stutters. The first time, close and reopen the app twice so it picks up this change.
- Saved poster pictures now survive app updates (before, every update cleared them and all posters downloaded again, which made thumbnails slow).
- Discover is faster: posters are smaller (342 px on phones, not 500-780) and load only when a card is near the screen (lazy). Saved posters keep up to 700 pictures.
- Series (and anime) show how many seasons and episodes they have, plus Ongoing / Ended: a **Seasons** row in the details card (the + opens the episodes of each season) and on the shared-link screen. Specials are not counted. Data from TMDB.
- Service worker wl-v72.

## Review fixes (v22-v23)
- Landscape phone: the header, banner and search filled the whole screen and the list had 0px of height. The page now scrolls in landscape too, with a tighter header and sticky tabs (styles.css).
- "Priority: All" was drawn twice on tablets, landscape phones and desktop (the phone-only label was never hidden elsewhere). Fixed.
- iPad and landscape phones: the search box was 15px, so iOS zoomed in when you tapped it. All text boxes (search, forms, "report a missing title") are now 16px on touch screens, and the Priority and country menus use the same invisible-menu trick as on phones.
- Priority filter is back on phones (the first v22 fix hid its label on phones by mistake). It is now hidden only above 520px wide on mouse screens.
- Service worker wl-v67. Run `npm run build:web` to refresh the web/ folder.

## Fixes and Android reminders (v21)
- GitHub link is now shibil001 everywhere (About box, download page, package.json, and the allowed-link check in main.js). The "Buy me a coffee" link is text only.
- iPhone: the "Remind at" time box no longer sticks out of the sheet (styles.css).
- Download page: iPhone and iPad now see "Open the app" with Add to Home Screen steps instead of the Android download (site/downloads.js).
- Android app: "Remind me" now schedules weekly notifications that fire even with the app closed (Capacitor Local Notifications). Run `npm install` once, then `npm run build:android`. The Mac, Windows and web versions still remind only while the app is open.
- New script: `npm run build:all` builds Mac, Windows and Android one after another.
- Pin to top: a title's menu (To watch and Watching) has Pin to top / Unpin. Up to 3 pinned titles per tab, always shown first with a small pin icon. Pins are synced with your account. A pinned title loses its pin when it moves to another tab. Move up / Move down and drag stay inside the pinned group or the rest.
- Search in Watching: a search icon at the right of the TITLE row (Watching tab only) opens a box that filters the list by title as you type. It clears when you leave the tab, and reordering is off while a search is active.
- Service worker wl-v66.

## Full review fixes (v20)
- Admin dashboard (`/check/`): wrong logins were never counted, because the error rolled back the log entry, so the 5-tries lock never triggered. `admin_stats` now returns the error instead. Run `supabase/usage.sql` again once in the SQL editor (safe to repeat); `check/admin.js` handles the new answer.
- The app no longer shows a blank page when the browser blocks storage (Safari "Block all cookies", some in-app browsers): the first two storage reads at start-up are guarded. Removing a TMDB key is guarded too.
- Service worker wl-v49.

## Phone layout + Discover (v5)
- Phones (up to 520px wide, e.g. iPhone 13 Pro 390x844): the whole page scrolls instead of a small inner list, so Discover gets the full screen. The five tabs stay on one row and stick to the top.
- Discover carousels run edge to edge, cards are sized so the next one peeks in, and the x / + To watch buttons are 40px tall and line up.
- Fixes: sheets (details, add, progress) are fixed to the screen so they open in view even when the page is scrolled; the country menu and the priority filter no longer make iOS zoom the page; the Discover hint no longer says "five picks" (it is 20).
- Service worker wl-v48.


## Discover: Picked for you shows 20 (v4)
- Picked for you shows 20 titles to scroll through (was 6), drawn from a pool of 100 (was 60). Same rules: half in your main language, a better taste match is likelier, crossed-out titles never come back, a new draw every 24 hours (yesterday's sit out), and an added or crossed-out title is replaced at once. To change the number, edit `DISC_SHOW` in renderer.js.
- Redeploy `discover`. Service worker wl-v47.

## Discover: Global trending (v3)
- "Trending now" is renamed **Global trending**. It no longer has the Indian regional-language lists (Hindi, Malayalam, Tamil, Telugu, Kannada); those stay in **Trending in <country>**. It is worldwide trending plus Korean, Japanese, Spanish, French, Turkish, Arabic, Thai, Chinese, German and Portuguese.
- Reality, talk, game, news and soap shows (WWE NXT, Indian Idol, Koffee with Karan, Anupamaa ...) are left out of both trending rows. Scripted series stay. For films only, set `SHOW_SERIES = false` in `supabase/functions/discover/index.ts` and redeploy.
- Gemini is asked for films and scripted series only, and for the worldwide row only titles people in many countries are watching. Redeploy `discover`. Service worker wl-v46.

## Discover: trending v2 (more cards, all languages, real "being watched now" signals)
- **Trending now** and **Trending in <country>** show up to 30 cards (was 10 and 12); scroll sideways for more.
- **Trending now** is a worldwide mix: taken one rank at a time from Gemini (live Google Search), TMDB trending films and series, and TMDB's most popular films and series in 15 languages (Hindi, Malayalam, Tamil, Telugu, Kannada, Korean, Japanese, Spanish, French, Turkish, Arabic, Thai, Chinese, German, Portuguese). Not only English.
- **Trending in <country>**: Gemini asked with live Google Search what people there search and watch this week (each title checked on TMDB by name and year), plus TMDB popularity in the country's languages, what is in cinemas, what is popular on streaming there, and titles people in that country added this week. Cards say why: "Searched this week", "In cinemas", "Popular on streaming", "Added this week", "New and popular".
- Gemini needs the `GEMINI_API_KEY` secret (already used by Discover); without it TMDB and the adds still work. Wikipedia page views were not used: they cannot be matched to films reliably.
- Answers are saved for everyone for 3 to 6 hours in `discover_trend_cache` (run `supabase/discover_region.sql` again, safe to repeat), so Gemini is called a few times a day, not on every open. Redeploy `discover`. Service worker wl-v45.

## Discover: new section "Trending in <country>"
- Sits between **Picked for you** and **Trending now**. Shows up to 12 titles for the person's country: what is in cinemas there, new films and series that are popular there (in that country's languages), and titles people in that country added to a list in the last 7 days.
- Country: the person's own choice (small menu on the section, kept on the device), else the request's country (Cloudflare `cf-ipcountry`, the same header the usage stats use), else the device language region (en-IN gives IN). A VPN changes the detected country; the menu fixes that.
- Google Trends / "most searched on Google" is not used: it has no official API.
- Every title added to a list sends one anonymous count (title + country + day, no user, no device). New table `discover_region_adds` (run `supabase/discover_region.sql` once). Without it the section still works from TMDB only.
- Languages per country live in `REGION_LANGS` at the top of the regional part in `discover/index.ts`. Redeploy `discover`. Service worker wl-v44.

## Similar: more results in "Strong matches in other languages"
- Shows up to 12 (was 8). Looks wider: 8 titles per language (was 5), 60 candidates (was 40), the best 20 read closely (was 14).
- Slightly looser bars: rating 6.8 (was 7.0), tone match 0.4 (was 0.5), evidence of likeness story 0.3 / vibe 0.4 / subject 0.15 / theme 0.45 (were 0.4 / 0.5 / 0.2 / 0.5). The strong-match test, the core-theme test and the genre test stay, so weak picks still do not get in.
- The world part is saved under a new key (`:world2`), so every title's world section rebuilds once. Redeploy `similar` (index.ts, logic.ts).

## Similar: embeddings are now OFF unless switched on (suspected cause of the HTTP 546)
- Trace showed steps 1 to 7 fine (15 MB, under 3 s) and the kill in step 8, the second pass, where the gte-small embedding model runs over ~37 titles. Loading and running it needs more compute than a small project's function gets.
- `SIMILAR_EMBED` must now be `on` to use it (before: on unless `off`, which silently did nothing when the secret was set on another project). Without it the word-overlap + theme + mood scoring runs alone, as before v20.
- Tracer: step 1 says whether the model is ON; extra stops 10 (plot words), 11 (embeddings), 12 (review feel) inside the second pass.

## Similar: step tracer to find what an HTTP 546 kills
- All three parts still gave 546 within 7 to 13 s, so the cost is in the steps they share (candidates, details, first scoring pass).
- `?type=movie&id=<id>&debug=1&stop=N` builds only up to step N (1 seed, 2 candidate lists, 3 neighbour lists, 4 details, 5 first pass, 6 fill from other languages, 7 Wikipedia + reviews read, 8 second pass scored, 9 ratings) and returns `trace`: time and memory after each step. The same lines go to the function logs as `[similar] ...`.

## Similar: the list is built in 3 parts (fix for HTTP 546 that lite mode did not cure)
- Test showed HTTP 546 even with `lite=1`. Reason: one request built three sections (the list, other languages, series/films) and for a regional film like Premam also looked in neighbouring languages. That is 200+ titles fetched, scored and read, far over the ~2 s CPU a request may use.
- Now `?part=main`, `?part=world`, `?part=cross`: each is its own request with its own CPU budget and its own saved result (`similar_cache` key `v21:kind:id:main|world|cross`). The app asks for all three at once and merges them (a failed part is left out, the rest still shows).
- The world and cross parts read only 8 titles of the main list closely, and skip OMDb. `buildLimited` is 30 builds per 10 minutes per IP (a title = 3 builds). Learning from ticks reads all parts.
- Redeploy `similar`; service worker wl-v38.

## Similar: fix for HTTP 546 (function killed for using too much CPU)
- 546 is Supabase's WORKER_LIMIT: one request may use about 2 s of CPU. A first build read 130 titles in full and 60 Wikipedia pages + 12 reviews each, then ran many text passes over all of it.
- Lighter by default: 90 titles in full (was 130), 36 read closely (was 60), 8 reviews of 600 characters (was 12 of 900).
- New **lite** mode (50 titles, 14 read closely): the app asks for it by itself (`&lite=1`) when it gets a 546. To force it for everyone: `supabase secrets set SIMILAR_LITE=on`.
- Saved Wikipedia / review text is reused, so the next build of other titles is cheaper. Redeploy `similar`; service worker wl-v37.

## Discover: "Could not load Discover" now says why
- The message always blamed the internet. Now it names the cause: function not deployed (404), request refused (401/403), server error (5xx: TMDB_API_KEY secret or discover.sql missing), offline, or no connection to the function. The reason is also logged to the browser console.
- Deploy if needed: `supabase functions deploy discover --no-verify-jwt`, secret `TMDB_API_KEY`, and run `supabase/discover.sql` once.

## Similar: fix for "Smart matching did not answer (no answer)"
- Cause: a first build of a list has no time limit. When it ran past the platform limit the gateway cut it off with an answer that has no CORS headers, so the browser saw "no answer" and the app fell back to TMDB's plain list (no match %, no "Strong matches in other languages").
- Server (`similar/index.ts`): a request waits at most 100 s; the build keeps running in the background and saves its list; the answer is 503 `{building:true}` with CORS headers. Two opens of the same title share one build.
- App (`renderer.js`): on 503 "building" it asks again (every 4 s, up to 4 more times) before falling back; the fallback message now says "timed out" or "no connection ... is it deployed?" instead of "no answer".
- Redeploy: `supabase functions deploy similar --no-verify-jwt` (index.ts, logic.ts, theme.ts, profile.ts, embed.ts). `SIMILAR_EMBED=off` can stay while testing.


## Similar: fix for English-only lists with no world section
- Symptom: a Tamil film (96) showed English Christmas films with no match % and no "other languages" part. That is the app's plain TMDB fallback: the `similar` function did not answer.
- Server: embeddings are lighter (only the best 40 titles, 8 second budget) and can be switched off without a deploy: `supabase secrets set SIMILAR_EMBED=off`. If a rebuild fails, a saved list from an older version (v20, v19, v18)
  is served instead of nothing. The real error is now logged (`console.error`) and returned as `detail`.
- App: the plain fallback now puts the original's own language first, and the panel says why it is showing a basic list (HTTP code), instead of failing silently.
- Cache v21 stays: every list rebuilds once (8 builds per 10 minutes per IP are allowed, so open a few titles at a time).

## Similar: ideas from three open-source recommenders (inboxpraveen, VivekaAryan, MovieFind), written our own way
- **Two-word phrases** in the plot-text match (TF-IDF): "first love", "small town" ... now count, not only single words. (inboxpraveen uses 1-2 word grams.) Cache v21.
- **Quality test**: `node scripts/eval-similar.js` asks the deployed function for a few films and checks titles that should / should not be in the list (VivekaAryan has a small hit-rate harness like this).
  Edit the CASES at the top to your taste, run it after every scoring change. Premalu must not list All We Imagine as Light.
- Looked at and not taken: the 70% similarity / 20% rating / 10% popularity blend (our quality signal is already small on purpose), studio weighting (our title data has no studios yet), and pickled similarity matrices (MovieFind).

## Similar: meaning match (embeddings) for better suggestions
- Idea from open-source recommenders (e.g. trekomend): each title becomes ONE text (title, year, genres, language, plot, keywords, Wikipedia plot start) and is turned into a vector by a small
  model (gte-small) that runs inside Supabase Edge Functions: no API key, no cost. Popularity and votes are not in the text.
- The cosine between the original and each candidate now makes up 65% of the "story" score (the old word-overlap score keeps 35%). A quiet drama and a playful romcom share words, not meaning.
- A title that is not a strong match (under 55%) is dropped when its meaning match is weak. Vectors are saved per title in `similar_raw` (key `emb1:`), so a title is embedded once.
- If the model is not available, the old scoring runs alone. New file `supabase/functions/similar/embed.ts` (deploy it with index.ts, logic.ts, theme.ts, profile.ts). Cache v20: every list rebuilds.

## Discover tab (after Collections)
- New tab **Discover** with three parts: **Picked for you** (5 titles a day), **Trending for you** (this week's trending, ranked by your taste) and **Trending now**.
- **Picked for you**: the taste profile is the titles you WATCHED (latest 12: genres, languages, era, what TMDB recommends after them). Five titles are drawn at random from a pool of
  60 that fit it (any title, any language that fits), and a new five comes every 24 hours (yesterday's five sit out). A pick can be added with +, or crossed out with × (never shown again on this device).
  Opening a tile shows the same details popup as To watch.
- **Learning**: titles you add from Discover become lighter taste seeds; titles shown again and again without being added come up less; the server counts what was shown and what was added for
  EVERYONE (table `discover_votes`), so titles many people add rank higher for all. Only keys and counts are stored.
- New Edge Function `supabase/functions/discover/index.ts` and `supabase/discover.sql` (run once). Deploy: `supabase functions deploy discover --no-verify-jwt`. Service worker wl-v35.

## Similar: lower bar (40% match), more results
- Nothing under 40% match is shown any more, and anything 40% or more can now appear (before, the hidden score bar cut some 40-50% titles).
- Shows 15 at a time (was 10); "Show more" adds up to 15 more (30 at most, was 20). Server keeps 60 per list (was 50).
- Score bars per language tier lowered a little (0.30 / 0.32 / 0.36 / 0.46), and the push-down for "half agree" titles is smaller (0.2, was 0.35).
- Cache v19 (every list rebuilds). Redeploy `similar` (index.ts, logic.ts, profile.ts) and update renderer.js. Service worker wl-v35.

## Similar: fix for "too few results", and a balanced mix
- Problem: the strong-match test was too strict for titles with little text (Premam showed nothing, Walter Mitty one title). Regional films have almost no Wikipedia text or reviews, so most angles were
  "unknown" and every title was pushed down.
- Now three outcomes: strong (no push-down), cannot be judged or half agree (small push-down, 0.35), clear disagreement (the big push-down, 0.9). Fewer angles needed (40% of the known ones, at least 2),
  an angle agrees from 0.55 (was 0.62), core theme from 0.35 (was 0.5). Titles with too little text are judged on subject alone.
- Genres now give every title a light hint for mood / feel / look (comedy: playful, thriller: tense, romance: swoony ...), so thin titles still have angles to compare.
- The app never shows a near-empty list: if fewer than 10 close matches exist it adds the next best ones above a low floor (0.2).
- Balanced mix: the 10 shown are drawn one at a time, and each title already chosen makes another of the same decade or language a little less likely. Close matches are still likelier.
- Cache v18 (every list rebuilds, which also clears old lists such as the Call Me by Your Name one without match %). Redeploy `similar` (index.ts, profile.ts) and update renderer.js.

## Similar: every title is read from many angles, a match %, and the other kind (series <-> films). Reddit removed
- Reddit is gone (no API access): `reddit.ts`, its secrets, the `reddit` score and the "on Reddit" label are removed. Nothing else needs a key.
- New `supabase/functions/similar/profile.ts`: besides theme and plot, every title now gets five more angles, each read from its TMDB summary and keywords, the
  Wikipedia plot / reception and up to 12 user reviews (plain word rules, no AI):
  MOOD (melancholic, tense, bleak, eerie, warm, playful, sensual, gritty, dreamlike, epic ...), PACE (slow-burn, fast, steady), LOOK / cinematography (lush and painterly,
  noir shadows, neon, handheld, long takes, still frames, standout score ...), FORM (twists, non-linear, ensemble, character study, one place, true story, saga, coming of age ...)
  and FEEL (devastating, thought-provoking, pulse-raising, laugh-out-loud, disturbing, comforting ...). The cinematographer is now compared too, next to director, writer, composer and cast.
- An angle where the ORIGINAL has no signal is left out (not rewarded); a candidate with too little text is never shown as a high match.
- MATCH % and STRONG MATCH: all angles are combined (theme + plot 50%, mood / feel / look / form / pace 40%, people 10%). A title is a strong match only when it has the
  original's core subject and at least 3 angles agree. A title that is not a strong match is pushed down (0.9), so weak lists are cut where they get weak instead of being padded.
  Each row now shows "<language> · 82% match" and the best reasons ("mood · visual style · same director"). Above the list: "This one is: melancholic · slow-burn · lush, painterly images".
- THE OTHER KIND: a film's list gets a section "Series with the same feel", a series' list gets "Films with the same feel" (up to 8). Candidates come from the original's rare keywords,
  core themes, genres (movie and TV genre ids are translated: Action <-> Action & Adventure, Sci-Fi/Fantasy, War ...), language, and Wikipedia "more like this". They are read like the
  rest and must pass the same strong-match test and a score floor. They can be ticked and added like any other title.
- The world-cinema section also needs the strong-match test now.
- New score features (mood, pace, look, form, feel) replace `reddit`; defaults re-balanced (theme .15, story .10, mood .05, feel .04, look .04 ...). Learned weights restart (version 12), cache v17, saved title info i3 (adds runtime and cinematographer).
- About "80% accurate": there is no ground truth for "similar", so the 80% cannot be proven by the code. What is built: a strict test (strong match), a visible match %, and a measurement.
  `similar?type=movie&id=<id>&debug=1` reports `strong: { main, strong, top10, cross }` (how many of the list pass the test) and the scored cross candidates. The real measure is what you
  and other people tick under "Add selected" (stored as the crowd signal): a high tick rate on the first 10 means the list is right.
- Deploy: `supabase functions deploy similar --no-verify-jwt` with index.ts, logic.ts, theme.ts, profile.ts (delete reddit.ts from the function folder). No SQL change. Update `renderer.js`. Service worker wl-v34.

## Similar: a plain-rules THEME matcher (no AI), core-theme gate, theme-based search
- Problem: weak matches got in (Forrest Gump for Call Me by Your Name; mass-action films for Moothon) while closer ones (a gay summer romance, a queer coming-of-age film) were never found.
  Cause: popularity ("people also liked") counted for more than subject, and subject was only raw keyword ids.
- New `supabase/functions/similar/theme.ts`: every title gets a theme profile (about 45 themes: lgbtq, first love, coming of age, crime underworld, heist, prison, brotherhood, music,
  old age ...) read from its TMDB keywords (strong) and plot text (weaker, Wikipedia plot too in the second pass). Two titles are compared on shared themes (recall and precision),
  on the original's 1-2 CORE themes (gate: none of them = 1.2 penalty, partial = 0.4) and on clashing themes (an old-age drama for a teen romance, a heist for a family drama: up to 1.5).
- Candidates are now also searched BY the original's core-theme keywords (best rated first), in the same language and, for the world section, in every language.
- The world section needs the core themes too. Two new features (theme, core) in the score; popularity weights lowered (rec .09->.06, co .08->.05); learned weights restart (version 10).
- Bars: 0.36 / 0.38 / 0.42 / 0.52, floor 12 (was 15), the app shows 0.38 and up (was 0.35): fewer but closer matches. Cache v15. Service worker wl-v32.

## Similar: real reviews and what people pick
- New "crowd" signal: every "Add selected" is counted per original title (shown / ticked, keys only, nothing about a person). A title that people often tick for this original ranks higher;
  one ticked twice or more joins the pool even if no source suggests it now. New feature, so learned weights restart (version 9) and lists rebuild weekly with the latest counts.
- Reviews: up to 12 TMDB user reviews per title are read (was 8) for the vibe and audience-tone signals.
- Run `supabase/similar.sql` again (new table `similar_votes` and function `similar_vote`), redeploy `similar`, update `renderer.js`. Cache v14, service worker wl-v31.

## Similar: Wikipedia and Wikidata now also FIND candidates
- Before, only TMDB suggested titles; Wikipedia / Wikidata / OMDb only helped score them. Now candidates also come from Wikipedia's "more like this" search on the film's article,
  Wikidata films with the same language and a shared genre (best known first), and films by the same director or composer. A title found there counts as one more source.
- OMDb has no "similar titles" call, so it stays a source of IMDb / Rotten Tomatoes scores. Cache v13.

## Similar: other Indian languages, recent titles, debug probe
- A Hindi title now also searches Malayalam, Tamil, Telugu and Kannada (and the other way round): "neighbours" for Hindi are only the northern languages, so the south was never searched on purpose.
- Same-language search now also asks TMDB for the most popular and the most recent (last 5 years) titles in the same genres, and a second page of the top-voted ones, so newer films (a 2025 release) are not left out.
- Debug: `similar?type=movie&id=<id>&debug=1&probe=<tmdb id of a title>` says whether that title was found, kept or dropped, and its scores. Cache v12.

## Similar: softer filtering, more results, new heading
- Lists were too short (Rockstar showed 3) and missed obvious matches (Saiyaara). Softened: tone gap penalty only bites at 0.3+ (2 points only for 0.5+);
  a side genre in common is enough (the main-genre penalty is now 1.0 only when NO genre is shared); extra genres dilute less; plot-story weight up (0.15 -> 0.18).
- Bars lowered: server 0.33 / 0.36 / 0.40 / 0.50 (same language / neighbour / same country / world); the app shows matches of 0.35 or more (was 0.45); lists are topped up to 15.
- The world section is titled "Strong matches in other languages" (the extra "Similar taste from world cinema" heading and subtitle are gone), holds up to 8 and its checks are looser.
- Learned weights restart from the new defaults (weights version 8); cache v11. Redeploy `similar`. Service worker wl-v28.

## Similar: stricter tone, more language neighbours, "Similar taste from world cinema"
- Stricter tone rule: only a CLEAR light/dark gap (gap of 0.5 or more, e.g. slapstick comedy vs dark thriller) now costs 3 points; smaller gaps cost 0.2 to 1.5 (a first, harsher version emptied lists and was softened).
  Tone is also read better: comedy counts as light, romance and music hardly do (Rockstar is both and is dark), and tragic / heartbreak / obsession / addiction count as dark.
- New neighbour circles: Middle East (Arabic, Turkish, Persian, Hebrew), Southeast Asia (Thai, Vietnamese, Indonesian, Malay, Tagalog),
  Slavic (Russian, Ukrainian, Polish, Czech ...), Iberia (Spanish, Portuguese, Catalan, Galician). A language can be in two circles
  (Thai: East Asia + Southeast Asia, Spanish: Iberia + Europe); circles take turns. 4 neighbouring languages are searched (was 3).
- New section under the list: "Similar taste from world cinema" (every title, any language). Up to 6 strong matches in OTHER languages
  (Korean, Japanese, French, Spanish, Hindi, Malayalam, Tamil, Chinese, German, Italian, English). Each needs a 7+ rating, the original's main genres,
  a matching tone and real likeness (plot text, the feel reviewers describe, or rare shared subjects). Weak ones are simply not shown.
- New cache version v10: every list rebuilds once. Redeploy `similar` (index.ts + logic.ts). Service worker wl-v27.

## Similar: stricter, subject-aware
- Shared rare subjects (alien invasion, navy ...) now count more (keyword weight 0.08 -> 0.12, full credit after two); broad genre counts a little less.
- Higher bars: the app shows only matches of 0.45 or more (was 0.4); the server's bars are 0.40 / 0.42 / 0.45 / 0.55 for same language / neighbour / same country / world.
- New cache and weight versions (v7): every list rebuilds once. Redeploy `similar`.

## Main screen and Watched tab
- The TMDB credit line under the list is gone from the main screen (it is still in the menu).
- Watched: the title you marked watched last is first. Titles watched before this update keep their old order below the new ones.

## Similar: "Show 10 more"
- Only close matches are shown: a weak list is cut where it gets weak (7 close matches = 7 shown).
- 10 first, then a "Show 10 more" button (20 at most). When there is nothing more: "That's all the close matches. New picks tomorrow." The extra 10 stay open for the rest of the day.

## Collections tab
- A collection with every part on your list and every part watched moves under a "Completed (N)" row at the bottom (tap + to open). It comes back on its own if a new part appears or a part is not watched.

## Similar taste (more accurate, weekly, 10 a day)
- Tone: how dark / intense a title is (genres, keywords, plot words, age rating A / UA / U) is compared. A comedy or romance is pushed far down for a violent thriller (and the other way round). `violence`, `murder` and `violent` are no longer thrown away as keywords.
- Same director / writer / composer now counts (new `dir` feature).
- Language: same language first. With fewer than 20 good matches, the good ones are kept and the list is filled from neighbouring languages (Malayalam -> Tamil, Telugu, Kannada), then the rest of India, then worldwide; each farther step must score higher to get in.
- The app shows 10 titles and draws a new 10 every 24 hours (same 10 all day; added titles are replaced at once; yesterday's 10 sit out).
- Rough inputs are saved in Supabase (`similar_raw`): TMDB details and lists, Wikipedia + reviews, Wikidata, Trakt. A title is asked about once.
- Lists are rebuilt weekly. After 7 days the saved list is still shown at once and rebuilt in the background.
- Learned weights are kept per language group. New cache key `v6`, so every list is rebuilt once.
- Needs: run `supabase/similar.sql` again, redeploy `similar` (now `index.ts` + `logic.ts`).

## Details popup
- "Read more" / "Show less" under the summary is now the same round + button as after the cast (+ opens, − closes).
- The + after the cast now turns into a − when the full cast is open, and − hides the extra names again.
- Phones: the + / − buttons in the details popup were stuck at 22px (a later rule overrode the touch size). They are now 34px on touch screens.
- Starring shows the first 6 names, then a + that opens the rest of the cast. The + shows whenever more than 6 names are known.
- Short cast lists are topped up: when TMDB knows fewer than 7 names, the `similar` function adds names from OMDb and Wikidata
  (TMDB's order first, each person once). Before, they were used only when TMDB had no cast at all, so a title could show just 3 or 4 names.
  Saved details now use cache key `details:v4`, so old short lists are rebuilt the next time a title is opened.
- Wider on a computer (820px instead of 540px) with more side padding, so a long plot takes fewer lines when opened. Phones and small windows keep the narrow layout.

## Landing page
- The second "Use online" button under the headline is removed; the one in the top bar stays.

## Search
- New `supabase/functions/tmdb-proxy/index.ts` (it was missing from the project, so `supabase functions deploy tmdb-proxy` failed).
- Search no longer needs exact spelling: text is normalised (accents, curly quotes, `&`, spaces, 4/four/IV), and misspelt
  titles are repaired ("interstelar" -> Interstellar). Works with the built-in search (server side, one request) and with a
  personal TMDB key (same repair in the app). Only the "add title" box and the "Report missing title" box use it.
- Service worker version bumped (wl-v15) so installed copies refresh.

## Landing page (site/)
- Android download added right after Windows: https://github.com/shibil001/watchlist/releases/download/v1/watchlist-Android.apk
- Buttons now have real links in the HTML too, so they work without JavaScript.
- Android phones: the Android button is highlighted and Mac/Windows buttons are hidden. iPhone: the top "Use online" button is highlighted.
- Android install help (download warning, "Install unknown apps", Play Protect).

## Bugs fixed
- Phone: the keyboard no longer pops up on app start or after closing a sheet (focus only with a mouse).
- Phone: the top menu could be taller than the screen and cut off items. It now scrolls.
- Phone: pulling down on the list could reload the page (browser pull-to-refresh). Blocked.
- Phone/Android: the Back button now closes the open sheet instead of leaving the app.
- "Remove" deleted a title at once. It now shows an Undo.
- "Too many requests" message on a collection never showed (wrong error check). Fixed.
- Sync: with more than 1000 titles, rows saved together could be skipped between pages. Paging is now stable.
- Text escaping now also covers the single quote.
- Details popup and collection panel heights used vh, which is taller than the visible screen on phones. Now dvh / %.
- Install card and "list can be lost" card no longer stack on a small screen.
- Tap targets enlarged on touch screens; icon-only buttons got accessible names; noscript notice.
- _headers: the app's fonts and icons under /web/ are now cached like the root ones; HSTS added.
- The `related` Edge Function was sitting at the project root: moved to supabase/functions/related/index.ts.
- Service worker version bumped (wl-v14) so installed copies refresh.
- Android build output is now named watchlist-Android.apk to match the release link.
