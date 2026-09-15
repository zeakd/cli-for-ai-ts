// Real processes through cli-for-ai/node, using the built package.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const fixture = resolve(import.meta.dirname, "fixtures/signals.mjs");

// These fixtures also write readiness handshakes; only the framework report is JSON.
function fixtureFailure(stderr: string) {
  const reports = stderr.trimEnd().split("\n").filter((line) => line.startsWith("{"));
  expect(reports).toHaveLength(1);
  const report = JSON.parse(reports[0]!);
  expect(report.status).toBe("failed");
  return report;
}

test("SIGINT aborts the execution signal; the handler's outcome is flushed with exit 130", async () => {
  const child = spawn(process.execPath, [fixture, "wait"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
  // Exactly one SIGINT: later stderr chunks must not send another after run() removed its handlers.
  let sent = false;
  child.stderr.setEncoding("utf8").on("data", (c) => {
    stderr += c;
    if (!sent && stderr.includes("ready")) {
      sent = true;
      child.kill("SIGINT");
    }
  });
  const code = await new Promise((done) => child.on("close", done));
  expect(code).toBe(130);
  expect(stdout).toBe("");
  expect(fixtureFailure(stderr)).toEqual({
    status: "failed",
    error: { code: "INTERRUPTED", message: "stopped after cleanup: released" },
  });
  expect(stderr).toContain("disposed");
});

test("a second SIGINT forces exit 130 while the handler ignores cancellation; no output is guaranteed", async () => {
  const child = spawn(process.execPath, [fixture, "stubborn"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let first = false;
  let second = false;
  // Handshake: the first signal after the handler is running, the second only after it observed the first.
  child.stderr.setEncoding("utf8").on("data", (c) => {
    stderr += c;
    if (!first && stderr.includes("ready")) {
      first = true;
      child.kill("SIGINT");
    }
    if (first && !second && stderr.includes("first-aborted")) {
      second = true;
      child.kill("SIGINT");
    }
  });
  child.stdout.resume();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 5000);
  const exit = await new Promise((done) => child.on("close", (code, signal) => done({ code, signal })));
  clearTimeout(timer);
  expect(timedOut).toBe(false);
  expect({ first, second }).toEqual({ first: true, second: true });
  expect(exit).toEqual({ code: 130, signal: null });
});

test("SIGINT while stdin is open without EOF interrupts before context and handler", async () => {
  const child = spawn(process.execPath, [fixture, "read"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.write("partial input, never ended");
  // Exactly one SIGINT, scheduled once.
  let sent = false;
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c) => {
    stderr += c;
    if (!sent && stderr.includes("listening")) {
      sent = true;
      setTimeout(() => child.kill("SIGINT"), 50);
    }
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const code = await new Promise((done) => child.on("close", done));
  clearTimeout(timer);
  expect(code).toBe(130);
  expect(stdout).toBe("");
  expect(fixtureFailure(stderr).error.code).toBe("INTERRUPTED");
  expect(stderr).not.toContain("context");
});

test("a reader that closes early does not crash the writer; the full result is flushed otherwise", async () => {
  const full = spawn(process.execPath, [fixture, "big"], { stdio: ["ignore", "pipe", "pipe"] });
  let length = 0;
  full.stdout.on("data", (c: Buffer) => (length += c.length));
  expect(await new Promise((done) => full.on("close", done))).toBe(0);
  expect(length).toBe(JSON.stringify({ status: "completed", data: "x".repeat(1000000) }).length + 1);

  // The reader takes a few bytes and closes the pipe while the producer is still writing.
  const piped = spawn(process.execPath, [fixture, "big"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  piped.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
  piped.stdout.once("data", () => piped.stdout.destroy());
  const exit = await new Promise((done) => piped.on("close", (code, signal) => done({ code, signal })));
  expect(exit).toEqual({ code: 0, signal: null });
  expect(stderr).not.toMatch(/EPIPE|Error/);
});

interface FixtureRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  report: Record<string, unknown>[];
}

function runFixture(
  mode: string,
  opts: { stdin?: string; onStdout?: (child: ReturnType<typeof spawn>) => void } = {},
): Promise<FixtureRun> {
  const reportFile = join(mkdtempSync(join(tmpdir(), "signals-")), "report.jsonl");
  const child = spawn(process.execPath, [fixture], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_REPORT: reportFile },
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (c) => (stdout += c));
  child.stderr!.setEncoding("utf8").on("data", (c) => (stderr += c));
  opts.onStdout?.(child);
  child.stdin!.end(opts.stdin ?? "");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  return new Promise((done) =>
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const text = existsSync(reportFile) ? readFileSync(reportFile, "utf8") : "";
      done({ code, signal, stdout, stderr, report: text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l)) : [] });
    }),
  );
}

test("listeners are per run: counts return to the baseline, external observers keep receiving later errors", async () => {
  const r = await runFixture("repeat");
  expect(r).toMatchObject({ code: 0, signal: null });
  const [entry] = r.report;
  expect(entry).toEqual({
    codes: [0, 0, 0],
    before: { stdoutError: 1, stderrError: 0, sigint: 0, sigterm: 0 },
    after: { stdoutError: 1, stderrError: 0, sigint: 0, sigterm: 0 },
    observed: ["EPIPE", "EIO"],
  });
  expect(r.stdout.trim().split("\n")).toEqual(Array(3).fill('{"status":"completed","data":"x"}'));
});

test("a non-EPIPE stdout failure on success exits 70 with a diagnostic and a fixed stderr line", async () => {
  const r = await runFixture("eio");
  expect(r.code).toBe(70);
  expect(r.report).toEqual([{ diagnostic: "Writing command output to stdout failed", code: "EIO" }, { returned: 70 }]);
  expect(r.stderr).toContain('diagnostic OUTPUT_DELIVERY_FAILED: "Writing command output to stdout failed"\n');
});

test("a failing stderr during a successful run is reported through onDiagnostic and exits 70", async () => {
  const r = await runFixture("progress-eio");
  expect(r.code).toBe(70);
  expect(JSON.parse(r.stdout)).toEqual({ status: "completed", data: "done" });
  expect(r.report).toEqual([{ diagnostic: "Writing command output to stderr failed", code: "EIO" }, { returned: 70 }]);
});

test("ENOTCONN on stdout is a departed reader for an ordinary command (exit 0, no diagnostic)", async () => {
  const r = await runFixture("stdout-enotconn");
  expect(r.code).toBe(0);
  expect(r.report).toEqual([{ returned: 0 }]);
  expect(r.stderr).not.toContain("OUTPUT_DELIVERY_FAILED");
});

test("ENOTCONN on stderr stays a delivery failure (exit 70 with a diagnostic)", async () => {
  const r = await runFixture("stderr-enotconn");
  expect(r.code).toBe(70);
  expect(r.report).toEqual([{ diagnostic: "Writing command output to stderr failed", code: "ENOTCONN" }, { returned: 70 }]);
});

test("a destroyed stdout without a departed reader is a delivery failure, not ignored", async () => {
  const r = await runFixture("destroyed-stdout");
  expect(r.code).toBe(70);
  expect(r.report).toEqual([{ diagnostic: "Writing command output to stdout failed", code: "ERR_STREAM_DESTROYED" }, { returned: 70 }]);
});

test("a reader leaving early is the same departure across sequential runs, with no hang", async () => {
  const r = await runFixture("reader-leaves", {
    onStdout: (child) => child.stdout!.once("data", () => child.stdout!.destroy()),
  });
  expect(r).toMatchObject({ code: 0, signal: null });
  // Observed on Node 24: process.stdout is not destroyed by the departure, so every later run sees it again.
  // Each departure surfaces as EPIPE or, when the reader closes mid-write, ENOTCONN; both are a departed stdout reader.
  expect(r.report).toEqual([
    { codes: [0, 0, 0], after: { stdoutError: 0, stderrError: 0, sigint: 0, sigterm: 0 }, observed: [expect.any(String), expect.any(String), expect.any(String)] },
  ]);
  const [report] = r.report as [{ observed: string[] }];
  expect(report.observed).toHaveLength(3);
  for (const code of report.observed) expect(["EPIPE", "ENOTCONN"]).toContain(code);
});

test("ERR_STREAM_DESTROYED is ignored only after an EPIPE on the same stream", async () => {
  const r = await runFixture("epipe-then-destroyed");
  expect(r.code).toBe(70);
  expect(r.report).toEqual([
    { diagnostic: "Writing command output to stderr failed", code: "ERR_STREAM_DESTROYED" },
    { stdoutCodes: [0, 0], stderrCode: 70 },
  ]);
});

test("overlapping run calls are rejected before effects; the first run completes", async () => {
  const r = await runFixture("overlap");
  expect(r.code).toBe(0);
  expect(r.report).toEqual([
    {
      rejected: "cli-for-ai/node: run() is already in progress in this process; call it sequentially",
      first: 0,
      after: { stdoutError: 0, stderrError: 0, sigint: 0, sigterm: 0 },
    },
  ]);
  expect(r.stdout).toBe('{"status":"completed","data":"x"}\n');
});

test("a second run reading stdin gets the empty remainder instead of hanging", async () => {
  const r = await runFixture("stdin-twice", { stdin: "hello" });
  expect(r.code).toBe(0);
  expect(r.report).toEqual([{ first: 0, second: 0 }]);
  expect(r.stdout.trim().split("\n")).toEqual(['{"status":"completed","data":"hello"}', '{"status":"completed","data":""}']);
});

test("stdin destroyed before its end is a read failure, not empty input", async () => {
  const r = await runFixture("stdin-destroyed", { stdin: "unread" });
  expect(r.code).toBe(70);
  expect(r.report).toEqual([{ diagnostic: "Reading stdin failed" }, { returned: 70 }]);
});

test("a real non-EPIPE stdout failure (read-only fd) is observed within the run, exits 70 and does not crash afterwards", async () => {
  const stdioFixture = resolve(import.meta.dirname, "fixtures/stdio-error.mjs");
  const dir = mkdtempSync(join(tmpdir(), "stdio-error-"));
  const target = join(dir, "readonly.txt");
  writeFileSync(target, "");
  for (const observe of [false, true]) {
    const reportFile = join(dir, `report-${observe}.jsonl`);
    const fd = openSync(target, "r");
    const child = spawn(process.execPath, [stdioFixture], {
      stdio: ["ignore", fd, "pipe"],
      env: { ...process.env, FIXTURE_REPORT: reportFile, ...(observe ? { OBSERVE: "1" } : {}) },
    });
    closeSync(fd);
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const status = await new Promise((done) => child.on("close", (code) => done(code)));
    clearTimeout(timer);
    const events = readFileSync(reportFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(status, stderr).toBe(70);
    expect(stderr).toBe('diagnostic OUTPUT_DELIVERY_FAILED: "Writing command output to stdout failed"\n');
    const names = events.map((e) => e.event);
    expect(events.find((e) => e.event === "diagnostic")).toMatchObject({ code: "EBADF" });
    // Without an observer nothing is left listening, yet no late error crashes the process.
    expect(events.find((e) => e.event === "returned")).toMatchObject({ code: 70, listeners: observe ? 1 : 0 });
    expect(names.at(-1)).toBe("exit");
    if (observe) expect(names.indexOf("error-event")).toBeLessThan(names.indexOf("returned"));
  }
});

describe("payload commands in a real process", () => {
  const payloadFixture = resolve(import.meta.dirname, "fixtures/payload.mjs");
  const spawnPayload = (argv: string[]) => {
    const reportFile = join(mkdtempSync(join(tmpdir(), "payload-")), "report.jsonl");
    const child = spawn(process.execPath, [payloadFixture, ...argv], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FIXTURE_REPORT: reportFile } });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        done({ code, signal });
      }),
    );
    const report = () => {
      const text = existsSync(reportFile) ? readFileSync(reportFile, "utf8").trim() : "";
      return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
    };
    return { child, closed, report, stderr: () => stderr };
  };

  test("records arrive before the source ends; a reader closing early stops the source and exits 70 with OUTPUT_CLOSED", async () => {
    const run = spawnPayload(["endless"]);
    let first = "";
    run.child.stdout!.setEncoding("utf8").once("data", (chunk: string) => {
      first = chunk;
      run.child.stdout!.destroy();
    });
    expect(await run.closed).toEqual({ code: 70, signal: null });
    // The source never ends by itself, so this line was written while it was still producing.
    expect(JSON.parse(first.split("\n")[0]!)).toEqual({ n: 1, text: "line one\nline two" });
    const failure = JSON.parse(run.stderr().trimEnd().split("\n").at(-1)!);
    expect(failure.error).toEqual({ code: "OUTPUT_CLOSED", message: "The output reader closed before the payload was complete" });
    expect(failure.payload.complete).toBe(false);
    expect(failure.payload.recordsWritten).toBeGreaterThanOrEqual(1);
    const events = run.report();
    expect(events.find((e) => "finalized" in e)).toMatchObject({ aborted: true });
    expect(events.map((e) => Object.keys(e)[0])).toEqual(["finalized", "disposed", "returned"]);
    expect(events.at(-1)).toEqual({ returned: 70 });
  });

  test.each([
    ["ENOTCONN", "OUTPUT_CLOSED", undefined],
    ["EPIPE", "OUTPUT_CLOSED", undefined],
    ["EIO", "OUTPUT_FAILED", "Writing the payload to stdout failed"],
  ])("a payload stdout %s is %s (70)", async (code, expected, diagnostic) => {
    const reportFile = join(mkdtempSync(join(tmpdir(), "payload-")), "report.jsonl");
    const child = spawn(process.execPath, [payloadFixture, "count", "--n", "3"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, FIXTURE_REPORT: reportFile, STDOUT_ERROR: code },
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (c) => (stderr += c));
    expect(await new Promise((done) => child.on("close", done))).toBe(70);
    expect(JSON.parse(stderr.trimEnd().split("\n").at(-1)!).error.code).toBe(expected);
    const events = readFileSync(reportFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.filter((e) => "diagnostic" in e).map((e) => e.diagnostic)).toEqual(diagnostic ? [diagnostic] : []);
  });

  test("a payload failure whose stderr report cannot be written is diagnosed once and keeps exit 1", async () => {
    const reportFile = join(mkdtempSync(join(tmpdir(), "payload-")), "report.jsonl");
    const child = spawn(process.execPath, [payloadFixture, "missing"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, FIXTURE_REPORT: reportFile, STDERR_ERROR: "EIO" },
    });
    let stdout = "";
    child.stdout!.setEncoding("utf8").on("data", (c) => (stdout += c));
    expect(await new Promise((done) => child.on("close", done))).toBe(1);
    expect(stdout).toBe("");
    const events = readFileSync(reportFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events).toEqual([{ disposed: true }, { diagnostic: "Writing the payload failure report to stderr failed", code: "EIO" }, { returned: 1 }]);
  });

  test("with pipefail, taking a prefix with head reports the incomplete export", async () => {
    const script = `set -o pipefail; "${process.execPath}" "${payloadFixture}" endless 2>/dev/null | head -n 2 >/dev/null; echo "status=$?"`;
    const shell = spawn("/bin/bash", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    shell.stdout!.setEncoding("utf8").on("data", (c) => (out += c));
    await new Promise((done) => shell.on("close", done));
    expect(out).toBe("status=70\n");
  });

  test("SIGINT while streaming is INTERRUPTED (130), with the source finalized and the context disposed", async () => {
    const run = spawnPayload(["endless"]);
    let sent = false;
    run.child.stdout!.on("data", () => {
      if (!sent) {
        sent = true;
        run.child.kill("SIGINT");
      }
    });
    expect(await run.closed).toEqual({ code: 130, signal: null });
    expect(JSON.parse(run.stderr().trimEnd().split("\n").at(-1)!).error.code).toBe("INTERRUPTED");
    expect(run.report().map((e) => Object.keys(e)[0])).toEqual(["finalized", "disposed", "returned"]);
  });

  test("a large payload is delivered completely, one JSON object per line", async () => {
    const run = spawnPayload(["count", "--n", "50000"]);
    let buffered = "";
    let lines = 0;
    let last: unknown;
    run.child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buffered += chunk;
      const parts = buffered.split("\n");
      buffered = parts.pop()!;
      for (const part of parts) {
        last = JSON.parse(part);
        lines++;
      }
    });
    expect(await run.closed).toEqual({ code: 0, signal: null });
    expect(buffered).toBe("");
    expect(lines).toBe(50000);
    expect(last).toEqual({ i: 50000, pad: "x".repeat(100) });
    expect(run.stderr()).toBe("");
  });
});

