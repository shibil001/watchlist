// Watchmode (api.watchmode.com): the SECOND source for "where is this title streaming now", asked before Gemini.
// Needs the secret WATCHMODE_API_KEY (npx supabase secrets set WATCHMODE_API_KEY=...). Without it this file does nothing.
// The free plan allows about 1000 calls a month, so every call is counted in the database (api_usage) and stopped at a cap:
//   WATCHMODE_MONTHLY_CAP (default 900) and WATCHMODE_DAILY_CAP (default 50, so one busy day cannot use the month).
import type { Avail } from "./heart.ts";

export const watchmodeOn = () => !!(Deno.env.get("WATCHMODE_API_KEY") || "").trim();

const REGIONS = "IN,US,GB,CA,AU,DE,FR,ES,IT,AE,SG,JP,KR,BR,MX";
const TYPE: Record<string, string> = { sub: "stream", free: "free", rent: "rent", buy: "buy" }; // "tve" (cable login) is left out: not watchable for most people
const RANK: Record<string, number> = { stream: 0, free: 1, rent: 2, buy: 3 };

export type Reserve = (api: string, period: string, n: number, cap: number) => Promise<number>;
export type WmOut = { entries: Avail[]; error?: string };

let pausedUntil = 0; // this instance stops asking after a 401 / 402 / 429 until this time

async function call(path: string, params: Record<string, string>): Promise<Response> {
  const u = new URL("https://api.watchmode.com/v1" + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("apiKey", (Deno.env.get("WATCHMODE_API_KEY") || "").trim()); // Watchmode takes the key in the URL; never log this URL
  return await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
}

export async function askWatchmode(kind: string, tmdbId: number, reserve: Reserve): Promise<WmOut> {
  if (!watchmodeOn()) return { entries: [], error: "no WATCHMODE_API_KEY" };
  if (Date.now() < pausedUntil) return { entries: [], error: "Watchmode is resting" };
  const monthCap = Number(Deno.env.get("WATCHMODE_MONTHLY_CAP")) || 900;
  const dayCap = Number(Deno.env.get("WATCHMODE_DAILY_CAP")) || 50;
  const now = new Date().toISOString();
  const spend = async (): Promise<boolean> => (await reserve("watchmode", now.slice(0, 10), 1, dayCap)) > 0 && (await reserve("watchmode", now.slice(0, 7), 1, monthCap)) > 0;

  const t = kind === "tv" ? "tv" : "movie";
  try {
    if (!(await spend())) return { entries: [], error: "Watchmode quota used up for now" };
    // one call: the title id may be written "movie-<TMDB id>" / "tv-<TMDB id>"
    let r = await call(`/title/${t}-${tmdbId}/sources/`, { regions: REGIONS });
    if (r.status === 404) { // not accepted or not known: look it up by TMDB id (one more call), then ask for its sources
      if (!(await spend())) return { entries: [], error: "Watchmode quota used up for now" };
      const s = await call("/search/", { search_field: t === "tv" ? "tmdb_tv_id" : "tmdb_movie_id", search_value: String(tmdbId) });
      if (s.ok) {
        const wid = Number(((await s.json())?.title_results || [])[0]?.id);
        if (!wid) return { entries: [] }; // Watchmode does not know this title
        if (!(await spend())) return { entries: [], error: "Watchmode quota used up for now" };
        r = await call(`/title/${wid}/sources/`, { regions: REGIONS });
      } else r = s;
    }
    if (r.status === 401 || r.status === 403) { pausedUntil = Date.now() + 3600e3; return { entries: [], error: "Watchmode key was refused (HTTP " + r.status + ")" }; }
    if (r.status === 402 || r.status === 429) { pausedUntil = Date.now() + (r.status === 429 ? 2 : 30) * 60e3; return { entries: [], error: "Watchmode limit reached (HTTP " + r.status + ")" }; }
    if (r.status === 404) return { entries: [] };
    if (!r.ok) return { entries: [], error: "Watchmode HTTP " + r.status };
    const j = await r.json();
    if (!Array.isArray(j)) return { entries: [], error: "Watchmode answer not readable" };
    const seen = new Set<string>();
    const entries: Avail[] = [];
    for (const s of j) {
      const type = TYPE[String(s?.type || "")];
      const country = String(s?.region || "").toUpperCase().slice(0, 2);
      const service = String(s?.name || "").trim().slice(0, 40);
      if (!type || !/^[A-Z]{2}$/.test(country) || !service) continue;
      const k = country + "|" + service + "|" + type; // the same service is listed once per video quality: keep one
      if (seen.has(k)) continue;
      seen.add(k);
      entries.push({ country, service, type });
    }
    entries.sort((a, b) => RANK[a.type] - RANK[b.type] || (a.country === "IN" ? 0 : 1) - (b.country === "IN" ? 0 : 1));
    return { entries };
  } catch (e) { return { entries: [], error: "Watchmode: " + String((e as Error)?.message || e) }; }
}
