import { application, command, completed, failed, output, payload, records } from "cli-for-ai";
import { run } from "cli-for-ai/node";
const mode = process.argv[2];
const pending = () => new Promise(() => {});
const app = application({ name: "probe", version: "1", summary: "Exit guard probe", commands: {
  ok: command({ summary: "Success", output: output(), run: () => completed(null) }),
  fail: command({ summary: "Failure", output: output(), run: () => failed({ code: "NO", message: "No" }) }),
  handler: command({ summary: "Pending handler", output: output(), run: pending }),
  source: command({ summary: "Pending source", output: payload.jsonl(), run: () => records({ [Symbol.asyncIterator]() { return { next: pending }; } }) }),
} });
const options = { context: () => ({}), argv: [mode === "dispose" ? "ok" : mode], ...(mode === "dispose" ? { dispose: pending } : {}) };
if (mode === "sequence") {
  await run(app, { context: () => ({}), argv: ["fail"] });
  await run(app, { context: () => ({}), argv: ["ok"] });
} else if (process.argv[3] === "await") {
  await run(app, options);
} else {
  void run(app, options);
}
