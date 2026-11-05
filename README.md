# Watchlist

A simple watchlist for movies and series, ranked by how much you want to watch each one.

## Download

Get the latest version from the [Releases page](../../releases/latest):

- **Mac:** `Watchlist-mac.dmg`
- **Windows:** `Watchlist-Portable.exe`
- **Android:** coming soon
- **Web:** use it online in any browser

## Install

**Mac:** open the .dmg and drag Watchlist to Applications. The first time, right-click the app and choose *Open*. Works on Apple Silicon and Intel.

**Windows:** nothing to install. Save the file somewhere you like and double-click it. If Windows says it protected your PC, choose *More info*, then *Run anyway*.

**Phone:** open the web version, then Share → Add to Home Screen (iPhone) or menu → Install app (Android).

## Features

- Rate how much you want each title, then drag to reorder
- Posters and details from TMDB, with franchises and spin-offs
- Notes and progress: remember where you saw it and where you stopped
- Optional sync across devices

## Run from source

```
npm install
npm start          # desktop app
npm run build:mac  # build the Mac app
npm run build:win  # build the Windows app
npm run build:web  # build the website into ./web
```

## Credits

Movie data and posters by [TMDB](https://www.themoviedb.org). This product uses the TMDB API but is not endorsed or certified by TMDB.

Made by [Shibil Rahman](https://github.com/shibil001).