describe("a payload write still pending when the run is cancelled", () => {
  const pendingFixture = resolve(import.meta.dirname, "fixtures/pending-write.mjs");

  /**
   * The reader never reads, so the first large record stays queued in stdout. Events arrive on
   * fd 3. SIGINT is sent once the write is buffered; then(after) runs once the source is finalized,
   * the context disposed and the interruption report received on stderr.
   */
  function stalled(after: (child: ReturnType<typeof spawn>) => void) {
    const child = spawn(process.execPath, [pendingFixture, "export"], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    child.stdout!.pause();
    const events: Record<string, unknown>[] = [];
    let stderr = "";
    let sent = false;
    let acted = false;
    const maybeAct = () => {
      if (acted || !events.some((e) => e.event === "disposed") || !stderr.includes('"INTERRUPTED"')) return;
      acted = true;
      after(child);
    };
    child.stderr!.setEncoding("utf8").on("data", (c) => {
      stderr += c;
      maybeAct();
    });
    let buffer = "";
    (child.stdio[3] as NodeJS.ReadableStream).setEncoding("utf8");
    (child.stdio[3] as NodeJS.ReadableStream).on("data", (c: string) => {
      buffer += c;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const e = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        events.push(e);
        if (e.event === "write-buffered" && !sent) {
          sent = true;
          child.kill("SIGINT");
        }
        maybeAct();
      }
    });
    const safety = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      child.on("close", (code, signal) => {
        clearTimeout(safety);
        done({ code, signal });
      }),
    );
    return { closed, events, stderr: () => stderr };
  }

  const names = (events: Record<string, unknown>[]) => events.map((e) => e.event);

  test.each([
    ["closes", (child: ReturnType<typeof spawn>) => child.stdout!.destroy(), "EPIPE"],
    ["resumes reading", (child: ReturnType<typeof spawn>) => child.stdout!.resume(), null],
  ] as const)("when the reader then %s, run returns only after the queued write finishes and exits 130", async (_name, after, code) => {
    const run = stalled(after);
    expect(await run.closed).toEqual({ code: 130, signal: null });
    // A closed reader also closes the stdout socket; run waits for that too.
    const order = names(run.events).filter((name) => name !== "stdout-close");
    expect(order).toEqual(["write-buffered", "sigint", "source-finalized", "disposed", "write-callback", "run-returned", "exit"]);
    if (code) expect(names(run.events).indexOf("stdout-close")).toBeLessThan(names(run.events).indexOf("run-returned"));
    expect(run.events.find((e) => e.event === "write-callback")).toMatchObject({ code });
    // Listeners and signal handlers were still installed while the write was pending, and removed after.
    expect(run.events.find((e) => e.event === "disposed")).toMatchObject({ stdoutErrorListeners: 1, sigint: 2 });
    expect(run.events.find((e) => e.event === "run-returned")).toMatchObject({ code: 130, stdoutErrorListeners: 0, sigint: 1 });
    expect(run.stderr()).not.toMatch(/Unhandled|node:events/);
    expect(JSON.parse(run.stderr().trimEnd().split("\n").at(-1)!).error.code).toBe("INTERRUPTED");
  });

  test("a second signal forces exit 130 while the reader stays stalled", async () => {
    const run = stalled((child) => child.kill("SIGINT"));
    expect(await run.closed).toEqual({ code: 130, signal: null });
    const order = names(run.events);
    expect(order).not.toContain("run-returned");
    expect(order).not.toContain("write-callback");
    expect(order.slice(0, 4)).toEqual(["write-buffered", "sigint", "source-finalized", "disposed"]);
  });
});

