#!/usr/bin/env node
import { run } from "cli-for-ai/node";
import { ghLite } from "./repo.ts";

await run(ghLite, { context: () => ({ fetch: globalThis.fetch }) });
