// Authored field descriptions: display metadata naming fields of results or payload records.

/**
 * An authored description of one result field. path is display metadata naming
 * the field in the success result, not an executable query: "data", "data.name",
 * "data[]", "data.items[].id". A key that is empty or contains ".", "[", "]",
 * a quote, whitespace or a control character is written as a JSON string in
 * brackets, with JSON escapes: data["a.b"], data[""], data["two words"],
 * data["line\nbreak"]. A path is always one line. Nothing checks that run or
 * parse produces the field.
 */
export interface OutputField {
  readonly path: string;
  readonly summary: string;
}

// "data", then segments: .key (no ".", "[", "]" or '"'), [] for array elements, or ["json string"] for any key.
// oxlint-disable-next-line no-control-regex -- JSON strings forbid raw control characters
const FIELD_SEGMENT = /\.([^.[\]"\s\p{Cc}]+)|\[\]|\[("(?:[^"\\\p{Cc}\u2028\u2029]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\]/uy;

/** Record-relative paths name a key of the record object first; "[]" at the start would mean a non-object record. */
function canonicalRecordPath(path: string): string | undefined {
  if (path.startsWith("[]")) return undefined;
  return canonicalFieldPath(path.startsWith("[") ? `data${path}` : `data.${path}`);
}

/** The canonical form of a field path, so data.a and data["a"] count as the same field; undefined when malformed. */
function canonicalFieldPath(path: string): string | undefined {
  if (!path.startsWith("data")) return undefined;
  const parts = ["data"];
  FIELD_SEGMENT.lastIndex = 4;
  while (FIELD_SEGMENT.lastIndex < path.length) {
    const start = FIELD_SEGMENT.lastIndex;
    const match = FIELD_SEGMENT.exec(path);
    if (!match || match.index !== start) return undefined;
    if (match[1] !== undefined) parts.push(JSON.stringify(match[1]));
    else if (match[2] !== undefined) parts.push(JSON.stringify(JSON.parse(match[2]) as string));
    else parts.push("[]");
  }
  return parts.join(" ");
}

/**
 * Problems with authored field descriptions. root "data" paths start at the
 * ordinary result ("data.notes[].id"); root "record" paths start inside a
 * payload record ("sessionId", "tags[]", ["a.b"]).
 */
export function fieldIssues(fields: unknown, root: "data" | "record", label: string): string[] {
  if (!Array.isArray(fields)) return [`${label}s must be an array`];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const what = `${label} ${i}`;
    // A hole in a sparse array is not a declaration.
    if (!Object.hasOwn(fields, i)) {
      issues.push(`${what} is missing`);
      continue;
    }
    const field: unknown = fields[i];
    if (typeof field !== "object" || field === null || Array.isArray(field)) {
      issues.push(`${what} must be an object`);
      continue;
    }
    const f = field as Record<string, unknown>;
    for (const key of Object.keys(f)) if (key !== "path" && key !== "summary") issues.push(`${what} has unknown key "${key}"`);
    if (typeof f.summary !== "string" || !f.summary.trim()) issues.push(`${what} has no summary`);
    if (typeof f.path !== "string" || !f.path.trim()) {
      issues.push(`${what} has no path`);
      continue;
    }
    const canonical = root === "data" ? canonicalFieldPath(f.path) : canonicalRecordPath(f.path);
    if (canonical === undefined) {
      issues.push(
        root === "data"
          ? `${what} path ${JSON.stringify(f.path)} must start with data and continue with .key, [] or ["key"] segments`
          : `${what} path ${JSON.stringify(f.path)} must start with a key or ["key"] and continue with .key, [] or ["key"] segments`,
      );
    }
    else if (seen.has(canonical)) issues.push(`${what} path ${JSON.stringify(f.path)} describes a field already described`);
    else seen.add(canonical);
  }
  return issues;
}