describe("conditional stdin in a real process", () => {
  const whenFixture = resolve(import.meta.dirname, "fixtures/stdin-when.mjs");
  const start = (argv: string[]) => {
    const child = spawn(process.execPath, [whenFixture, ...argv], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr!.setEncoding("utf8").on("data", (c) => (stderr += c));
    let timedOut = false;
    const safety = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10_000);
    const closed = new Promise<{ code: number | null; timedOut: boolean }>((done) =>
      child.on("close", (code) => {
        clearTimeout(safety);
        done({ code, timedOut });
      }),
    );
    return { child, closed, stdout: () => stdout, stderr: () => stderr };
  };

  test("an unselected invocation finishes while the stdin pipe stays open", async () => {
    const run = start(["locate", "all"]);
    // Stdin is never ended here: the process must not wait for EOF.
    const result = await run.closed;
    expect(result).toEqual({ code: 0, timedOut: false });
    expect(JSON.parse(run.stdout())).toEqual({ status: "completed", data: { scope: "all", ids: null } });
    run.child.stdin!.destroy();
  });

  test("a selected invocation reads the piped bytes to EOF", async () => {
    const run = start(["locate", "-"]);
    run.child.stdin!.end("id-1\nid-2\n");
    expect(await run.closed).toEqual({ code: 0, timedOut: false });
    expect(JSON.parse(run.stdout()).data).toEqual({ scope: "-", ids: ["id-1", "id-2"] });
  });

  test("a selected invocation waiting on an open pipe is still interrupted by SIGINT", async () => {
    const run = start(["locate", "-"]);
    run.child.stdin!.write("id-1\n");
    let sent = false;
    run.child.stderr!.on("data", () => {
      if (!sent && run.stderr().includes("listening")) {
        sent = true;
        run.child.kill("SIGINT");
      }
    });
    expect(await run.closed).toEqual({ code: 130, timedOut: false });
    expect(run.stdout()).toBe("");
    expect(fixtureFailure(run.stderr()).error.code).toBe("INTERRUPTED");
    run.child.stdin!.destroy();
  });
});
