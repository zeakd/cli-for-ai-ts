// Results are values. A handler reports what happened; presentation and exit
// status are derived from the outcome, never from thrown exceptions.

export interface Fault {
  /** Stable, machine-readable identifier such as NOT_FOUND. */
  code: string;
  /** One-line explanation for the caller. */
  message: string;
  /** Structured facts the caller needs to correct or continue, e.g. allowed values. */
  details?: Record<string, unknown>;
}

export type Outcome<A> =
  | { readonly status: "completed"; readonly data: A }
  | { readonly status: "accepted"; readonly data: A }
  | { readonly status: "failed"; readonly error: Fault };

/** The work is done; data describes the result. */
export const completed = <A>(data: A): Outcome<A> => ({ status: "completed", data });

/** The work was submitted but is not complete yet. */
export const accepted = <A>(data: A): Outcome<A> => ({ status: "accepted", data });

/** The requested work did not happen as asked. */
export const failed = (error: Fault): Outcome<never> => ({ status: "failed", error });

/** True when the value can be reported as a failure (see projectFault). */
export function isFault(value: unknown): value is Fault {
  return projectFault(value).ok;
}

export type InspectedOutcome =
  | { readonly kind: "success"; readonly status: "completed" | "accepted"; readonly data: Projection<unknown> }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "unrecognized" };

/**
 * Reads a returned value without letting exotic objects throw. Once a success
 * status is recognized, a failure to read its data is reported with that status
 * rather than discarded.
 */
export function inspectOutcome(value: unknown): InspectedOutcome {
  let status: unknown;
  try {
    if (typeof value !== "object" || value === null) return { kind: "unrecognized" };
    status = (value as Record<string, unknown>).status;
  } catch {
    return { kind: "unrecognized" };
  }
  if (status === "completed" || status === "accepted") {
    try {
      if (!("data" in value)) return { kind: "unrecognized" };
      return { kind: "success", status, data: { ok: true, value: (value as { data: unknown }).data } };
    } catch {
      return { kind: "success", status, data: { ok: false, reason: "data could not be read" } };
    }
  }
  if (status === "failed") {
    try {
      const error = (value as { error: unknown }).error;
      return typeof error === "object" && error !== null ? { kind: "failed", error } : { kind: "unrecognized" };
    } catch {
      return { kind: "unrecognized" };
    }
  }
  return { kind: "unrecognized" };
}

/** Checks the outcome shape. A failure's error is projected separately (projectFault). */
export function isOutcome(value: unknown): value is Outcome<unknown> {
  const inspected = inspectOutcome(value);
  return inspected.kind === "failed" || (inspected.kind === "success" && inspected.data.ok);
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type Projection<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Copies plain JSON data. An object property whose value is undefined is
 * omitted, as for an absent optional field. Everything JSON would otherwise
 * change or drop is rejected rather than transformed: undefined array elements,
 * non-finite numbers, bigint, functions, symbols, class instances (Date, Map,
 * Error...), accessors, custom toJSON and cycles. Getters and toJSON are never called.
 */
export function jsonCopy(value: unknown, path = "$"): Projection<JsonValue> {
  try {
    return jsonCopyUnsafe(value, path);
  } catch {
    // Revoked proxies, throwing traps and similar exotic objects.
    return { ok: false, reason: `${path} could not be inspected` };
  }
}

/** Nesting deeper than this is rejected instead of exhausting the stack. */
export const MAX_JSON_DEPTH = 256;

function jsonCopyUnsafe(value: unknown, path: string): Projection<JsonValue> {
  const seen = new Set<object>();
  const copy = (v: unknown, at: string, depth = 0): Projection<JsonValue> => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return { ok: true, value: v };
    if (typeof v === "number") return Number.isFinite(v) ? { ok: true, value: v } : { ok: false, reason: `${at} is not a finite number` };
    if (typeof v !== "object") return { ok: false, reason: `${at} is ${typeof v}, which JSON cannot represent` };
    if (seen.has(v)) return { ok: false, reason: `${at} is a circular reference` };
    if (depth >= MAX_JSON_DEPTH) return { ok: false, reason: `${at} is nested more than ${MAX_JSON_DEPTH} levels` };
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const out: JsonValue[] = [];
        for (let i = 0; i < v.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(v, i);
          if (descriptor === undefined || !("value" in descriptor)) return { ok: false, reason: `${at}[${i}] is missing or an accessor` };
          if (descriptor.value === undefined) return { ok: false, reason: `${at}[${i}] is undefined` };
          const item = copy(descriptor.value, `${at}[${i}]`, depth + 1);
          if (!item.ok) return item;
          out.push(item.value);
        }
        return { ok: true, value: out };
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return { ok: false, reason: `${at} is not a plain object` };
      const out: { [key: string]: JsonValue } = {};
      for (const key of Reflect.ownKeys(v)) {
        if (typeof key === "symbol") return { ok: false, reason: `${at} has a symbol key` };
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!descriptor.enumerable) continue;
        if (!("value" in descriptor)) return { ok: false, reason: `${at}.${key} is an accessor` };
        if (descriptor.value === undefined) continue;
        const item = copy(descriptor.value, `${at}.${key}`, depth + 1);
        if (!item.ok) return item;
        Object.defineProperty(out, key, { value: item.value, enumerable: true, writable: true, configurable: true });
      }
      return { ok: true, value: out };
    } finally {
      seen.delete(v);
    }
  };
  return copy(value, path);
}

/**
 * The wire form of a failure: code, message and plain JSON details only.
 * Other fields of the original value (Error subclasses, SDK responses) are
 * never copied; the original stays available to diagnostics only.
 */
export function projectFault(value: unknown): Projection<Fault> {
  try {
    return projectFaultUnsafe(value);
  } catch {
    return { ok: false, reason: "the failure could not be inspected" };
  }
}

function projectFaultUnsafe(value: unknown): Projection<Fault> {
  if (typeof value !== "object" || value === null) return { ok: false, reason: "the failure is not an object" };
  const read = (key: "code" | "message" | "details"): Projection<unknown> => {
    try {
      return { ok: true, value: (value as Record<string, unknown>)[key] };
    } catch {
      return { ok: false, reason: `reading ${key} threw` };
    }
  };
  const code = read("code");
  if (!code.ok) return code;
  if (typeof code.value !== "string" || code.value.length === 0) return { ok: false, reason: "code must be a non-empty string" };
  const message = read("message");
  if (!message.ok) return message;
  if (typeof message.value !== "string") return { ok: false, reason: "message must be a string" };
  const details = read("details");
  if (!details.ok) return details;
  if (details.value === undefined) return { ok: true, value: { code: code.value, message: message.value } };
  if (typeof details.value !== "object" || details.value === null || Array.isArray(details.value)) {
    return { ok: false, reason: "details must be a plain object" };
  }
  const copied = jsonCopy(details.value, "details");
  if (!copied.ok) return copied;
  return { ok: true, value: { code: code.value, message: message.value, details: copied.value as Record<string, JsonValue> } };
}
