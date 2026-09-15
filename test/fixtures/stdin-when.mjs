// Process fixture: stdin is read only when the scope argument is "-".
import { application, command, completed, output } from "cli-for-ai";
import { run } from "cli-for-ai/node";

const app = application({
  name: "ids",
  version: "1.0.0",
  summary: "Conditional stdin fixture",
  commands: {
    locate: command({
      summary: "Locate by scope, or by IDs on stdin with -",
      input: {
        positionals: [{ name: "scope", summary: "Scope, or - for IDs on stdin", required: true }],
        stdin: { summary: "IDs, one per line", format: "text", when: { input: "scope", equals: "-" } },
      },
      output: output(),
      run: (input) => completed({ scope: input.scope, ids: input.stdin === undefined ? null : input.stdin.split("\n").filter(Boolean) }),
    }),
  },
});

// Announce once run() has installed its signal handlers, for the cancellation test.
const ready = setInterval(() => {
  if (process.listenerCount("SIGINT") > 0) {
    clearInterval(ready);
    process.stderr.write("listening\n");
  }
}, 5);
await run(app, { context: () => ({}) });
clearInterval(ready);
