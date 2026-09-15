// Payload output: commands whose stdout is a stream of records in a declared
// format instead of one JSON result. The handler returns records(source) or
// failed(fault); the executor pulls records one at a time, checks and encodes
// each, and awaits every write. Obtaining a source is not success: only a fully
// written payload followed by cleanup is complete. An explicit policy may allow early reader closure.

import { AuthoringError } from "./errors.ts";
import { fieldIssues, type OutputField } from "./fields.ts";
import { projectFault, type Fault, type Outcome } from "./result.ts";
import { snapshot } from "./snapshot.ts";

/** Default maximum encoded size of one record, separator included. */
export const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;

declare const PAYLOAD: unique symbol;

export type ReaderClose = "require-full" | "allow";

interface PayloadBase {
  /** Whether observed reader departure may stop successfully after cleanup. Default require-full. */
  readonly readerClose: ReaderClose;
  readonly summary?: string;
  /**
   * Largest accepted encoded record in bytes, including its separator. A record
   * over the limit stops the payload before it is written. It bounds what is
   * accepted for writing, not the memory a source or its serialization uses.
   */
  readonly maxRecordBytes: number;
}

/**
 * UTF-8 JSON Lines: one JSON object per line. Line breaks inside values are
 * escaped by JSON, so every record is exactly one line.
 */
export interface JsonlPayload<R extends object> extends PayloadBase {
  readonly kind: "payload";
  readonly format: "jsonl";
  /** Record-relative field descriptions: "sessionId", "tags[]", ["a.b"]. Metadata only; nothing checks records against them. */
  readonly fields?: readonly OutputField[];
  /** Checks and may normalize each record exactly once before it is encoded. Throwing is an internal error. */
  readonly parse?: (record: unknown) => R;
  /** Type-only record marker. */
  readonly [PAYLOAD]: R;
}

/** How text records are separated. The option form uses NUL when the named boolean option is given. */
export type TextFraming<O extends string = string> = "lf" | "nul" | { readonly default: "lf"; readonly nul: O };

/** UTF-8 text records, each followed by its separator. Nothing is escaped. */
/**
 * O is the name of the boolean option that selects NUL framing, or never when the
 * framing is fixed. A widened string cannot be checked against declared options,
 * so a command using it is rejected at compile time.
 */
export interface TextPayload<O extends string = never> extends PayloadBase {
  readonly kind: "payload";
  readonly format: "text";
  /** What one record is, e.g. "file paths". */
  readonly records: string;
  readonly framing: TextFraming<O>;
  /** Type-only record marker. */
  readonly [PAYLOAD]: string;
}

export type PayloadDecl = JsonlPayload<object> | TextPayload<string>;

export type RecordOf<P> = P extends JsonlPayload<infer R> ? R : P extends TextPayload<string> ? string : never;

const declarations = new WeakSet<object>();

export function isPayload(value: unknown): value is PayloadDecl {
  return typeof value === "object" && value !== null && declarations.has(value);
}


function baseIssues(decl: Record<string, unknown>, allowed: readonly string[]): string[] {
  const issues: string[] = [];
  if (decl.readerClose !== undefined && decl.readerClose !== "require-full" && decl.readerClose !== "allow") issues.push('readerClose must be "require-full" or "allow"');
  for (const key of Reflect.ownKeys(decl)) {
    if (typeof key !== "string" || !allowed.includes(key)) issues.push(`unknown key "${String(key)}"`);
  }
  if (decl.summary !== undefined && (typeof decl.summary !== "string" || !decl.summary.trim())) issues.push("summary must be a non-empty string");
  if (decl.maxRecordBytes !== undefined && !(Number.isSafeInteger(decl.maxRecordBytes) && (decl.maxRecordBytes as number) > 0)) {
    issues.push("maxRecordBytes must be a positive safe integer");
  }
  return issues;
}

/** Copies the author's settings without running getters, so later mutation cannot change the declaration. */
function copied(decl: unknown): Record<string, unknown> {
  if (typeof decl !== "object" || decl === null || Array.isArray(decl)) throw new AuthoringError("payload", ["settings must be an object"]);
  const result = snapshot(decl, "payload");
  if (!result.ok) throw new AuthoringError("payload", [result.issue]);
  return result.value as Record<string, unknown>;
}

function declare<T extends object>(decl: T): T {
  declarations.add(Object.freeze(decl));
  return decl;
}

interface JsonlOptions {
  readerClose?: ReaderClose;
  summary?: string;
  fields?: readonly OutputField[];
  maxRecordBytes?: number;
}

