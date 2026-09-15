// cli-for-ai/upgrade — opt-in, niche.
//
// Self-update primitives for a standalone compiled-binary distribution. Not for
// tools whose version is managed by a package or tool manager: there self-update
// is unnecessary and would conflict, and the gates below keep it a no-op. These
// are the reusable, correctness-sensitive pieces (dev/managed gate, version
// compare); downloading and atomically replacing the binary is left to the tool.

export const DEV_SENTINEL = "0.0.0-dev";

// Compare semver-ish tags ("v1.2.3" / "1.2.3"). true when `remote` is strictly
// newer. Pre-release suffixes are ignored (kept simple on purpose).
export function isNewer(remote: string, current: string): boolean {
  const parse = (s: string) => s.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [ra = 0, rb = 0, rc = 0] = parse(remote);
  const [ca = 0, cb = 0, cc = 0] = parse(current);
  if (ra !== ca) return ra > ca;
  if (rb !== cb) return rb > cb;
  return rc > cc;
}

// Two gates; the updater runs only when BOTH hold. (1) not a source run
// (version isn't the dev sentinel), (2) the process IS the managed binary under
// the tool's home. A source run fails (2) even if a real version leaks in.
export function updaterEnabled(opts: {
  version: string;
  execPath: string;
  managedBinPath: string;
  disable?: boolean;
}): boolean {
  if (opts.disable) return false;
  if (opts.version === DEV_SENTINEL) return false;
  return opts.execPath === opts.managedBinPath;
}
