// embed.ts: "does it read like the same kind of film?" with a small text-embedding model (gte-small, 384 numbers per title).
// It runs INSIDE Supabase (Edge Functions ship it: no API key, no cost, nothing leaves Supabase). If it is not there, every function here
// answers null and the old scoring (TF-IDF, themes, angles) carries on alone.
// Idea taken from open-source recommenders (e.g. trekomend): ONE text per title (plot, keywords, genres, tagline, year, language), embedded, compared
// by cosine. Popularity and vote counts stay OUT of the text, they are not about what the film is.

let session: any = null;
// OFF unless switched on:  supabase secrets set SIMILAR_EMBED=on   (loading the model uses a lot of compute: on a small project the function
// is killed with HTTP 546 while it runs, so it must be asked for, not assumed)
export const embedOn = () => !!(globalThis as any).Supabase?.ai?.Session && Deno.env.get("SIMILAR_EMBED") === "on";
const hasModel = embedOn;

export const docText = (parts: (string | undefined | null)[], max = 1800): string =>
  parts.filter((p) => p && String(p).trim()).join(". ").replace(/\s+/g, " ").slice(0, max);

// one vector per text (null where it failed or time ran out)
export async function embedAll(texts: string[], budgetMs = 8_000): Promise<(number[] | null)[]> {
  if (!hasModel()) return texts.map(() => null);
  try { session ??= new (globalThis as any).Supabase.ai.Session("gte-small"); } catch { return texts.map(() => null); }
  const until = Date.now() + budgetMs;
  const out: (number[] | null)[] = [];
  for (const t of texts) {
    if (Date.now() > until) { out.push(null); continue; }
    try { out.push(Array.from(await session.run(t, { mean_pool: true, normalize: true }) as ArrayLike<number>).map((x) => Math.round(x * 1e4) / 1e4)); }
    catch { out.push(null); }
  }
  return out;
}
// vectors are normalised, so the dot product is the cosine
export const cosine = (a: number[], b: number[]): number => { let s = 0; for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]; return s; };
// gte-small cosines sit between about 0.72 (unrelated) and 0.92 (same kind of film): stretched to 0..1
export const embedX = (c: number): number => Math.max(0, Math.min(1, (c - 0.76) / 0.18));
