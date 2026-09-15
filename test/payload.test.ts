import { describe, expect, test } from "vitest";
import {
  application,
  applicationSchema,
  AuthoringError,
  check,
  command,
  completed,
  DEFAULT_MAX_RECORD_BYTES,
  execute,
  executeTo,
  failed,
  group,
  output,
  OutputClosedError,
  parseInvocation,
  payload,
  records,
  stop,
  type CommandSchema,
  type ExecuteToOptions,
  type GroupSchema,
  type Sink,
  type Stop,
} from "../src/index.ts";
import { fromList, Gate, gatedSource, Watch } from "./support/gates.ts";

const decoder = new TextDecoder();

/** A sink whose writes wait for the test to accept them, one gate per write. */
function slowSink() {
  const chunks: string[] = [];
  const pending = new Watch(0);
  const gates: Gate[] = [];
  const sink: Sink = {
    write: (chunk, signal) => {
      const gate = new Gate();
      gates.push(gate);
      pending.set(pending.current + 1);
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal!.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        void gate.opened.then(() => {
          signal?.removeEventListener("abort", onAbort);
          chunks.push(decoder.decode(chunk));
          resolve();
        });
      });
    },
  };
  return { sink, chunks, pending, gates };
}

function memorySink() {
  const chunks: string[] = [];
  const sink: Sink = { write: async (chunk) => void chunks.push(decoder.decode(chunk)) };
  return { sink, chunks, text: () => chunks.join("") };
}

interface Ctx {
  log: string[];
}

function lifecycle(log: string[]): Pick<ExecuteToOptions<unknown>, "context" | "dispose"> {
  return {
    context: (): Ctx => {
      log.push("context");
      return { log };
    },
    dispose: () => {
      log.push("dispose");
    },
  };
}

function appWith(spec: Record<string, unknown>) {
  const cmd = command({ summary: "Export", output: payload.jsonl(), run: () => records(fromList([])), ...spec } as never);
  return application({ name: "tool", version: "1", summary: "t", commands: { data: group({ summary: "Data", commands: { export: cmd } }) } });
}

const failureReport = (text: string) => {
  const reports = text.trimEnd().split("\n").filter((line) => !line.startsWith("diagnostic "));
  expect(reports).toHaveLength(1);
  const report = JSON.parse(reports[0]!);
  expect(report.status).toBe("failed");
  return report;
};