interface TextOptions<O extends string> {
  readerClose?: ReaderClose;
  summary?: string;
  records: string;
  framing: TextFraming<O>;
  maxRecordBytes?: number;
}

function jsonl<R extends object>(decl: JsonlOptions & { parse: (record: unknown) => R }): JsonlPayload<R>;
function jsonl<R extends object = Record<string, unknown>>(decl?: JsonlOptions): JsonlPayload<R>;
function jsonl<R extends object>(decl: JsonlOptions & { parse?: (record: unknown) => R } = {}): JsonlPayload<R> {
  const raw = copied(decl);
  const issues = baseIssues(raw, ["summary", "fields", "parse", "maxRecordBytes", "readerClose"]);
  if (raw.parse !== undefined && typeof raw.parse !== "function") issues.push("parse must be a function");
  if (raw.fields !== undefined) issues.push(...fieldIssues(raw.fields, "record", "field"));
  if (issues.length > 0) throw new AuthoringError("payload", issues);
  return declare({
    kind: "payload",
    format: "jsonl",
    readerClose: (raw.readerClose as ReaderClose | undefined) ?? "require-full",
    maxRecordBytes: (raw.maxRecordBytes as number | undefined) ?? DEFAULT_MAX_RECORD_BYTES,
    ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
    ...(raw.fields !== undefined ? { fields: raw.fields } : {}),
    ...(raw.parse !== undefined ? { parse: raw.parse } : {}),
  }) as unknown as JsonlPayload<R>;
}

function text<const O extends string = never>(decl: TextOptions<O>): TextPayload<NoInfer<O>> {
  const raw = copied(decl);
  const issues = baseIssues(raw, ["summary", "records", "framing", "maxRecordBytes", "readerClose"]);
  if (typeof raw.records !== "string" || !raw.records.trim()) issues.push("records must describe what one record is");
  const framing = raw.framing;
  let framingCopy: TextFraming<O> | undefined;
  if (framing === "lf" || framing === "nul") framingCopy = framing;
  else if (typeof framing === "object" && framing !== null && !Array.isArray(framing)) {
    const f = framing as Record<string, unknown>;
    const extra = Reflect.ownKeys(f).filter((k) => k !== "default" && k !== "nul");
    if (f.default !== "lf" || typeof f.nul !== "string" || !f.nul || extra.length > 0) {
      issues.push('framing must be "lf", "nul" or { default: "lf", nul: "<boolean option>" }');
    } else framingCopy = f as unknown as TextFraming<O>;
  } else issues.push('framing must be "lf", "nul" or { default: "lf", nul: "<boolean option>" }');
  if (issues.length > 0) throw new AuthoringError("payload", issues);
  return declare({
    kind: "payload",
    format: "text",
    records: raw.records,
    framing: framingCopy!,
    readerClose: (raw.readerClose as ReaderClose | undefined) ?? "require-full",
    maxRecordBytes: (raw.maxRecordBytes as number | undefined) ?? DEFAULT_MAX_RECORD_BYTES,
    ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
  }) as unknown as TextPayload<O>;
}

/** Payload output declarations for command({ output }). */
export const payload = { jsonl, text };

// ── handler results ────────────────────────────────────────────────────────

declare const RECORDS: unique symbol;
declare const STOP: unique symbol;

/** A lazy record source returned by a payload handler. Returning it is not success. */
export interface Records<R> {
  readonly source: AsyncIterable<R | Stop>;
  /** Type-only record marker. */
  readonly [RECORDS]: R;
}

/**
 * Yielded by a source to end the payload with a typed business failure (exit 1).
 * If the caller's abort was observed while the source was pending, the run is
 * interrupted (130) whatever the fault code.
 */
export interface Stop {
  readonly fault: Fault | undefined;
  readonly [STOP]: true;
}

const recordSets = new WeakSet<object>();
const stops = new WeakSet<object>();

export function records<R>(source: AsyncIterable<R | Stop>): Records<R> {
  const built = Object.freeze({ source });
  recordSets.add(built);
  return built as unknown as Records<R>;
}

/** The fault is projected to code, message and plain JSON details now; an invalid fault becomes an internal error when yielded. */
export function stop(fault: Fault): Stop {
  const projected = projectFault(fault);
  const built = Object.freeze({ fault: projected.ok ? projected.value : undefined });
  stops.add(built);
  return built as unknown as Stop;
}

export function isRecords(value: unknown): value is Records<unknown> {
  return typeof value === "object" && value !== null && recordSets.has(value);
}

export function isStop(value: unknown): value is Stop {
  return typeof value === "object" && value !== null && stops.has(value);
}

export type PayloadHandlerResult<R> = Records<R> | Outcome<never>;
