#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "cli-for-ai/node";
import { notebook } from "./app.ts";
import { createContext } from "./context.ts";
import { fileDocuments } from "./files.ts";

await run(notebook, {
  context: async ({ env, cwd }) =>
    createContext(await fileDocuments(env.NOTEBOOK_HOME ? resolve(cwd, env.NOTEBOOK_HOME) : join(homedir(), ".notebook")), () => new Date()),
});