describe("streaming", () => {
  test("records reach the sink before the source finishes, and the source is not advanced while a write is pending", async () => {
    const log: string[] = [];
    const { source, gates, progress } = gatedSource([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const out = slowSink();
    const err = memorySink();
    const app = appWith({ run: () => records(source()) });
    const running = executeTo(app, ["data", "export"], { ...lifecycle(log), stdout: out.sink, stderr: err.sink });

    gates[0]!.open();
    await out.pending.until((n) => n === 1);
    // The first record is being written; the source has not been asked for the second one.
    expect(progress.current).toEqual({ requested: 1, yielded: 0, finalized: false });
    out.gates[0]!.open();
    await progress.until((p) => p.requested === 2);
    expect(out.chunks).toEqual(['{"n":1}\n']);
    expect(progress.current.finalized).toBe(false);

    gates[1]!.open();
    await out.pending.until((n) => n === 2);
    out.gates[1]!.open();
    gates[2]!.open();
    await out.pending.until((n) => n === 3);
    out.gates[2]!.open();

    const completion = await running;
    expect(completion).toEqual({ exitCode: 0, kind: "success", payload: { recordsWritten: 3, complete: true } });
    expect(out.chunks.join("")).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(err.chunks).toEqual([]);
    expect(progress.current.finalized).toBe(true);
    expect(log).toEqual(["context", "dispose"]);
  });

  test("execute collects the same bytes and facts as executeTo", async () => {
    const app = appWith({ run: () => records(fromList([{ a: "x\ny" }, { b: [1, 2] }])) });
    const rendered = await execute(app, ["data", "export"], { context: () => ({}) });
    expect(rendered).toEqual({ exitCode: 0, kind: "success", stdout: '{"a":"x\\ny"}\n{"b":[1,2]}\n', stderr: "", payload: { recordsWritten: 2, complete: true } });
  });

  test("text framing: LF by default, NUL when the bound option is given", async () => {
    const texts = command({
      summary: "Paths",
      input: { options: { null: { summary: "NUL", type: "boolean" } } },
      output: payload.text({ records: "paths", framing: { default: "lf", nul: "null" } }),
      run: () => records(fromList(["a b", "c"])),
    });
    const app = application({ name: "tool", version: "1", summary: "t", commands: { texts } });
    expect((await execute(app, ["texts"], { context: () => ({}) })).stdout).toBe("a b\nc\n");
    expect((await execute(app, ["texts", "--null"], { context: () => ({}) })).stdout).toBe("a b\0c\0");
  });
});

describe("failures are reported on stderr and never appended to stdout", () => {
  const run = async (spec: Record<string, unknown>, argv = ["data", "export"]) => {
    const log: string[] = [];
    const out = memorySink();
    const err = memorySink();
    const diagnostics: string[] = [];
    const completion = await executeTo(appWith(spec), argv, {
      ...lifecycle(log),
      stdout: out.sink,
      stderr: err.sink,
      onDiagnostic: (d) => diagnostics.push(d.message),
    });
    return { completion, stdout: out.text(), stderr: err.text(), log, diagnostics };
  };

  test("failed(fault) before any record: exit 1, empty stdout, context disposed", async () => {
    const r = await run({ run: () => failed({ code: "SCOPE_NOT_FOUND", message: "No such scope" }) });
    expect(r.completion).toMatchObject({ exitCode: 1, kind: "failed", payload: { recordsWritten: 0, complete: false } });
    expect(r.stdout).toBe("");
    expect(failureReport(r.stderr)).toEqual({
      status: "failed",
      error: { code: "SCOPE_NOT_FOUND", message: "No such scope" },
      payload: { recordsWritten: 0, complete: false },
    });
    expect(r.log).toEqual(["context", "dispose"]);
  });

  test("stop(fault) midstream keeps the written prefix, finalizes the source, then disposes", async () => {
    const log: string[] = [];
    async function* source(): AsyncGenerator<{ n: number } | Stop> {
      try {
        yield { n: 1 };
        yield stop({ code: "BLOCK_CORRUPT", message: "Block 2 cannot be read", details: { block: 2 } });
        yield { n: 3 };
      } finally {
        log.push("finalized");
      }
    }
    const out = memorySink();
    const err = memorySink();
    const completion = await executeTo(appWith({ run: () => records(source()) }), ["data", "export"], {
      context: () => {
        log.push("context");
        return {};
      },
      dispose: () => void log.push("dispose"),
      stdout: out.sink,
      stderr: err.sink,
    });
    expect(completion).toMatchObject({ exitCode: 1, kind: "failed", payload: { recordsWritten: 1, complete: false } });
    expect(out.text()).toBe('{"n":1}\n');
    expect(failureReport(err.text()).error).toEqual({ code: "BLOCK_CORRUPT", message: "Block 2 cannot be read", details: { block: 2 } });
    expect(log).toEqual(["context", "finalized", "dispose"]);
  });

  test("a structurally identical object is a record, not a stop", async () => {
    const lookalike = { fault: { code: "X", message: "y" } };
    const r = await run({ run: () => records(fromList([lookalike])) });
    expect(r.completion.exitCode).toBe(0);
    expect(r.stdout).toBe('{"fault":{"code":"X","message":"y"}}\n');
  });

  test("stop with an Error keeps its message and nothing else", async () => {
    class ApiError extends Error {
      code = "API";
      response = { token: "secret" };
    }
    const r = await run({ run: () => records(fromList([stop(new ApiError("down"))])) });
    expect(failureReport(r.stderr).error).toEqual({ code: "API", message: "down" });
    expect(r.stderr).not.toContain("secret");
  });

  test.each([
    ["the handler throws", { run: () => { throw new Error("secret"); } }, "The command handler threw"],
    ["the handler returns completed", { run: () => completed([]) }, "A payload command must return records(source) or failed(fault)"],
    ["the source throws", { run: () => records((async function* () { yield { a: 1 }; throw new Error("secret"); })()) }, "The payload source threw"],
    ["the source is not iterable", { run: () => records({} as never) }, "The payload source could not be iterated"],
    ["stop carries an invalid fault", { run: () => records(fromList([stop({ code: "", message: "m" })])) }, "cannot be reported"],
    ["a record is not an object", { run: () => records(fromList([[1, 2]])) }, "A JSONL payload record is not a JSON object"],
    ["a record is not plain JSON", { run: () => records(fromList([{ at: new Date(0) }])) }, "A payload record is not plain JSON data"],
  ])("%s: internal error 70 with a fixed line and no raw cause", async (_name, spec, message) => {
    const r = await run(spec);
    expect(r.completion).toMatchObject({ exitCode: 70, kind: "internal" });
    expect(r.stderr).toContain(`INTERNAL_ERROR: `);
    expect(failureReport(r.stderr).error.message).toContain(message);
    expect(r.stderr).not.toContain("secret");
    expect(r.log.at(-1)).toBe("dispose");
  });

  test("a record parse failure is internal and names the record index", async () => {
    const r = await run({
      output: payload.jsonl({
        parse: (v) => {
          if ((v as { ok?: boolean }).ok !== true) throw new Error("bad");
          return v as object;
        },
      }),
      run: () => records(fromList([{ ok: true }, { ok: false }])),
    });
    expect(r.completion).toMatchObject({ exitCode: 70, payload: { recordsWritten: 1 } });
    expect(failureReport(r.stderr).error).toEqual({ code: "INTERNAL_ERROR", message: "A payload record does not match its declaration", details: { record: 1 } });
    expect(r.stdout).toBe('{"ok":true}\n');
  });

  test("an oversized record or a separator collision is RECORD_NOT_REPRESENTABLE (1), and nothing of that record is written", async () => {
    const big = await run({ output: payload.jsonl({ maxRecordBytes: 12 }), run: () => records(fromList([{ a: 1 }, { a: "long value" }])) });
    expect(big.completion).toMatchObject({ exitCode: 1, kind: "failed", payload: { recordsWritten: 1 } });
    expect(big.stdout).toBe('{"a":1}\n');
    expect(failureReport(big.stderr).error).toMatchObject({ code: "RECORD_NOT_REPRESENTABLE", details: { record: 1, reason: "its encoding is larger than 12 bytes" } });

    // The limit includes the separator: "abcdefghijk" plus LF is 12 bytes.
    const exact = await run({ output: payload.text({ records: "r", framing: "lf", maxRecordBytes: 12 }), run: () => records(fromList(["abcdefghijk", "abcdefghijkl"])) });
    expect(exact.stdout).toBe("abcdefghijk\n");
    expect(exact.completion.payload?.recordsWritten).toBe(1);

    const lf = await run({ output: payload.text({ records: "r", framing: "lf" }), run: () => records(fromList(["ok", "two\nlines"])) });
    expect(lf.stdout).toBe("ok\n");
    expect(failureReport(lf.stderr).error.details).toEqual({ record: 1, reason: "it contains the LF separator" });
    expect(lf.stderr).not.toContain("two");

    const nul = await run({ output: payload.text({ records: "r", framing: "nul" }), run: () => records(fromList(["a\nb", "c\0d"])) });
    expect(nul.stdout).toBe("a\nb\0");
    expect(failureReport(nul.stderr).error.details).toEqual({ record: 1, reason: "it contains the NUL separator" });

    const surrogate = await run({ output: payload.text({ records: "r", framing: "lf" }), run: () => records(fromList(["\ud800"])) });
    expect(surrogate.completion.exitCode).toBe(70);
    const notString = await run({ output: payload.text({ records: "r", framing: "lf" }), run: () => records(fromList([5])) });
    expect(notString.completion.exitCode).toBe(70);
  });
});

describe("input errors for a payload command go to stderr before any effect", () => {
  const exporter = command({
    summary: "Export",
    input: {
      positionals: [{ name: "scope", summary: "Scope", required: true, check: check.string("not empty", (v) => v.length > 0) }],
      options: { limit: { summary: "Limit", type: "integer", min: 1 } },
      stdin: { format: "json", summary: "Filter" },
    },
    output: payload.jsonl(),
    run: () => records(fromList([{ a: 1 }])),
  });
  const app = application({ name: "tool", version: "1", summary: "t", commands: { data: group({ summary: "Data", commands: { export: exporter } }) } });

  test.each([
    [["data", "export"], "Missing argument: <scope>"],
    [["data", "export", "s", "--bogus"], "Unknown option: --bogus"],
    [["data", "export", "s", "--limit", "0"], "Invalid value: --limit 0"],
    [["data", "export", ""], "Invalid value: scope"],
    [["data", "export", "s", "--human"], "--human is not supported: this command prints a declared payload"],
    [["--human", "data", "export", "s"], "--human is not supported: this command prints a declared payload"],
    [["data", "export", "s", "--human", "--help"], "--human is not supported: this command prints a declared payload"],
  ])("%j", async (argv, message) => {
    const log: string[] = [];
    let stdinRead = false;
    const out = memorySink();
    const err = memorySink();
    const completion = await executeTo(app, argv, {
      ...lifecycle(log),
      readStdin: async () => {
        stdinRead = true;
        return "{}";
      },
      stdout: out.sink,
      stderr: err.sink,
    });
    expect(completion).toMatchObject({ exitCode: 2, kind: "invalid", payload: { recordsWritten: 0, complete: false } });
    expect(out.text()).toBe("");
    expect(failureReport(err.text()).error.message).toBe(message);
    expect(log).toEqual([]);
    expect(stdinRead).toBe(false);
  });

  test("invalid JSON stdin is reported on stderr before the context", async () => {
    const log: string[] = [];
    const r = await execute(app, ["data", "export", "s"], { ...lifecycle(log), readStdin: async () => "not json" });
    expect(r).toMatchObject({ exitCode: 2, stdout: "" });
    expect(failureReport(r.stderr).error).toEqual({ code: "INVALID_INPUT", message: "Invalid value: stdin is not valid JSON", details: { input: "stdin", expected: "json" } });
    expect(log).toEqual([]);
  });

  test("unknown option suggestions for a payload command do not offer --human", async () => {
    const r = await execute(app, ["data", "export", "s", "--humen"], { context: () => ({}) });
    expect(failureReport(r.stderr).error.details.allowed).toEqual(["--limit", "--help"]);
  });

  test("unresolved routes report on stderr without contaminating payload stdout", async () => {
    const r = await execute(app, ["data", "exprot"], { context: () => ({}) });
    expect(r).toMatchObject({ exitCode: 2, stdout: "" });
    expect(failureReport(r.stderr).error.code).toBe("UNKNOWN_COMMAND");
    expect(r.payload).toBeUndefined();
  });

  test("parseInvocation keeps the resolved command on invalid input", () => {
    const inv = parseInvocation(app, ["data", "export", "--bogus"]);
    expect(inv).toMatchObject({ kind: "invalid", command: exporter });
  });

  test("help needs no source, stdin or context and does not offer --human", async () => {
    const log: string[] = [];
    const r = await execute(app, ["data", "export", "--help"], lifecycle(log));
    expect(r.exitCode).toBe(0);
    expect(log).toEqual([]);
    expect(r.stdout).not.toContain("--human");
    expect(r.stdout).toContain("Payload:\n  UTF-8 JSON Lines: one JSON object per line; line breaks inside values are escaped.");
    expect(r.stdout).toContain(`Largest record: ${DEFAULT_MAX_RECORD_BYTES} bytes including its separator`);
    expect(r.stdout).toContain("Exit 0 means all selected records were written and cleanup succeeded.");
    expect(r.stdout).toContain("For result states and exit codes, run `tool --help`.");
  });
});

describe("cancellation, output failures and cleanup", () => {
  test("cancel while the source is pending: 130, finalized and disposed once", async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const started = new Gate();
    async function* source(signal: AbortSignal) {
      try {
        yield { n: 1 };
        started.open();
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      } finally {
        log.push("finalized");
      }
    }
    const out = memorySink();
    const err = memorySink();
    const running = executeTo(appWith({ run: (_i: unknown, _c: unknown, { signal }: { signal: AbortSignal }) => records(source(signal)) }), ["data", "export"], {
      ...lifecycle(log),
      signal: controller.signal,
      stdout: out.sink,
      stderr: err.sink,
    });
    await started.opened;
    controller.abort();
    const completion = await running;
    expect(completion).toMatchObject({ exitCode: 130, kind: "interrupted", payload: { recordsWritten: 1, complete: false } });
    expect(out.text()).toBe('{"n":1}\n');
    expect(failureReport(err.text()).error).toEqual({ code: "INTERRUPTED", message: "Execution was interrupted; the payload is incomplete" });
    expect(log).toEqual(["context", "finalized", "dispose"]);
  });

  test("a cooperative source that ends because of the abort is INTERRUPTED (130), not a complete payload", async () => {
    const controller = new AbortController();
    const r = await execute(
      appWith({
        run: () =>
          records(
            (async function* () {
              yield { id: 1 };
              controller.abort();
            })(),
          ),
      }),
      ["data", "export"],
      { context: () => ({}), signal: controller.signal },
    );
    expect(r).toMatchObject({ exitCode: 130, kind: "interrupted", stdout: '{"id":1}\n', payload: { recordsWritten: 1, complete: false } });
  });

  test("abort while next() is pending, then the source returns done: 130 and the context is disposed once", async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const pending = new Gate();
    async function* source(signal: AbortSignal) {
      try {
        yield { id: 1 };
        pending.open();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return;
      } finally {
        log.push("finalized");
      }
    }
    const running = execute(appWith({ run: (_i: unknown, _c: unknown, { signal }: { signal: AbortSignal }) => records(source(signal)) }), ["data", "export"], {
      ...lifecycle(log),
      signal: controller.signal,
    });
    await pending.opened;
    controller.abort();
    const r = await running;
    expect(r).toMatchObject({ exitCode: 130, payload: { recordsWritten: 1, complete: false } });
    expect(failureReport(r.stderr).error.code).toBe("INTERRUPTED");
    expect(log).toEqual(["context", "finalized", "dispose"]);
  });

  test("a source that yields stop after observing the abort is still INTERRUPTED; the abort came first", async () => {
    const controller = new AbortController();
    const pending = new Gate();
    const log: string[] = [];
    async function* source(signal: AbortSignal) {
      try {
        pending.open();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        yield stop({ code: "CANCELLED_BY_SOURCE", message: "stopped" });
      } finally {
        log.push("finalized");
      }
    }
    const running = execute(appWith({ run: (_i: unknown, _c: unknown, { signal }: { signal: AbortSignal }) => records(source(signal)) }), ["data", "export"], {
      context: () => ({}),
      signal: controller.signal,
    });
    await pending.opened;
    controller.abort();
    const r = await running;
    expect(r).toMatchObject({ exitCode: 130, kind: "interrupted" });
    expect(failureReport(r.stderr).error.code).toBe("INTERRUPTED");
    expect(log).toEqual(["finalized"]);
  });

  test("an abort during dispose after natural completion does not change the result (completion was reached)", async () => {
    const controller = new AbortController();
    const r = await execute(appWith({ run: () => records(fromList([{ id: 1 }])) }), ["data", "export"], {
      context: () => ({}),
      dispose: () => controller.abort(),
      signal: controller.signal,
    });
    expect(r).toMatchObject({ exitCode: 0, payload: { recordsWritten: 1, complete: true } });
  });

  test("cancel while a write is pending: 130, that record is not counted, and the report still reaches stderr", async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const { source, gates, progress } = gatedSource([{ n: 1 }, { n: 2 }]);
    const out = slowSink();
    // A stderr sink that refuses aborted writes shows the report is written without the execution signal.
    const errChunks: string[] = [];
    const stderr: Sink = {
      write: async (chunk, signal) => {
        if (signal?.aborted) throw signal.reason;
        errChunks.push(decoder.decode(chunk));
      },
    };
    const running = executeTo(appWith({ run: () => records(source()) }), ["data", "export"], {
      ...lifecycle(log),
      signal: controller.signal,
      stdout: out.sink,
      stderr,
    });
    gates[0]!.open();
    await out.pending.until((n) => n === 1);
    controller.abort();
    const completion = await running;
    expect(completion).toMatchObject({ exitCode: 130, payload: { recordsWritten: 0, complete: false } });
    expect(failureReport(errChunks.join("")).error.code).toBe("INTERRUPTED");
    expect(progress.current).toMatchObject({ requested: 1, finalized: true });
    expect(log).toEqual(["context", "dispose"]);
  });

  test("a closed reader is OUTPUT_CLOSED (70): the source is told to stop and is not asked for more", async () => {
    const log: string[] = [];
    let sourceSignal: AbortSignal | undefined;
    const pulled: number[] = [];
    async function* source(signal: AbortSignal) {
      sourceSignal = signal;
      try {
        for (let n = 1; ; n++) {
          pulled.push(n);
          yield { n };
        }
      } finally {
        log.push("finalized");
      }
    }
    let writes = 0;
    const stdout: Sink = {
      write: async () => {
        writes++;
        if (writes === 3) throw new OutputClosedError({ cause: Object.assign(new Error("EPIPE"), { code: "EPIPE" }) });
      },
    };
    const err = memorySink();
    const completion = await executeTo(appWith({ run: (_i: unknown, _c: unknown, { signal }: { signal: AbortSignal }) => records(source(signal)) }), ["data", "export"], {
      ...lifecycle(log),
      stdout,
      stderr: err.sink,
    });
    expect(completion).toMatchObject({ exitCode: 70, kind: "internal", payload: { recordsWritten: 2, complete: false } });
    expect(failureReport(err.text()).error).toEqual({ code: "OUTPUT_CLOSED", message: "The output reader closed before the payload was complete" });
    expect(sourceSignal?.aborted).toBe(true);
    expect(pulled).toEqual([1, 2, 3]);
    expect(log).toEqual(["context", "finalized", "dispose"]);
  });

  test("other write failures are OUTPUT_FAILED (70) with a diagnostic; an external abort afterwards does not relabel them", async () => {
    const controller = new AbortController();
    const diagnostics: unknown[] = [];
    const stdout: Sink = {
      write: async () => {
        throw Object.assign(new Error("device"), { code: "EIO" });
      },
    };
    const err = memorySink();
    const completion = await executeTo(appWith({ run: () => records(fromList([{ a: 1 }, { a: 2 }])) }), ["data", "export"], {
      context: () => ({}),
      signal: controller.signal,
      stdout,
      stderr: err.sink,
      // The caller's signal fires only after the write failure was observed.
      onDiagnostic: (d) => {
        diagnostics.push(d);
        controller.abort();
      },
    });
    expect(completion).toMatchObject({ exitCode: 70, kind: "internal" });
    expect(err.text()).toContain('diagnostic OUTPUT_FAILED: "Writing the payload to stdout failed"\n');
    expect(failureReport(err.text()).error.code).toBe("OUTPUT_FAILED");
    expect(diagnostics).toHaveLength(1);
  });

  test("an external abort observed first stays INTERRUPTED even if the pending write then fails", async () => {
    const controller = new AbortController();
    const writeStarted = new Gate();
    const stdout: Sink = {
      write: (_chunk, signal) =>
        new Promise((_resolve, reject) => {
          writeStarted.open();
          signal!.addEventListener("abort", () => reject(new OutputClosedError()), { once: true });
        }),
    };
    const err = memorySink();
    const running = executeTo(appWith({ run: () => records(fromList([{ a: 1 }])) }), ["data", "export"], {
      context: () => ({}),
      signal: controller.signal,
      stdout,
      stderr: err.sink,
    });
    await writeStarted.opened;
    controller.abort();
    expect(await running).toMatchObject({ exitCode: 130, kind: "interrupted" });
  });

  test("a failing source finalizer does not hide the first failure", async () => {
    async function* source() {
      try {
        yield stop({ code: "FIRST", message: "first" });
      } finally {
        // oxlint-disable-next-line no-unsafe-finally -- simulates a defective finalizer
        throw new Error("finalizer");
      }
    }
    const r = await execute(appWith({ run: () => records(source()) }), ["data", "export"], { context: () => ({}) });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('diagnostic INTERNAL_ERROR: "Finalizing the payload source failed"\n');
    expect(failureReport(r.stderr).error.code).toBe("FIRST");
  });

  test("cleanup failure after a complete payload is nonzero and complete:false; an earlier failure keeps its class", async () => {
    const ok = await execute(appWith({ run: () => records(fromList([{ a: 1 }])) }), ["data", "export"], {
      context: () => ({}),
      dispose: () => Promise.reject(new Error("stuck")),
    });
    expect(ok).toMatchObject({ exitCode: 70, kind: "unreported", stdout: '{"a":1}\n', payload: { recordsWritten: 1, complete: false } });
    expect(failureReport(ok.stderr).error.code).toBe("CONTEXT_CLEANUP_FAILED");

    const failedFirst = await execute(appWith({ run: () => failed({ code: "NOPE", message: "no" }) }), ["data", "export"], {
      context: () => ({}),
      dispose: () => Promise.reject(new Error("stuck")),
    });
    expect(failedFirst.exitCode).toBe(1);
    expect(failedFirst.stderr).toContain('diagnostic CONTEXT_CLEANUP_FAILED: "Cleaning up the execution context failed"\n');
    expect(failureReport(failedFirst.stderr).error.code).toBe("NOPE");
  });

  test("iterator finalization happens on every path before dispose", async () => {
    for (const ending of ["done", "stop", "throw", "bad-record"] as const) {
      const log: string[] = [];
      async function* source() {
        try {
          yield { a: 1 };
          if (ending === "stop") yield stop({ code: "S", message: "s" });
          if (ending === "throw") throw new Error("t");
          if (ending === "bad-record") yield [1];
        } finally {
          log.push("finalized");
        }
      }
      await execute(appWith({ run: () => records(source()) }), ["data", "export"], {
        context: () => ({}),
        dispose: () => void log.push("dispose"),
      });
      expect(log, ending).toEqual(["finalized", "dispose"]);
    }
  });
});

