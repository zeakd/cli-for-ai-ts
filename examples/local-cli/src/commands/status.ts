import { output } from "cli-for-ai";
import { fromNeverthrow } from "cli-for-ai/neverthrow";
import { command } from "../authoring.ts";
import { noteCount } from "../validate.ts";

export const status = command({
  summary: "Count stored notes",
  output: output({ summary: "Number of stored notes", fields: [{ path: "data.notes", summary: "Number of stored notes" }], parse: noteCount }),
  run: fromNeverthrow((_input, ctx) => ctx.notes.list().map((notes) => ({ notes: notes.length }))),
  human: ({ notes }) => `${notes} note${notes === 1 ? "" : "s"}`,
});
