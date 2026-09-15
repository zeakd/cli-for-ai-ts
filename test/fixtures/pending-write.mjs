// Process fixture: a payload whose stdout write is pending when SIGINT arrives.
// Events go to fd 3 (a control pipe from the parent) with synchronous writes, so they are
// observable even while stdout is blocked. Nothing here sleeps.
import { writeSync } from "node:fs";
import { application, command, payload, records } from "cli-for-ai";
import { run } from "cli-for-ai/node";

const event = (name, extra = {}) => writeSync(3, `${JSON.stringify({ event: name, ...extra })}\n`);

const originalWrite = process.stdout.write.bind(process.stdout);
let writes = 0;
process.stdout.write = (chunk, encoding, callback) => {
  const cb = typeof encoding === "function" ? encoding : callback;
  const n = ++writes;
  const accepted = originalWrite(chunk, (error) => {
    event("write-callback", { n, code: error?.code ?? null });
    cb?.(error);
  });
  if (!accepted) event("write-buffered", { n, bytes: chunk.length, listeners: process.stdout.listenerCount("error") });
  return accepted;
};
process.stdout.on("close", () => event("stdout-close"));
process.on("exit", (code) => event("exit", { code, stdoutErrorListeners: process.stdout.listenerCount("error") }));

const record = { text: "x".repeat(Number(process.env.RECORD_BYTES ?? 1024 * 1024)) };
const app = application({
  name: "pending",
  version: "1.0.0",
  summary: "Pending write fixture",
  commands: {
    export: command({
      summary: "Large records",
      output: payload.jsonl(),
      run: (_input, _ctx, { signal }) =>
        records(
          (async function* () {
            try {
              for (let i = 0; i < 1000 && !signal.aborted; i++) yield record;
            } finally {
              event("source-finalized", { aborted: signal.aborted });
            }
          })(),
        ),
    }),
  },
});

// An observer only: run()'s own SIGINT handler does the cancelling.
process.on("SIGINT", () => event("sigint"));
const code = await run(app, {
  context: () => ({}),
  dispose: () => event("disposed", { stdoutErrorListeners: process.stdout.listenerCount("error"), sigint: process.listenerCount("SIGINT") }),
});
event("run-returned", { code, stdoutErrorListeners: process.stdout.listenerCount("error"), sigint: process.listenerCount("SIGINT") });
