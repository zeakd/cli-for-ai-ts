import { application, group } from "cli-for-ai";
import { config } from "./commands/config.ts";
import { add, importNotes, list, remove, show } from "./commands/notes.ts";
import { exportNotes, texts } from "./commands/export.ts";
import { status } from "./commands/status.ts";

// Commands are independent declarations; the tree is chosen here.
export const notebook = application({
  name: "notebook",
  version: "0.1.0",
  summary: "Local notes stored as JSON files",
  commands: {
    status,
    note: group({ summary: "Add, find and remove notes", commands: { add, list, show, remove, import: importNotes, export: exportNotes, texts } }),
    config,
  },
});