describe("declarations, help and schema", () => {
  test("payload declaration errors", () => {
    const issues = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as AuthoringError).issues;
      }
      return [];
    };
    expect(issues(() => payload.jsonl({ maxRecordBytes: 0 }))).toEqual(["maxRecordBytes must be a positive safe integer"]);
    expect(issues(() => payload.jsonl({ fields: [{ path: "data.id", summary: "x" }, { path: "[]", summary: "y" }, { path: '["a.b"]', summary: "z" }] }))).toEqual([
      'field 1 path "[]" must start with a key or ["key"] and continue with .key, [] or ["key"] segments',
    ]);
    expect(issues(() => payload.jsonl({ format: "csv" } as never))).toEqual(['unknown key "format"']);
    expect(issues(() => payload.text({ records: "", framing: "crlf" as never }))).toEqual([
      "records must describe what one record is",
      'framing must be "lf", "nul" or { default: "lf", nul: "<boolean option>" }',
    ]);
    const base = { summary: "x", run: () => records(fromList([])) };
    expect(issues(() => command({ ...base, output: payload.jsonl(), human: () => "x" } as never))).toEqual([
      "human cannot be used with a payload output; payload commands reject --human",
    ]);
    expect(issues(() => command({ ...base, output: payload.jsonl(), result: () => ({ status: "accepted" }) } as never))).toEqual([
      "result cannot be used with a payload output",
    ]);
    expect(issues(() => command({ ...base, output: payload.text({ records: "r", framing: { default: "lf", nul: "zero" } }) } as never))).toEqual([
      'payload framing option "zero" must be a declared boolean option',
    ]);
    expect(
      issues(() =>
        command({ ...base, input: { options: { zero: { summary: "z" } } }, output: payload.text({ records: "r", framing: { default: "lf", nul: "zero" } }) } as never),
      ),
    ).toEqual(['payload framing option "zero" must be a declared boolean option']);
    // A plain object shaped like a payload declaration is an ordinary output with unknown keys.
    expect(issues(() => command({ ...base, output: { kind: "payload", format: "jsonl", maxRecordBytes: 1 } } as never))).toEqual([
      'output has unknown key "kind"',
      'output has unknown key "format"',
      'output has unknown key "maxRecordBytes"',
    ]);
  });

  test("payload settings are snapshotted without running getters", async () => {
    let ran = false;
    const lazy = Object.defineProperty({}, "summary", {
      enumerable: true,
      get: () => {
        ran = true;
        return "s";
      },
    });
    expect(() => payload.jsonl(lazy as never)).toThrow(AuthoringError);
    expect(ran).toBe(false);
    const lazyFraming = Object.defineProperty({ default: "lf" }, "nul", { enumerable: true, get: () => ((ran = true), "null") });
    expect(() => payload.text({ records: "r", framing: lazyFraming as never })).toThrow(AuthoringError);
    expect(ran).toBe(false);

    const fields = [{ path: "id", summary: "Id" }];
    const framing = { default: "lf" as const, nul: "null" };
    const jsonl = payload.jsonl({ fields });
    const text = payload.text({ records: "r", framing });
    fields[0]!.summary = "changed";
    fields.push({ path: "late", summary: "late" });
    framing.nul = "other";
    expect(jsonl.fields).toEqual([{ path: "id", summary: "Id" }]);
    expect(Object.isFrozen(jsonl.fields) && Object.isFrozen(jsonl.fields![0])).toBe(true);
    expect(text.framing).toEqual({ default: "lf", nul: "null" });
    expect(Object.isFrozen(text.framing) && Object.isFrozen(jsonl) && Object.isFrozen(text)).toBe(true);
  });

  test("stop details with an accessor are not read; the stop becomes an internal error", async () => {
    let ran = false;
    const details = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        ran = true;
        return "token";
      },
    });
    const r = await execute(appWith({ run: () => records(fromList([stop({ code: "X", message: "m", details: details as never })])) }), ["data", "export"], {
      context: () => ({}),
    });
    expect(r.exitCode).toBe(70);
    expect(ran).toBe(false);
    expect(r.stderr).not.toContain("token");
  });

  test("applicationSchema publishes payload metadata instead of output", () => {
    const app = application({
      name: "tool",
      version: "1",
      summary: "t",
      commands: {
        rows: command({ summary: "Rows", output: payload.jsonl({ summary: "Rows", fields: [{ path: "id", summary: "Row id" }], maxRecordBytes: 1024 }), run: () => records(fromList([])) }),
        paths: command({
          summary: "Paths",
          input: { options: { null: { summary: "NUL", type: "boolean" } } },
          output: payload.text({ records: "file paths", framing: { default: "lf", nul: "null" } }),
          run: () => records(fromList([])),
        }),
        plain: command({ summary: "Plain", output: output<null>(), run: () => completed(null) }),
      },
    });
    const schema = applicationSchema(app).commands;
    expect(schema.rows).toMatchObject({ payload: { format: "jsonl", encoding: "utf-8", summary: "Rows", fields: [{ path: "id", summary: "Row id" }], maxRecordBytes: 1024 } });
    expect(schema.rows).not.toHaveProperty("output");
    expect((schema.paths as CommandSchema).payload).toEqual({
      format: "text",
      encoding: "utf-8",
      records: "file paths",
      readerClose: "require-full",
      framing: { default: "lf", nul: "null" },
      maxRecordBytes: DEFAULT_MAX_RECORD_BYTES,
    });
    expect((schema.plain as CommandSchema).payload).toBeUndefined();
    void (schema as unknown as GroupSchema);
  });

  test("root help distinguishes ordinary results from payloads and scopes --human", async () => {
    const root = (await execute(appWith({}), [], { context: () => ({}) })).stdout;
    expect(root).toContain("Present an ordinary JSON result for people; payload commands reject it");
    expect(root).toContain("Commands that declare a payload print only that payload on stdout and report errors on stderr.");
  });
});

