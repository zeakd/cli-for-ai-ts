// Experiment fixture: run() with a stdout the kernel refuses to write to (a read-only fd).
// Observations go to FIXTURE_REPORT; nothing here synthesizes errors.
import { appendFileSync } from "node:fs";
import { application, command, completed, output } from "cli-for-ai";
import { run } from "cli-for-ai/node";

let seq = 0;
const report = (event, extra = {}) =>
  appendFileSync(process.env.FIXTURE_REPORT, `${JSON.stringify({ seq: seq++, event, ...extra })}\n`);

const app = application({
  name: "stdio",
  version: "1.0.0",
  summary: "stdio error experiment",
  commands: { ok: command({ summary: "Succeed", output: output(), run: () => completed("x".repeat(Number(process.env.SIZE ?? 10))) }) },
});

report("start", { stdoutKind: process.stdout.constructor.name });
// Optional external observer: shows when Node emits 'error' relative to run() returning.
if (process.env.OBSERVE) process.stdout.on("error", (error) => report("error-event", { code: error.code }));
process.on("exit", (code) => report("exit", { code, listeners: process.stdout.listenerCount("error") }));
const code = await run(app, {
  context: () => ({}),
  onDiagnostic: ({ message, cause }) => report("diagnostic", { message, code: cause?.code, destroyed: process.stdout.destroyed, closed: process.stdout.closed }),
});
report("returned", { code, listeners: process.stdout.listenerCount("error"), destroyed: process.stdout.destroyed, closed: process.stdout.closed, errored: Boolean(process.stdout.errored) });
setImmediate(() => report("after-immediate", { destroyed: process.stdout.destroyed, errored: Boolean(process.stdout.errored) }));
