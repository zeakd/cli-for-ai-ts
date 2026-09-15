import { output, type Fault, type OutputField } from "cli-for-ai";
import { fromNeverthrow } from "cli-for-ai/neverthrow";
import { ResultAsync, errAsync, okAsync } from "neverthrow";
import { command } from "../authoring.ts";
import type { Note } from "../context.ts";
import { configurationFault, isValidTag, settingsDocumentFault, tagCheck, TAG_RULE } from "../tags.ts";
import * as validate from "../validate.ts";

/** Field descriptions for a note found at prefix, shared by the commands that return notes. */
function noteFields(prefix: string): OutputField[] {
  return [
    { path: `${prefix}.id`, summary: "ID accepted by note show and note remove" },
    { path: `${prefix}.text`, summary: "Note content" },
    { path: `${prefix}.tags[]`, summary: "Tags" },
    { path: `${prefix}.createdAt`, summary: "Creation time" },
  ];
}

const noteLine = (n: Note) => `#${n.id}  ${n.text}${n.tags.length ? `  [${n.tags.join(", ")}]` : ""}`;

export const add = command({
  summary: "Add a note",
  description: `Without --tag, the stored default-tag (notebook config set default-tag <tag>) is attached; any --tag replaces it. The same rule applies to both: ${TAG_RULE}.`,
  input: {
    positionals: [{ name: "text", summary: "Note text", required: true }],
    options: { tag: { summary: "Tag to attach; replaces the stored default-tag", repeat: true, check: tagCheck } },
  },
  output: output({ summary: "The stored note", fields: noteFields("data"), parse: validate.note }),
  examples: [
    { summary: "Add a tagged note", input: { text: "buy milk", tag: ["home"] } },
    { summary: "Add a note with the stored default-tag", input: { text: "call the plumber" } },
  ],
  run: fromNeverthrow((input, ctx) => {
    const tags = input.tag.length > 0
      ? okAsync<string[], Fault>(input.tag)
      : ResultAsync.fromSafePromise(ctx.settings.get("default-tag")).andThen((stored) =>
          !stored.valid
            ? errAsync<string[], Fault>(settingsDocumentFault())
            : stored.value === null
              ? okAsync<string[], Fault>([])
              : isValidTag(stored.value)
                ? okAsync([stored.value])
                : errAsync(configurationFault("default-tag")),
        );
    return tags.andThen((resolved) => ctx.notes.add(input.text, resolved));
  }),
  human: noteLine,
});

export const list = command({
  summary: "List notes, newest last",
  input: {
    options: {
      tag: { summary: "Only notes with this tag" },
      limit: { summary: "Maximum notes to return", type: "integer", min: 1, max: 100, default: 20 },
    },
  },
  output: output({
    summary: "Matching notes; returned < total means more matched than the limit allowed",
    fields: [
      { path: "data.notes[]", summary: "Returned notes" },
      ...noteFields("data.notes[]"),
      { path: "data.returned", summary: "Number of notes returned" },
      { path: "data.total", summary: "Total matching notes" },
    ],
    parse: validate.noteList,
  }),
  examples: [{ summary: "The last five home notes", input: { tag: "home", limit: 5 } }],
  run: fromNeverthrow((input, ctx) =>
    ctx.notes.list().map((all) => {
      const matching = input.tag === undefined ? all : all.filter((n) => n.tags.includes(input.tag!));
      const notes = matching.slice(-input.limit);
      return { notes, returned: notes.length, total: matching.length };
    }),
  ),
  human: (data) =>
    [...data.notes.map(noteLine), `Returned ${data.returned} of ${data.total}`].join("\n"),
});

export const show = command({
  summary: "Show one note",
  input: { positionals: [{ name: "id", summary: "Note id", type: "integer", min: 1, required: true }] },
  output: output({ summary: "The note", fields: noteFields("data"), parse: validate.note }),
  // NoteNotFound already is a Fault, so no error mapper is needed.
  run: fromNeverthrow((input, ctx) => ctx.notes.get(input.id)),
  human: noteLine,
});

export const remove = command({
  summary: "Remove notes; nothing is removed unless every id exists",
  input: { positionals: [{ name: "ids", summary: "Note ids", type: "integer", min: 1, required: true, variadic: true }] },
  output: output({ summary: "Removed ids", fields: [{ path: "data.removed[]", summary: "IDs of the removed notes" }], parse: validate.removed }),
  run: fromNeverthrow((input, ctx) => ctx.notes.remove(input.ids).map((removed) => ({ removed })), {
    error: ({ missing }) => ({
      code: "NOTE_NOT_FOUND",
      message: `No note with id ${missing.join(", ")}; nothing was removed`,
      details: { missing },
    }),
  }),
});

interface ImportItem {
  text: string;
  tags: string[];
}

/** Every item is checked, with the same tag rule as --tag, before anything is written. */
function importItems(value: unknown): { ok: true; value: ImportItem[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: "expected an array" };
  const items: ImportItem[] = [];
  for (const [i, item] of value.entries()) {
    if (typeof item !== "object" || item === null || typeof item.text !== "string") return { ok: false, reason: `item ${i} needs a string text` };
    if (item.tags !== undefined && !Array.isArray(item.tags)) return { ok: false, reason: `item ${i} tags must be an array` };
    const tags: unknown[] = item.tags ?? [];
    if (!tags.every(isValidTag)) return { ok: false, reason: `item ${i} has a tag that breaks the rule: ${TAG_RULE}` };
    items.push({ text: item.text, tags: tags as string[] });
  }
  return { ok: true, value: items };
}

export const importNotes = command({
  summary: "Add notes from a JSON array on stdin; every item is checked before one write",
  input: {
    stdin: {
      format: "json",
      summary: 'Array of {"text": string, "tags"?: string[]}',
      shape: { description: `array of {"text": string, "tags"?: string[]}; ${TAG_RULE}`, parse: importItems },
    },
  },
  output: output({
    summary: "Notes added, in input order",
    fields: [{ path: "data.added[]", summary: "Added notes" }, ...noteFields("data.added[]")],
    parse: validate.added,
  }),
  run: fromNeverthrow((input, ctx) => ctx.notes.addAll(input.stdin).map((added) => ({ added }))),
});
