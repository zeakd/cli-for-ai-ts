// Output validators. Each checks data at run time and returns it typed;
// throwing marks the result as an internal error, never a business failure.

import type { Note } from "./context.ts";

type Fields = Record<string, unknown>;

function object(value: unknown, what: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${what} must be an object`);
  return value as Fields;
}

function array<T>(value: unknown, what: string, item: (v: unknown, what: string) => T): T[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be an array`);
  return value.map((v, i) => item(v, `${what}[${i}]`));
}

function string(value: unknown, what: string): string {
  if (typeof value !== "string") throw new TypeError(`${what} must be a string`);
  return value;
}

function count(value: unknown, what: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new TypeError(`${what} must be a non-negative integer`);
  return value as number;
}

export function note(value: unknown, what = "note"): Note {
  const v = object(value, what);
  return {
    id: count(v.id, `${what}.id`),
    text: string(v.text, `${what}.text`),
    tags: array(v.tags, `${what}.tags`, string),
    createdAt: string(v.createdAt, `${what}.createdAt`),
  };
}

export function noteList(value: unknown): { notes: Note[]; returned: number; total: number } {
  const v = object(value, "data");
  return { notes: array(v.notes, "notes", note), returned: count(v.returned, "returned"), total: count(v.total, "total") };
}

export function added(value: unknown): { added: Note[] } {
  return { added: array(object(value, "data").added, "added", note) };
}

export function removed(value: unknown): { removed: number[] } {
  return { removed: array(object(value, "data").removed, "removed", count) };
}

export function noteCount(value: unknown): { notes: number } {
  return { notes: count(object(value, "data").notes, "notes") };
}

export function setting<Nullable extends boolean>(nullable: Nullable) {
  return (value: unknown): { key: string; value: Nullable extends true ? string | null : string } => {
    const v = object(value, "data");
    const stored = nullable && v.value === null ? null : string(v.value, "value");
    return { key: string(v.key, "key"), value: stored as Nullable extends true ? string | null : string };
  };
}
