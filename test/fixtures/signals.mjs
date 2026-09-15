// Process fixture for node run(): built package, one command that waits for cancellation.
import { application, command, completed, failed, output } from "cli-for-ai";
import { run } from "cli-for-ai/node";
import { appendFileSync } from "node:fs";

// Observations go to a report file, because stdout or stderr may be deliberately broken.
const report = (entry) => {
  if (process.env.FIXTURE_REPORT) appendFileSync(process.env.FIXTURE_REPORT, `${JSON.stringify(entry)}\n`);
};

const app = application({
  name: "signals",
  version: "1.0.0",
  summary: "Signal fixture",
  commands: {
    wait: command({
      summary: "Wait until cancelled",
      output: output(),
      run: (_input, ctx, { signal }) =>
        new Promise((resolve) => {
          // Stands in for pending IO: a promise alone does not keep Node running.
          const pending = setInterval(() => {}, 1000);
          process.stderr.write("ready\n");
          signal.addEventListener("abort", () => {
            clearInterval(pending);
            ctx.cleanup.push("released");
            resolve(failed({ code: "INTERRUPTED", message: `stopped after cleanup: ${ctx.cleanup.join(",")}` }));
          });
        }),
    }),
    stubborn: command({
      summary: "Observe cancellation but keep waiting",
      output: output(),
      run: (_input, _ctx, { signal }) =>
        new Promise(() => {
          // Pending IO that the handler deliberately does not stop.
          setInterval(() => {}, 1000);
          signal.addEventListener("abort", () => process.stderr.write("first-aborted\n"));
          process.stderr.write("ready\n");
        }),
    }),
    read: command({
      summary: "Read stdin",
      input: { stdin: { format: "text", summary: "Anything" } },
      output: output(),
      run: (input, ctx) => {
        ctx.cleanup.push("handler ran");
        return completed(input.stdin);
      },
    }),
    progress: command({
      summary: "Write progress to stderr, then succeed",
      output: output(),
      run: () => {
        process.stderr.write("progress\n");
        return completed("done");
      },
    }),
    big: command({
      summary: "Print a large result",
      input: { options: { size: { summary: "Characters", type: "integer", min: 1, default: 1000000 } } },
      output: output(),
      run: (input) => completed("x".repeat(input.size)),
    }),
  },
});

const options = {
  context: () => {
    process.stderr.write("context\n");
    return { cleanup: [] };
  },
  dispose: () => {
    process.stderr.write("disposed\n");
  },
  onDiagnostic: ({ message, cause }) => report({ diagnostic: message, code: cause?.code }),
};

const counts = () => ({
  stdoutError: process.stdout.listenerCount("error"),
  stderrError: process.stderr.listenerCount("error"),
  sigint: process.listenerCount("SIGINT"),
  sigterm: process.listenerCount("SIGTERM"),
});

const failNextWrites = (stream, code) => {
  stream.write = (_chunk, callback) => {
    const error = Object.assign(new Error("device error"), { code });
    process.nextTick(() => {
      callback?.(error);
      stream.emit("error", error);
    });
    return false;
  };
};

const mode = process.env.FIXTURE_MODE;
if (mode === "repeat") {
  // Listeners are per run: an external observer is preserved and later errors reach it, not the framework.
  const observed = [];
  process.stdout.on("error", (error) => observed.push(error.code));
  const before = counts();
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push(await run(app, { ...options, argv: ["big", "--size", "1"] }));
  const after = counts();
  process.stdout.emit("error", Object.assign(new Error("late broken pipe"), { code: "EPIPE" }));
  process.stdout.emit("error", Object.assign(new Error("late device error"), { code: "EIO" }));
  report({ codes, before, after, observed });
} else if (mode === "eio") {
  failNextWrites(process.stdout, "EIO");
  report({ returned: await run(app, { ...options, argv: ["big", "--size", "1"] }) });
} else if (mode === "stdout-enotconn") {
  failNextWrites(process.stdout, "ENOTCONN");
  report({ returned: await run(app, { ...options, argv: ["big", "--size", "1"] }) });
} else if (mode === "stderr-enotconn") {
  failNextWrites(process.stderr, "ENOTCONN");
  report({ returned: await run(app, { ...options, argv: ["progress"] }) });
} else if (mode === "progress-eio") {
  failNextWrites(process.stderr, "EIO");
  report({ returned: await run(app, { ...options, argv: ["progress"] }) });
} else if (mode === "destroyed-stdout") {
  // process.stdout ignores destroy(), so the destroyed-stream error is produced directly, without a prior EPIPE.
  failNextWrites(process.stdout, "ERR_STREAM_DESTROYED");
  report({ returned: await run(app, { ...options, argv: ["big", "--size", "1"] }) });
} else if (mode === "reader-leaves") {
  // The reader closes during the first run; later runs write to the same departed reader.
  const observed = [];
  const observer = (error) => observed.push(error.code);
  process.stdout.on("error", observer);
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push(await run(app, { ...options, argv: ["big"] }));
  process.stdout.off("error", observer);
  report({ codes, after: counts(), observed });
} else if (mode === "epipe-then-destroyed") {
  const original = process.stdout.write;
  failNextWrites(process.stdout, "EPIPE");
  const stdoutCodes = [await run(app, { ...options, argv: ["big", "--size", "1"] })];
  failNextWrites(process.stdout, "ERR_STREAM_DESTROYED");
  stdoutCodes.push(await run(app, { ...options, argv: ["big", "--size", "1"] }));
  process.stdout.write = original;
  // stderr never had an EPIPE, so the same code there is a real failure.
  failNextWrites(process.stderr, "ERR_STREAM_DESTROYED");
  const stderrCode = await run(app, { ...options, argv: ["progress"] });
  report({ stdoutCodes, stderrCode });
} else if (mode === "overlap") {
  const first = run(app, { ...options, argv: ["big", "--size", "1"] });
  let rejected;
  try {
    await run(app, { ...options, argv: ["big", "--size", "1"] });
  } catch (error) {
    rejected = error.message;
  }
  report({ rejected, first: await first, after: counts() });
} else if (mode === "stdin-twice") {
  const first = await run(app, { ...options, argv: ["read"] });
  const second = await run(app, { ...options, argv: ["read"] });
  report({ first, second });
} else if (mode === "stdin-destroyed") {
  process.stdin.destroy();
  report({ returned: await run(app, { ...options, argv: ["read"] }) });
} else {
  // Announce readiness once run() has installed its signal handlers.
  const ready = setInterval(() => {
    if (process.listenerCount("SIGINT") > 0) {
      clearInterval(ready);
      process.stderr.write("listening\n");
    }
  }, 5);
  await run(app, options);
  clearInterval(ready);
}
