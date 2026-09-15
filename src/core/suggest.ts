// "did you mean?" — pure, zero-dep. The valid set always comes from a
// declaration (a flag list, the registry's command names, an enum), so a good
// suggestion falls out with no per-error authoring. Pure ⇒ unit-testable with
// no IO.

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr: number[] = Array.from({ length: n + 1 }, () => 0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1, // deletion
        curr[j - 1]! + 1, // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

// Closest candidate within a distance threshold, or undefined. Threshold scales
// with the input length so short tokens aren't matched too loosely.
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  const threshold = Math.max(2, Math.floor(input.length * 0.4));
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best !== undefined && bestDist <= threshold ? best : undefined;
}
