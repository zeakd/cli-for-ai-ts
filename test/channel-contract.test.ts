import { describe, expect, test } from "vitest";
import { application, applicationSchema, AuthoringError, command, completed, execute, executeTo, failed, output, OutputClosedError, payload, records } from "../src/index.ts";
import { diagnosticLine } from "../src/core/diagnostic.ts";

const context = () => ({});
const app = application({ name: "tool", version: "1.0.0", summary: "Channel tests", commands: {
  ok: command({ summary: "Success", output: output<string>(), run: () => completed("ok") }),
  fail: command({ summary: "Fail", output: output<string>(), run: () => failed({ code: "NOT_FOUND", message: "No item" }) }),
  defect: command({ summary: "Throw", output: output<string>(), run: () => { throw new Error("SECRET"); } }),
  stdin: command({ summary: "Read JSON", input: { stdin: { format: "json", summary: "JSON" } }, output: output<unknown>(), run: ({ stdin }) => completed(stdin) }),
} });

function reports(stderr: string) {
  return stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
}

describe("owned result channels", () => {
  test.each([["missing"], ["ok", "extra"], ["fail"], ["defect"]])("failure %j leaves stdout empty and one JSON report", async (...argv) => {
    const r = await execute(app, argv, { context });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(reports(r.stderr)).toHaveLength(1);
    expect(reports(r.stderr)[0].status).toBe("failed");
    expect(r.stderr).not.toContain("SECRET");
  });
  test("success and help retain stdout", async () => {
    for (const argv of [["ok"], ["--help"], ["--version"]]) {
      const r = await execute(app, argv, { context });
      expect(r.exitCode).toBe(0); expect(r.stdout).not.toBe(""); expect(r.stderr).toBe("");
    }
  });
  test("human failure vs invalid argv vs selected stdin", async () => {
    const human = await execute(app, ["fail", "--human"], { context });
    expect(human.stdout).toBe(""); expect(human.stderr).toBe("Error [NOT_FOUND]: No item\n");
    const invalid = await execute(app, ["ok", "extra", "--human"], { context });
    expect(invalid.stdout).toBe(""); expect(reports(invalid.stderr)).toHaveLength(1);
    const stdin = await execute(app, ["stdin", "--human"], { context, readStdin: async () => "bad" });
    expect(stdin.exitCode).toBe(2); expect(stdin.stdout).toBe(""); expect(stdin.stderr).toContain("Error [INVALID_INPUT]");
  });
  test("diagnostics cannot create extra physical lines; reports survive cleanup diagnostics", async () => {
    const line = diagnosticLine("INTERNAL_ERROR", 'x\n{"status":"failed"}\r\u2028\u2029');
    expect(line.split("\n")).toHaveLength(2);
    expect(line.startsWith("diagnostic INTERNAL_ERROR: ")).toBe(true);
    expect(line).not.toContain("\u2028");
    for (const name of ["ok", "fail", "defect"]) {
      const r = await execute(app, [name], { context, dispose: () => { throw new Error("cleanup SECRET"); } });
      expect(r.stdout).toBe(""); expect(reports(r.stderr)).toHaveLength(1);
      expect(r.stderr).toContain("diagnostic CONTEXT_CLEANUP_FAILED:"); expect(r.stderr).not.toContain("SECRET");
    }
  });
  test("stderr rejection is not recursively reported", async () => {
    let writes = 0; let diagnostics = 0;
    const r = await executeTo(app, ["fail"], { context,
      stdout: { write: async () => { throw new Error("Unexpected stdout"); } },
      stderr: { write: async () => { writes++; throw new Error("Broken stderr"); } },
      onDiagnostic: () => { diagnostics++; },
    });
    expect(r.exitCode).toBe(1); expect(writes).toBe(1); expect(diagnostics).toBe(1);
  });
});

function streamApp(mode: "allow" | "require-full", finalizer?: () => void) {
  const streamOutput = payload.text({ records: "rows", framing: "lf", readerClose: mode });
  return application({ name: "stream", version: "1", summary: "Stream", commands: {
    rows: command({ summary: "Rows", output: streamOutput,
      run: () => records((async function* () { try { yield "one"; yield "two"; } finally { finalizer?.(); } })()),
    }),
  } });
}

describe("reader closure is policy, not full delivery", () => {
  test.each(["allow", "require-full"] as const)("%s preserves source and cleanup order", async (mode) => {
    const order: string[] = []; let writes = 0;
    const a = streamApp(mode, () => order.push("source"));
    const r = await executeTo(a, ["rows"], { context, dispose: () => { order.push("context"); },
      stdout: { write: async () => { writes++; throw new OutputClosedError(); } }, stderr: { write: async () => {} },
    });
    expect(r.exitCode).toBe(mode === "allow" ? 0 : 70);
    expect(r.payload).toEqual({ recordsWritten: 0, complete: false });
    expect(order).toEqual(["source", "context"]); expect(writes).toBe(1);
  });
  test.each(["source", "context"])("allow never hides %s cleanup failure", async (which) => {
    const a = streamApp("allow", () => { if (which === "source") throw new Error("cleanup"); });
    const r = await executeTo(a, ["rows"], { context, dispose: () => { if (which === "context") throw new Error("cleanup"); },
      stdout: { write: async () => { throw new OutputClosedError(); } }, stderr: { write: async () => {} },
    });
    expect(r.exitCode).toBe(70); expect(r.payload?.complete).toBe(false);
  });
  test("late caller abort after allowed close does not reverse the terminal result", async () => {
    const signal = new AbortController();
    const a = streamApp("allow", () => signal.abort());
    const r = await executeTo(a, ["rows"], { context, signal: signal.signal,
      stdout: { write: async () => { throw new OutputClosedError(); } }, stderr: { write: async () => {} },
    });
    expect(r.exitCode).toBe(0); expect(r.payload?.complete).toBe(false);
  });
  test("caller abort before closure keeps interruption", async () => {
    const signal = new AbortController();
    const r = await executeTo(streamApp("allow"), ["rows"], { context, signal: signal.signal,
      stdout: { write: async () => { signal.abort(); throw new OutputClosedError(); } }, stderr: { write: async () => {} },
    });
    expect(r.exitCode).toBe(130); expect(r.payload?.complete).toBe(false);
  });
  test("exhaustion is complete and discovery states the policy", async () => {
    for (const mode of ["allow", "require-full"] as const) {
      const a = streamApp(mode); const r = await execute(a, ["rows"], { context });
      expect(r.exitCode).toBe(0); expect(r.payload).toEqual({ recordsWritten: 2, complete: true });
      expect((await execute(a, ["rows", "--help"], { context })).stdout).toContain(`Reader close: ${mode}`);
      expect(JSON.stringify(applicationSchema(a))).toContain(`"readerClose":"${mode}"`);
    }
  });
});


test("reader-close policy is validated and snapshotted at declaration", () => {
  for (const readerClose of ["ignore", false, null]) {
    expect(() => payload.jsonl({ readerClose } as never)).toThrow(AuthoringError);
    expect(() => payload.text({ records: "rows", framing: "lf", readerClose } as never)).toThrow(AuthoringError);
  }
  const declaration = { records: "rows", framing: "lf" as const, readerClose: "allow" as "allow" | "require-full" };
  const output = payload.text(declaration);
  declaration.readerClose = "require-full";
  expect(output.readerClose).toBe("allow");
  expect(Object.isFrozen(output)).toBe(true);
  expect(payload.jsonl().readerClose).toBe("require-full");
  expect(payload.text({ records: "rows", framing: "lf" }).readerClose).toBe("require-full");
});