describe("encoding, metadata and output delivery", () => {
  test("an unexpected encoding failure is internal (70) with the record index, and the source is finalized before dispose", async () => {
    // Fault injection: stands in for a serialization that exceeds engine limits, without allocating one.
    for (const target of ["stringify", "encode"] as const) {
      const log: string[] = [];
      const diagnostics: unknown[] = [];
      async function* source() {
        try {
          yield target === "stringify" ? { ok: 1 } : "ok";
          yield target === "stringify" ? { boom: 1 } : "boom";
        } finally {
          log.push("finalized");
        }
      }
      const stringify = JSON.stringify;
      const encode = TextEncoder.prototype.encode;
      if (target === "stringify") {
        JSON.stringify = ((value: unknown, ...rest: never[]) => {
          if (value !== null && typeof value === "object" && "boom" in value) throw new RangeError("Invalid string length");
          return stringify(value, ...rest);
        }) as typeof JSON.stringify;
      } else {
        TextEncoder.prototype.encode = function (this: InstanceType<typeof TextEncoder>, input?: string) {
          if (input?.startsWith("boom")) throw new RangeError("Invalid string length");
          return encode.call(this, input);
        };
      }
      let r;
      try {
        r = await execute(
          appWith({ output: target === "stringify" ? payload.jsonl() : payload.text({ records: "r", framing: "lf" }), run: () => records(source()) }),
          ["data", "export"],
          { context: () => ({}), dispose: () => void log.push("dispose"), onDiagnostic: (d) => diagnostics.push(d) },
        );
      } finally {
        JSON.stringify = stringify;
        TextEncoder.prototype.encode = encode;
      }
      expect(r.exitCode, target).toBe(70);
      expect(failureReport(r.stderr).error).toEqual({ code: "INTERNAL_ERROR", message: "A payload record could not be encoded", details: { record: 1 } });
      expect(r.stderr).not.toContain("Invalid string length");
      expect(log).toEqual(["finalized", "dispose"]);
      expect((diagnostics[0] as { cause: Error }).cause).toBeInstanceOf(RangeError);
    }
  });

  test("a throw anywhere after the iterator exists still finalizes it; an established failure is not hidden", async () => {
    const log: string[] = [];
    const iterator = {
      next: async () => ({ done: false, value: { a: 1 } }),
      return: async () => {
        log.push("finalized");
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    let calls = 0;
    const stdout: Sink = {
      write: async () => {
        calls++;
        if (calls === 2) throw Object.assign(new Error("device"), { code: "EIO" });
      },
    };
    const err = memorySink();
    const completion = await executeTo(appWith({ run: () => records(iterator) }), ["data", "export"], {
      context: () => ({}),
      dispose: () => void log.push("dispose"),
      stdout,
      stderr: err.sink,
    });
    expect(completion).toMatchObject({ exitCode: 70, payload: { recordsWritten: 1 } });
    expect(failureReport(err.text()).error.code).toBe("OUTPUT_FAILED");
    expect(log).toEqual(["finalized", "dispose"]);
  });

  test("schema option scope and lint for payload summaries", async () => {
    const { applicationSchema: schemaOf } = await import("../src/index.ts");
    const { lintSchema } = await import("../src/lint/index.ts");
    const described = application({
      name: "tool",
      version: "1",
      summary: "t",
      commands: {
        rows: command({ summary: "Rows", output: payload.jsonl({ summary: "One row per line" }), run: () => records(fromList([])) }),
        bare: command({ summary: "Bare", output: payload.jsonl(), run: () => records(fromList([])) }),
      },
    });
    const schema = schemaOf(described);
    expect(schema.globalOptions).toEqual({
      help: { summary: "Show help for the application, a group or a command", scope: "all" },
      human: { summary: "Present an ordinary JSON result for people; payload commands reject it", scope: "ordinary-commands" },
      version: { summary: "Print the application name and version (application root only)", scope: "root" },
    });
    expect(lintSchema(schema)).toEqual([{ level: "warn", rule: "output-described", message: '"bare" does not describe its payload' }]);
  });

  test("a leading BOM in payload bytes survives collection, byte for byte with executeTo", async () => {
    const app = appWith({ output: payload.text({ records: "r", framing: "lf" }), run: () => records(fromList(["﻿a", "b"])) });
    const bytes: number[] = [];
    await executeTo(app, ["data", "export"], {
      context: () => ({}),
      stdout: { write: async (chunk) => void bytes.push(...chunk) },
      stderr: memorySink().sink,
    });
    const collected = await execute(app, ["data", "export"], { context: () => ({}) });
    expect(collected.stdout).toBe("﻿a\nb\n");
    expect([...new TextEncoder().encode(collected.stdout)]).toEqual(bytes);
    expect(bytes.slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
  });

  test("ordinary execute keeps the rendered string exactly, including a BOM and a lone surrogate", async () => {
    const human = "﻿start \ud800 end";
    const app = application({
      name: "tool",
      version: "1",
      summary: "t",
      commands: { show: command({ summary: "Show", output: output<null>(), run: () => completed(null), human: () => human }) },
    });
    expect((await execute(app, ["show", "--human"], { context: () => ({}) })).stdout).toBe(`${human}\n`);
  });

  test("a failed ordinary result write is not a success; a closed reader is left to the host", async () => {
    const app = application({ name: "tool", version: "1", summary: "t", commands: { show: command({ summary: "Show", output: output<number>(), run: () => completed(1) }) } });
    const diagnostics: unknown[] = [];
    const failedWrite = await executeTo(app, ["show"], {
      context: () => ({}),
      stdout: { write: async () => Promise.reject(Object.assign(new Error("device"), { code: "EIO" })) },
      stderr: memorySink().sink,
      onDiagnostic: (d) => diagnostics.push(d),
    });
    expect(failedWrite).toMatchObject({ exitCode: 70, kind: "internal", outputError: { stream: "stdout" } });
    expect(diagnostics).toHaveLength(1);
    const closed = await executeTo(app, ["show"], {
      context: () => ({}),
      stdout: { write: async () => Promise.reject(new OutputClosedError()) },
      stderr: memorySink().sink,
      onDiagnostic: (d) => diagnostics.push(d),
    });
    expect(closed).toMatchObject({ exitCode: 0, kind: "success", outputError: { stream: "stdout" } });
    expect(diagnostics).toHaveLength(1);
  });

  test("a payload failure report that cannot be written is diagnosed once and keeps its class", async () => {
    const diagnostics: { message: string }[] = [];
    let attempts = 0;
    const completion = await executeTo(appWith({ run: () => failed({ code: "NOPE", message: "no" }) }), ["data", "export"], {
      context: () => ({}),
      stdout: memorySink().sink,
      stderr: {
        write: async () => {
          attempts++;
          throw Object.assign(new Error("device"), { code: "EIO" });
        },
      },
      onDiagnostic: (d) => diagnostics.push(d),
    });
    expect(completion).toMatchObject({ exitCode: 1, kind: "failed", outputError: { stream: "stderr" } });
    expect(attempts).toBe(1);
    expect(diagnostics.map((d) => d.message)).toEqual(["Writing the payload failure report to stderr failed"]);
  });
});
