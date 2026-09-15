// Process fixture for payload streaming through cli-for-ai/node, using the built package.
import { appendFileSync } from "node:fs";
import { application, command, failed, payload, records } from "cli-for-ai";
import { run } from "cli-for-ai/node";

// Observations go to a report file: stdout carries the payload and may be closed by the reader.
const report = (entry) => {
  if (process.env.FIXTURE_REPORT) appendFileSync(process.env.FIXTURE_REPORT, `${JSON.stringify(entry)}\n`);
};

const app = application({
  name: "payloads",
  version: "1.0.0",
  summary: "Payload fixture",
  commands: {
    endless: command({
      summary: "Records until stopped",
      output: payload.jsonl({ readerClose: process.env.READER_CLOSE === "allow" ? "allow" : "require-full" }),
      run: (_input, _ctx, { signal }) =>
        records(
          (async function* () {
            let n = 0;
            try {
              while (!signal.aborted) {
                n++;
                yield { n, text: "line one\nline two" };
              }
            } finally {
              report({ finalized: n, aborted: signal.aborted });
            }
          })(),
        ),
    }),
    missing: command({
      summary: "Fails before any record",
      output: payload.jsonl(),
      run: () => failed({ code: "NOT_FOUND", message: "nothing to export" }),
    }),
    count: command({
      summary: "A fixed number of records",
      input: { options: { n: { summary: "Records", type: "integer", min: 0, required: true } } },
      output: payload.jsonl(),
      run: ({ n }) =>
        records(
          (async function* () {
            for (let i = 1; i <= n; i++) yield { i, pad: "x".repeat(100) };
          })(),
        ),
    }),
  },
});

// Optional: make every write to a stream fail with a code, to check its classification.
for (const [name, stream] of [["STDOUT_ERROR", process.stdout], ["STDERR_ERROR", process.stderr]]) {
  if (!process.env[name]) continue;
  stream.write = (_chunk, callback) => {
    const error = Object.assign(new Error("simulated"), { code: process.env[name] });
    process.nextTick(() => {
      callback?.(error);
      stream.emit("error", error);
    });
    return false;
  };
}

const code = await run(app, {
  context: () => ({}),
  dispose: () => report({ disposed: true }),
  onDiagnostic: ({ message, cause }) => report({ diagnostic: message, code: cause?.code }),
});
report({ returned: code });
