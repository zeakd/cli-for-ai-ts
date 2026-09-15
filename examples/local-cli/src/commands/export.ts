import { failed, payload, records, type Stop } from "cli-for-ai";
import { command } from "../authoring.ts";
import type { Note } from "../context.ts";
import * as validate from "../validate.ts";

/** Notes one at a time; stops between records once the signal aborts. */
async function* notesFrom(all: readonly Note[], tag: string | undefined, signal: AbortSignal): AsyncGenerator<Note | Stop> {
  for (const note of all) {
    if (signal.aborted) return;
    if (tag === undefined || note.tags.includes(tag)) yield note;
  }
}

export const exportNotes = command({
  summary: "Export notes as JSON Lines",
  input: { options: { tag: { summary: "Only notes with this tag" } } },
  output: payload.jsonl({
    summary: "One note per line, oldest first",
    fields: [
      { path: "id", summary: "ID accepted by note show and note remove" },
      { path: "text", summary: "Note content; line breaks are escaped" },
      { path: "tags[]", summary: "Tags" },
      { path: "createdAt", summary: "Creation time" },
    ],
    parse: validate.note,
  }),
  examples: [{ summary: "Export the home notes", input: { tag: "home" } }],
  run: async ({ tag }, ctx, { signal }) => {
    const loaded = await ctx.notes.list();
    return loaded.match(
      (all) => records(notesFrom(all, tag, signal)),
      () => failed({ code: "NOTES_UNAVAILABLE", message: "Notes could not be loaded" }),
    );
  },
});

export const texts = command({
  summary: "Print note texts, one per record",
  description: "Note texts can contain line breaks. With LF framing such a note stops the output; use --null and read with xargs -0 or similar.",
  input: { options: { null: { summary: "End each text with NUL instead of LF", type: "boolean" } } },
  output: payload.text({ summary: "Note texts, oldest first", records: "note texts", framing: { default: "lf", nul: "null" } }),
  run: async (_input, ctx, { signal }) => {
    const loaded = await ctx.notes.list();
    return loaded.match(
      (all) =>
        records(
          (async function* () {
            for (const note of all) {
              if (signal.aborted) return;
              yield note.text;
            }
          })(),
        ),
      () => failed({ code: "NOTES_UNAVAILABLE", message: "Notes could not be loaded" }),
    );
  },
});
