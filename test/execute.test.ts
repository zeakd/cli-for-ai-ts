import { resultJson } from "./support/result-json.ts";
import { describe, expect, test } from "vitest";
import { accepted, application, applicationSchema, AuthoringError, authoring, check, command, completed, execute, failed, group, output, parseInvocation, type CommandSchema, type ExecuteOptions, type GroupSchema } from "../src/index.ts";
import { app, echo, type Ctx } from "./fixture.ts";

function harness(overrides: Partial<ExecuteOptions<Ctx>> = {}) {
  const effects: string[] = [];
  const ctx: Ctx = { greeting: "hello", calls: effects };
  const options: ExecuteOptions<Ctx> = {
    context: () => {
      effects.push("context");
      return ctx;
    },
    readStdin: async () => {
      effects.push("stdin");
      return '{"a":1}';
    },
    ...overrides,
  };
  return { effects, call: (...argv: string[]) => execute(app, argv, options) };
}

describe("results", () => {
  test("completed is JSON on stdout with exit 0", async () => {
    const { call, effects } = harness();
    const r = await call("echo", "a", "b");
    expect(r).toMatchObject({ exitCode: 0, kind: "success", stderr: "" });
    expect(resultJson(r)).toMatchObject({ status: "completed", data: { words: ["a", "b"], greeting: "hello" } });
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(effects).toEqual(["context", "echo"]);
  });

  test("accepted stays accepted", async () => {
    const r = await harness().call("jobs", "submit", "x");
    expect(r.exitCode).toBe(0);
    expect(resultJson(r)).toEqual({ status: "accepted", data: { id: "job-x" } });
  });

  test("a plain handler may return accepted directly, without result mapping", async () => {
    const direct = application({
      name: "t",
      version: "1",
      summary: "t",
      commands: { x: command({ summary: "x", output: output<{ id: number }>(), run: async () => accepted({ id: 7 }) }) },
    });
    const r = await execute(direct, ["x"], { context: () => undefined });
    expect(r.exitCode).toBe(0);
    expect(resultJson(r)).toEqual({ status: "accepted", data: { id: 7 } });
  });

  test("failed is JSON on stderr with exit 1", async () => {
    const r = await harness().call("jobs", "deep", "fail");
    expect(r).toMatchObject({ exitCode: 1, kind: "failed", stdout: "" });
    expect(resultJson(r)).toEqual({ status: "failed", error: { code: "NOPE", message: "It failed", details: { reason: "test" } } });
  });

  test("--human uses the renderer, or readable JSON without one; computation is unchanged", async () => {
    const { call, effects } = harness();
    expect((await call("echo", "a", "b", "--human")).stdout).toBe("a b\n");
    expect((await call("--human", "echo", "a")).stdout).toBe("a\n");
    expect((await call("jobs", "submit", "x", "--human")).stdout).toBe('Accepted; the work is not complete yet.\n{\n  "id": "job-x"\n}\n');
    const failure = await call("jobs", "deep", "fail", "--human");
    expect(failure).toMatchObject({ exitCode: 1, stdout: "", stderr: 'Error [NOPE]: It failed\n{\n  "reason": "test"\n}\n' });
    expect(effects.filter((e) => e === "echo")).toHaveLength(2);
  });
});

describe("no effects before input is valid", () => {
  test.each([
    [["echo"]],
    [["echo", "a", "--count", "7"]],
    [["echo", "a", "--nope"]],
    [["jobs", "nope"]],
    [["read", "extra"]],
  ])("%j is rejected with exit 2 and no context, stdin or handler", async (argv) => {
    const { call, effects } = harness();
    const r = await call(...argv);
    expect(r).toMatchObject({ exitCode: 2, kind: "invalid", stdout: "" });
    expect(resultJson(r).status).toBe("failed");
    expect(effects).toEqual([]);
  });

  test.each([[[]], [["--help"]], [["jobs"]], [["echo", "--help"]], [["read", "--help"]], [["--version"]]])(
    "discovery %j does not construct context or read stdin",
    async (argv) => {
      const { call, effects } = harness();
      const r = await call(...argv);
      expect(r.exitCode).toBe(0);
      expect(effects).toEqual([]);
    },
  );

  test("help output is identical for bare and --help paths", async () => {
    const { call } = harness();
    expect((await call()).stdout).toBe((await call("--help")).stdout);
    expect((await call("jobs", "deep")).stdout).toBe((await call("jobs", "deep", "--help")).stdout);
    expect((await call("echo", "--help")).stdout).toBe((await call("echo", "--help", "--human")).stdout);
  });
});

describe("stdin", () => {
  test("declared JSON stdin is read before context and passed as input.stdin", async () => {
    const { call, effects } = harness();
    const r = await call("read");
    expect(resultJson(r)).toEqual({ status: "completed", data: { received: { a: 1 } } });
    expect(effects).toEqual(["stdin", "context", "read"]);
  });

  test("malformed JSON stdin never echoes stdin fragments, in JSON or human mode", async () => {
    const marker = "ghp_MARKER_7f3a91";
    for (const extra of [[], ["--human"]]) {
      const { call, effects } = harness({ readStdin: async () => `${marker} not json` });
      const r = await call("read", ...extra);
      expect(r.exitCode).toBe(2);
      expect(r.stdout + r.stderr).not.toContain("MARKER");
      expect(effects).toEqual([]);
      if (extra.length === 0) {
        expect(resultJson(r).error).toEqual({ code: "INVALID_INPUT", message: "Invalid value: stdin is not valid JSON", details: { input: "stdin", expected: "json" } });
      }
    }
  });

  test("malformed JSON stdin is invalid input and prevents context", async () => {
    const { call, effects } = harness({ readStdin: async () => "{" });
    const r = await call("read");
    expect(r.exitCode).toBe(2);
    expect(resultJson(r).error).toMatchObject({ code: "INVALID_INPUT", details: { input: "stdin" } });
    expect(effects).toEqual([]);
  });

  test("a stdin reader rejected by cancellation is an interruption, not an internal error", async () => {
    const controller = new AbortController();
    const { call, effects } = harness({
      signal: controller.signal,
      readStdin: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
          controller.abort();
        }),
    });
    const r = await call("read");
    expect(r).toMatchObject({ exitCode: 130, kind: "interrupted", stdout: "" });
    expect(effects).toEqual([]);
  });

  test("commands without stdin never read it", async () => {
    const { call, effects } = harness();
    await call("echo", "a");
    expect(effects).not.toContain("stdin");
  });
});

describe("internal errors stay recognizable", () => {
  const boom = new Error("secret token abc123", { cause: new Error("root cause") });

  test.each([
    ["stdin reader", { readStdin: async () => { throw boom; } }, ["read"], "Reading stdin failed"],
    ["context factory", { context: () => { throw boom; } }, ["echo", "a"], "Creating the execution context failed"],
    ["missing stdin reader", { readStdin: undefined }, ["read"], "stdin is declared but no stdin reader was provided"],
  ] as const)("%s failure exits 70 with a fixed message", async (_name, overrides, argv, message) => {
    const r = await harness(overrides as Partial<ExecuteOptions<Ctx>>).call(...argv);
    expect(r).toMatchObject({ exitCode: 70, kind: "internal", stdout: "", stderr: expect.stringContaining(`diagnostic INTERNAL_ERROR: ${JSON.stringify(message)}\n`) });
    expect(resultJson(r).error).toEqual({ code: "INTERNAL_ERROR", message });
  });

  const { command: cmd } = authoring<unknown>();
  const make = (spec: Partial<Parameters<typeof cmd<{}, unknown>>[0]>) =>
    application({
      name: "t",
      version: "1",
      summary: "t",
      commands: { x: cmd({ summary: "x", output: output<unknown>(), run: () => completed(1), ...spec }) },
    });

  const THREW = "The command handler threw; whether it changed anything is unknown, so check state before retrying";

  test("failures before the handler returns are INTERNAL_ERROR without claims about effects", async () => {
    const cases: [ReturnType<typeof make>, string][] = [
      [make({ run: () => { throw boom; } }), THREW],
      [make({ run: async () => Promise.reject(boom) }), THREW],
      [make({ run: (() => ({ ok: true })) as never }), "The command handler did not return an Outcome"],
      [make({ run: (() => ({ status: "failed", error: { message: "no code" } })) as never }), "The command failure cannot be reported as code, message and JSON details"],
    ];
    for (const [target, message] of cases) {
      const r = await execute(target, ["x"], { context: () => undefined });
      expect(r).toMatchObject({ exitCode: 70, kind: "internal", stdout: "", stderr: expect.stringContaining(`diagnostic INTERNAL_ERROR: ${JSON.stringify(message)}\n`) });
      expect(resultJson(r).error).toEqual({ code: "INTERNAL_ERROR", message });
    }
  });

  test("failures after the handler returned are RESULT_NOT_REPORTED with the returned state", async () => {
    const cases: [ReturnType<typeof make>, string[], Record<string, unknown>][] = [
      [make({ result: () => { throw boom; } }), [], { stage: "result-mapping", handlerReturned: "completed" }],
      [make({ result: (() => ({ status: "accepted", data: 2 })) as never }), [], { stage: "result-mapping", handlerReturned: "completed" }],
      [make({ run: () => completed(10n) }), [], { stage: "serialization", handlerReturned: "completed" }],
      [make({ run: () => accepted(new Date(0)) }), [], { stage: "serialization", handlerReturned: "accepted" }],
      [make({ run: () => completed(new Map()), result: () => ({ status: "accepted" }) }), [], { stage: "serialization", handlerReturned: "completed", reportedStatus: "accepted" }],
      [make({ run: () => completed([1, undefined]) }), ["--human"], { stage: "serialization", handlerReturned: "completed" }],
      [make({ human: () => { throw boom; } }), ["--human"], { stage: "presentation", handlerReturned: "completed" }],
      [make({ human: (() => 5) as never, result: () => ({ status: "accepted" }) }), ["--human"], { stage: "presentation", handlerReturned: "completed", reportedStatus: "accepted" }],
    ];
    for (const [target, extra, details] of cases) {
      const r = await execute(target, ["x", ...extra], { context: () => undefined });
      expect(r, JSON.stringify(details)).toMatchObject({ exitCode: 70, kind: "unreported" });
      expect(r.stderr).toMatch(/^diagnostic RESULT_NOT_REPORTED: "[^\n]+"\n/);
      const fault = extra.includes("--human") ? undefined : resultJson(r).error;
      if (fault) {
        expect(fault).toMatchObject({ code: "RESULT_NOT_REPORTED", details });
        expect(fault.details).toEqual(details);
        expect(fault.message).toContain("Check state before retrying; nothing was rolled back.");
      } else {
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("Error [RESULT_NOT_REPORTED]: The command returned completed");
      }
    }
  });

  test("plain JSON rules: undefined object properties are omitted; a renderer-less --human uses the same projection", async () => {
    const target = make({ run: () => completed({ kept: 1, optional: undefined, nested: { gone: undefined } }) });
    expect(JSON.parse((await execute(target, ["x"], { context: () => undefined })).stdout)).toEqual({
      status: "completed",
      data: { kept: 1, nested: {} },
    });
    expect((await execute(target, ["x", "--human"], { context: () => undefined })).stdout).toBe('{\n  "kept": 1,\n  "nested": {}\n}\n');
  });

  test("causes reach only an explicit diagnostic callback; a failing callback is ignored", async () => {
    const target = make({ run: () => { throw boom; } });
    const plain = await execute(target, ["x"], { context: () => undefined });
    expect(plain.stdout + plain.stderr).not.toContain("secret");

    const seen: unknown[] = [];
    const observed = await execute(target, ["x"], { context: () => undefined, onDiagnostic: (d) => seen.push(d) });
    expect(seen).toEqual([{ message: THREW, cause: boom }]);
    expect(observed.stdout + observed.stderr).not.toContain("secret");

    const crashing = await execute(target, ["x"], {
      context: () => undefined,
      onDiagnostic: () => {
        throw new Error("sink down");
      },
    });
    expect(crashing).toMatchObject({ exitCode: 70, stdout: "", stderr: expect.stringContaining(`diagnostic INTERNAL_ERROR: ${JSON.stringify(THREW)}\n`) });
  });
});

describe("declared constraints", () => {
  const make = (overrides: { test?: (value: string) => unknown; rule?: (values: { from: number; to: number }) => unknown; shape?: (value: unknown) => unknown } = {}) => {
    const effects: string[] = [];
    const calls: string[] = [];
    const target = application({
      name: "t",
      version: "1",
      summary: "t",
      commands: {
        range: command({
          summary: "Range",
          input: {
            positionals: [
              { name: "from", summary: "from", type: "integer", required: true },
              { name: "to", summary: "to", type: "integer", required: true },
            ],
            options: {
              name: {
                summary: "Name",
                pattern: { regex: "ab|abc", description: "ab or abc" },
                check: check.string("not reserved", (v) => {
                  calls.push(`check ${v}`);
                  return (overrides.test ?? ((x: string) => x !== "abc"))(v) as boolean;
                }),
              },
              tag: { summary: "Tag", repeat: true, check: check.string("lowercase", (v) => v === v.toLowerCase()) },
            },
          },
          constraints: (rule) => [
            rule(["from", "to"], "from must not exceed to", (values) => {
              calls.push("rule");
              return (overrides.rule ?? (({ from, to }) => (from > to ? `from ${from} is greater than to ${to}` : undefined)))(values) as string | undefined;
            }),
          ],
          output: output<null>(),
          run: () => {
            effects.push("run");
            return completed(null);
          },
        }),
        load: command({
          summary: "Load",
          input: {
            stdin: {
              format: "json",
              summary: "numbers",
              shape: {
                description: "array of numbers",
                parse: (overrides.shape as never) ?? ((v: unknown) => (Array.isArray(v) && v.every((n) => typeof n === "number") ? { ok: true, value: v.map((n) => n * 2) } : { ok: false, reason: "expected numbers" })),
              },
            },
          },
          output: output<unknown>(),
          run: (input) => {
            effects.push("run");
            return completed(input.stdin);
          },
        }),
      },
    });
    const call = (argv: string[], stdin = "") =>
      execute(target, argv, {
        context: () => {
          effects.push("context");
        },
        readStdin: async () => {
          effects.push("stdin");
          return stdin;
        },
        onDiagnostic: (d) => effects.push(`diagnostic ${d.message}`),
      });
    return { effects, calls, call, target };
  };

  test("patterns match the whole value, including across alternation and before a final newline", async () => {
    const { call } = make();
    expect((await call(["range", "1", "2", "--name", "ab"])).exitCode).toBe(0);
    for (const bad of ["abcd", "xab", "ab\n", "a"]) {
      const r = await call(["range", "1", "2", "--name", bad]);
      expect(r.exitCode, JSON.stringify(bad)).toBe(2);
      expect(resultJson(r).error).toEqual({ code: "INVALID_INPUT", message: "Invalid value: --name", details: { input: "--name", rule: "pattern", expected: "ab or abc" } });
    }
  });

  test("check failures name the rule without echoing the value; repeated values are checked one by one", async () => {
    const { call } = make();
    const r = await call(["range", "1", "2", "--name", "abc"]);
    expect(resultJson(r).error).toEqual({ code: "INVALID_INPUT", message: "Invalid value: --name", details: { input: "--name", rule: "check", expected: "not reserved" } });
    expect(r.stdout).not.toContain('"abc"');
    expect((await call(["range", "1", "2", "--tag", "ok", "--tag", "SECRET-TOKEN"])).stdout).not.toContain("SECRET-TOKEN");
  });

  test("a cross-input rule is invalid input before stdin, context and run, and parseInvocation agrees", async () => {
    const { effects, call, target } = make();
    const r = await call(["range", "5", "1"]);
    expect(r).toMatchObject({ exitCode: 2, kind: "invalid" });
    expect(resultJson(r).error).toEqual({
      code: "INVALID_INPUT",
      message: "Invalid input: from 5 is greater than to 1",
      details: { inputs: ["from", "to"], expected: "from must not exceed to", reason: "from 5 is greater than to 1" },
    });
    expect(effects).toEqual([]);
    expect(parseInvocation(target, ["range", "5", "1"])).toMatchObject({ kind: "invalid" });
    expect(parseInvocation(target, ["range", "1", "5"])).toMatchObject({ kind: "run" });
  });

  test("help checks supplied values; rules run on help only when every input was given", async () => {
    const { call, calls } = make();
    expect((await call(["range", "--name", "xyz", "--help"])).exitCode).toBe(2);
    expect((await call(["range", "5", "--help"])).exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect((await call(["range", "5", "1", "--help"])).exitCode).toBe(2);
    expect(calls).toEqual(["rule"]);
  });

  test("custom checks and rules run once per parse", async () => {
    const { call, calls } = make();
    expect((await call(["range", "1", "2", "--name", "ab"])).exitCode).toBe(0);
    expect(calls).toEqual(["check ab", "rule"]);
  });

  test("rules receive only their inputs, frozen", async () => {
    let seen: unknown;
    const { call } = make({ rule: (values) => { seen = values; return undefined; } });
    await call(["range", "1", "2", "--tag", "a"]);
    expect(seen).toEqual({ from: 1, to: 2 });
    expect(Object.isFrozen(seen)).toBe(true);
  });

  test.each([
    ["a throwing check", { test: (): unknown => { throw new Error("secret"); } }, ["range", "1", "2", "--name", "ab"]],
    ["a non-boolean check", { test: (): unknown => "yes" }, ["range", "1", "2", "--name", "ab"]],
    ["an async check", { test: async (): Promise<unknown> => true }, ["range", "1", "2", "--name", "ab"]],
    ["a throwing rule", { rule: (): unknown => { throw new Error("secret"); } }, ["range", "1", "2"]],
    ["a rule returning a non-string", { rule: (): unknown => 42 }, ["range", "1", "2"]],
    ["a defective check on help", { test: (): unknown => { throw new Error("secret"); } }, ["range", "--name", "ab", "--help"]],
  ] as const)("%s is an internal error (70), never invalid input", async (_name, overrides, argv) => {
    const { effects, call } = make(overrides as never);
    const r = await call([...argv]);
    expect(r).toMatchObject({ exitCode: 70, kind: "internal" });
    expect(r.stdout + r.stderr).not.toContain("secret");
    expect(effects.filter((e) => !e.startsWith("diagnostic"))).toEqual([]);
    expect(effects.some((e) => e.startsWith("diagnostic"))).toBe(true);
  });

  test("help and schema publish constraints truthfully", async () => {
    const { call, target } = make();
    const help = (await call(["range", "--help"])).stdout;
    expect(help).toContain("must match /ab|abc/u as a whole: ab or abc, must be: not reserved");
    expect(help).toContain("Constraints:\n  from must not exceed to (reads from, to; checked on --help only when all are given)");
    expect((await call(["load", "--help"])).stdout).toContain("must be: array of numbers (custom check, not checked by --help)");
    const published = applicationSchema(target);
    const schema = published.commands.range as CommandSchema;
    expect(schema.input.options.name).toMatchObject({
      pattern: { regex: "ab|abc", flags: "u", match: "whole-value", description: "ab or abc" },
      check: { description: "not reserved", custom: true },
    });
    expect(schema.input.constraints).toEqual([{ inputs: ["from", "to"], description: "from must not exceed to", custom: true }]);
    expect((published.commands.load as CommandSchema).input.stdin?.shape).toEqual({ description: "array of numbers", custom: true });
  });

  test("stdin shape normalizes valid input and rejects invalid shape with exit 2 before context", async () => {
    const good = make();
    const ok = await good.call(["load"], "[1,2]");
    expect(resultJson(ok)).toEqual({ status: "completed", data: [2, 4] });
    expect(good.effects).toEqual(["stdin", "context", "run"]);
    const bad = make();
    const r = await bad.call(["load"], '["x"]');
    expect(r).toMatchObject({ exitCode: 2, kind: "invalid" });
    expect(resultJson(r).error).toEqual({
      code: "INVALID_INPUT",
      message: "Invalid value: stdin: expected numbers",
      details: { input: "stdin", expected: "array of numbers", reason: "expected numbers" },
    });
    expect(bad.effects).toEqual(["stdin"]);
    expect((await bad.call(["load", "--help"], "[1]")).exitCode).toBe(0);
    expect(bad.effects).toEqual(["stdin"]);
  });

  test.each([
    ["throws", () => { throw new Error("secret"); }],
    ["returns a bare value", () => [1]],
    ["returns ok without value", () => ({ ok: true })],
    ["returns a non-string reason", () => ({ ok: false, reason: 1 })],
    ["returns a promise", async () => ({ ok: true, value: 1 })],
  ])("a stdin shape parser that %s is an internal error", async (_name, shape) => {
    const { effects, call } = make({ shape });
    const r = await call(["load"], "[1]");
    expect(r).toMatchObject({ exitCode: 70, kind: "internal" });
    expect(effects.filter((e) => !e.startsWith("diagnostic"))).toEqual(["stdin"]);
  });
});

describe("failure wire", () => {
  const failing = (error: unknown) =>
    application({
      name: "t",
      version: "1",
      summary: "t",
      commands: { x: command({ summary: "x", output: output<null>(), run: () => failed(error as never) }) },
    });
  const call = (error: unknown, ...extra: string[]) => {
    const seen: unknown[] = [];
    return execute(failing(error), ["x", ...extra], { context: () => undefined, onDiagnostic: (d) => seen.push(d) }).then((r) => ({ ...r, seen }));
  };

  test("an Error subclass keeps its message and leaks no other fields", async () => {
    class ApiError extends Error {
      code = "API_ERROR";
      response = { headers: { authorization: "Bearer secret" } };
      details = { status: 503 };
    }
    const r = await call(new ApiError("service unavailable"));
    expect(r.exitCode).toBe(1);
    expect(resultJson(r)).toEqual({ status: "failed", error: { code: "API_ERROR", message: "service unavailable", details: { status: 503 } } });
    expect(r.stdout).not.toContain("secret");
    const human = await call(new ApiError("service unavailable"), "--human");
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe('Error [API_ERROR]: service unavailable\n{\n  "status": 503\n}\n');
  });

  test("plain objects with extra fields are projected to code, message and details", async () => {
    const r = await call({ code: "NOPE", message: "no", _tag: "Nope", request: { token: "secret" } });
    expect(resultJson(r).error).toEqual({ code: "NOPE", message: "no" });
  });

  test.each([
    ["a Date", { when: new Date(0) }],
    ["an undefined array element", { list: [undefined] }],
    ["NaN", { ratio: Number.NaN }],
    ["a bigint", { size: 10n }],
    ["a Map", { map: new Map() }],
    ["an accessor", Object.defineProperty({}, "lazy", { get: () => 1, enumerable: true })],
    ["a toJSON object", { value: { toJSON: () => "x" } }],
    ["an array", [1]],
    ["a cycle", (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })()],
  ])("details with %s are an internal error rather than silently changed", async (_name, details) => {
    let invoked = false;
    const guarded = typeof details === "object" && details !== null && "value" in details
      ? { value: { toJSON: () => { invoked = true; return "x"; } } }
      : details;
    const r = await call({ code: "NOPE", message: "no", details: guarded });
    expect(r).toMatchObject({ exitCode: 70, stdout: "", stderr: expect.stringContaining("diagnostic INTERNAL_ERROR: \"The command failure cannot be reported as code, message and JSON details\"\n") });
    expect(invoked).toBe(false);
    expect((r.seen[0] as { cause: { reason: string } }).cause.reason).toMatch(/^details/);
  });

  test.each([
    ["missing code", { message: "x" }],
    ["empty code", { code: "", message: "x" }],
    ["non-string message", { code: "X", message: 1 }],
    ["a string", "boom"],
  ])("a failure with %s is an internal error", async (_name, error) => {
    expect((await call(error)).exitCode).toBe(70);
  });

  test("nested plain data and null-prototype objects are copied; undefined properties are omitted", async () => {
    const details = Object.assign(Object.create(null), { list: [1, "two", { three: true }], nested: { value: null }, missing: undefined });
    const r = await call({ code: "NOPE", message: "no", details });
    expect(resultJson(r).error.details).toEqual({ list: [1, "two", { three: true }], nested: { value: null } });
  });
});

describe("output declarations and result mapping", () => {
  interface Probe {
    parses: unknown[];
    results: unknown[];
    renders: unknown[];
  }
  const build = (
    returned: () => unknown,
    options: { parse?: (data: unknown) => unknown; result?: (data: unknown) => unknown } = {},
  ) => {
    const probe: Probe = { parses: [], results: [], renders: [] };
    const target = application({
      name: "t",
      version: "1",
      summary: "t",
      commands: {
        x: command({
          summary: "x",
          output: options.parse
            ? output({
                parse: (data: unknown) => {
                  probe.parses.push(data);
                  return options.parse!(data);
                },
              })
            : output<unknown>(),
          run: returned as never,
          ...(options.result
            ? {
                result: ((data: unknown) => {
                  probe.results.push(data);
                  return options.result!(data);
                }) as never,
              }
            : {}),
          human: (data) => {
            probe.renders.push(data);
            return "rendered";
          },
        }),
      },
    });
    return { probe, call: (...extra: string[]) => execute(target, ["x", ...extra], { context: () => undefined }) };
  };

  let serial = 0;
  // Non-idempotent normalization: every call produces a different value.
  const stamp = (data: unknown) => ({ ...(data as object), stamp: ++serial });

  test("parse runs exactly once, before result mapping, and mapping sees the parsed data", async () => {
    const { probe, call } = build(() => completed({ count: 1 }), { parse: stamp, result: () => ({ status: "accepted" }) });
    const r = await call("--human");
    expect(r.exitCode).toBe(0);
    expect(probe.parses).toHaveLength(1);
    expect(probe.results).toEqual([probe.renders[0]]);
    expect((probe.results[0] as { stamp: number }).stamp).toBe(serial);
    const json = await build(() => completed({ count: 1 }), { parse: stamp, result: () => ({ status: "accepted" }) }).call();
    expect(resultJson(json)).toEqual({ status: "accepted", data: { count: 1, stamp: serial } });
  });

  test("failed validation calls neither result nor human", async () => {
    const { probe, call } = build(() => completed({ count: "two" }), {
      parse: () => {
        throw new TypeError("count must be an integer");
      },
      result: () => ({ status: "accepted" }),
    });
    const r = await call("--human");
    expect(r).toMatchObject({ exitCode: 70, kind: "unreported", stdout: "", stderr: expect.stringContaining("diagnostic RESULT_NOT_REPORTED: \"the result does not match its output declaration\"\n") });
    expect(r.stderr).toContain('"stage": "output-parse"');
    expect(probe.results).toEqual([]);
    expect(probe.renders).toEqual([]);
  });

  test.each([
    ["replacing data", { status: "accepted", data: { count: 9 } }],
    ["an Outcome", accepted({ count: 9 })],
    ["an error field", { status: "completed", error: { code: "X", message: "x" } }],
    ["an unknown field", { status: "accepted", hints: [] }],
    ["an invalid status", { status: "failed" }],
    ["a string", "accepted"],
  ])("result returning %s is an internal error", async (_name, mapping) => {
    const { probe, call } = build(() => completed({ count: 1 }), { result: () => mapping });
    const r = await call();
    expect(r).toMatchObject({ exitCode: 70, stdout: "", stderr: expect.stringContaining("diagnostic RESULT_NOT_REPORTED: \"the result mapping failed or did not return {status}\"\n") });
    expect(probe.renders).toEqual([]);
  });

  test("a directly accepted result is validated and kept without result mapping", async () => {
    const { probe, call } = build(() => accepted({ count: 3 }), { parse: stamp, result: () => ({ status: "completed" }) });
    const r = await call();
    expect(resultJson(r)).toEqual({ status: "accepted", data: { count: 3, stamp: serial } });
    expect(probe.parses).toHaveLength(1);
    expect(probe.results).toEqual([]);
  });

  test("failures are neither parsed nor mapped", async () => {
    const { probe, call } = build(() => failed({ code: "NOPE", message: "no" }), { parse: stamp, result: () => ({ status: "accepted" }) });
    expect((await call()).exitCode).toBe(1);
    expect(probe.parses).toEqual([]);
    expect(probe.results).toEqual([]);
  });

  test("without parse, data passes through unchecked", async () => {
    const { call } = build(() => completed({ anything: true }));
    expect(JSON.parse((await call()).stdout)).toEqual({ status: "completed", data: { anything: true } });
  });
});

describe("reporting facts stay consistent", () => {
  const app1 = (spec: Record<string, unknown>) =>
    application({
      name: "t",
      version: "1",
      summary: "t",
      commands: { x: command({ summary: "x", output: output<unknown>(), run: () => completed(1), ...spec } as never) },
    });

  test("cleanup failure after a remapped status keeps what the handler returned", async () => {
    const r = await execute(app1({ run: () => completed({ id: 1 }), result: () => ({ status: "accepted" }) }), ["x"], {
      context: () => ({}),
      dispose: () => Promise.reject(new Error("stuck")),
    });
    expect(r).toMatchObject({ exitCode: 70, kind: "unreported" });
    const fault = resultJson(r).error;
    expect(fault.details).toEqual({ handlerReturned: "completed", reportedStatus: "accepted" });
    expect(fault.message).toMatch(/^The command returned completed,/);
  });

  test("--human with a renderer applies the same JSON projection as JSON output", async () => {
    let rendered = 0;
    const target = app1({ run: () => completed({ at: new Date(0) }), human: () => { rendered++; return "ok"; } });
    const json = await execute(target, ["x"], { context: () => ({}) });
    const human = await execute(target, ["x", "--human"], { context: () => ({}) });
    expect(json).toMatchObject({ exitCode: 70, kind: "unreported" });
    expect(human).toMatchObject({ exitCode: 70, kind: "unreported", stdout: "", stderr: expect.stringContaining("diagnostic RESULT_NOT_REPORTED: \"the result is not plain JSON data\"\n") });
    expect(rendered).toBe(0);
    for (const value of [10n, new Map()]) {
      expect((await execute(app1({ run: () => completed(value), human: () => "ok" }), ["x", "--human"], { context: () => ({}) })).exitCode).toBe(70);
    }
  });

  test("the renderer gets isolated plain data and cannot change the reported outcome", async () => {
    const original = { count: 1, nested: { list: [1] } };
    const target = app1({
      run: () => completed(original),
      human: (data: { count: number; nested: { list: number[] } }) => {
        data.count = 99;
        data.nested.list.push(2);
        return "mutated";
      },
    });
    const human = await execute(target, ["x", "--human"], { context: () => ({}) });
    const json = await execute(target, ["x"], { context: () => ({}) });
    expect(human.stdout).toBe("mutated\n");
    expect(human.outcome).toEqual({ status: "completed", data: { count: 1, nested: { list: [1] } } });
    expect(human.outcome).toEqual(json.outcome);
    expect(original).toEqual({ count: 1, nested: { list: [1] } });
  });

  test("G: exotic data after a recognized success keeps the success facts", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    let deep: unknown = 0;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    for (const data of [proxy, deep]) {
      const r = await execute(app1({ run: () => completed(data) }), ["x"], { context: () => ({}) });
      expect(r).toMatchObject({ exitCode: 70, kind: "unreported" });
      expect(resultJson(r).error.details).toEqual({ stage: "serialization", handlerReturned: "completed" });
    }
    const unreadable = new Proxy({ status: "accepted" }, { has: () => { throw new Error("trap"); } });
    const u = await execute(app1({ run: () => unreadable }), ["x"], { context: () => ({}) });
    expect(resultJson(u).error.details).toEqual({ stage: "serialization", handlerReturned: "accepted" });
  });

  test("G: unrecognizable envelopes are internal errors without fabricated success", async () => {
    const trap = new Proxy({}, { get: () => { throw new Error("secret trap"); } });
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const returned of [trap, revoked, { status: "completed" }]) {
      const r = await execute(app1({ run: () => returned }), ["x"], { context: () => ({}) });
      expect(r).toMatchObject({ exitCode: 70, kind: "internal" });
      expect(r.stdout + r.stderr).not.toContain("secret");
      expect(resultJson(r).error.details).toBeUndefined();
    }
    const { proxy: badFault, revoke: revokeFault } = Proxy.revocable({ code: "X", message: "m" }, {});
    revokeFault();
    expect((await execute(app1({ run: () => failed(badFault as never) }), ["x"], { context: () => ({}) })).exitCode).toBe(70);
    const mapping = new Proxy({ status: "accepted" }, { ownKeys: () => { throw new Error("trap"); } });
    const m = await execute(app1({ result: () => mapping }), ["x"], { context: () => ({}) });
    expect(resultJson(m).error.details).toEqual({ stage: "result-mapping", handlerReturned: "completed" });
  });
});

describe("context lifecycle", () => {
  const lifecycle = (
    run: (signal: AbortSignal) => ReturnType<typeof completed> | Promise<ReturnType<typeof completed>>,
    extra: Partial<ExecuteOptions<{ id: number }>> = {},
  ) => {
    const events: string[] = [];
    const target = application({
      name: "t",
      version: "1",
      summary: "t",
      commands: {
        x: authoring<{ id: number }>().command({
          summary: "x",
          output: output<unknown>(),
          run: (_input, ctx, { signal }) => {
            events.push(`run ${ctx.id}`);
            return run(signal);
          },
        }),
      },
    });
    const options: ExecuteOptions<{ id: number }> = {
      context: () => {
        events.push("create");
        return { id: 1 };
      },
      dispose: (ctx) => {
        events.push(`dispose ${ctx.id}`);
      },
      ...extra,
    };
    return { events, call: (...argv: string[]) => execute(target, ["x", ...argv], options) };
  };

  test.each([
    ["success", () => completed(1), 0],
    ["failure", () => failed({ code: "NOPE", message: "no" }), 1],
    ["throw", () => { throw new Error("bug"); }, 70],
    ["unreported", () => completed(10n), 70],
  ] as const)("dispose runs exactly once after %s", async (_name, handler, exitCode) => {
    const { events, call } = lifecycle(handler as never);
    expect((await call()).exitCode).toBe(exitCode);
    expect(events).toEqual(["create", "run 1", "dispose 1"]);
  });

  test("dispose runs after cooperative interruption", async () => {
    const controller = new AbortController();
    const { events, call } = lifecycle(
      async (signal) => {
        controller.abort();
        return signal.aborted ? failed({ code: "INTERRUPTED", message: "stopped" }) : completed(1);
      },
      { signal: controller.signal },
    );
    expect((await call()).exitCode).toBe(130);
    expect(events).toEqual(["create", "run 1", "dispose 1"]);
  });

  test("a context that finishes creation after abort is disposed and the run is interrupted", async () => {
    const controller = new AbortController();
    const { events, call } = lifecycle(() => completed(1), {
      signal: controller.signal,
      context: async () => {
        controller.abort();
        return { id: 7 };
      },
    });
    const r = await call();
    expect(r).toMatchObject({ exitCode: 130, kind: "interrupted" });
    expect(events).toEqual(["dispose 7"]);
  });

  test("a factory rejecting because of abort is an interruption; other rejections are internal", async () => {
    const controller = new AbortController();
    const aborted = lifecycle(() => completed(1), {
      signal: controller.signal,
      context: (signal) => {
        controller.abort();
        return Promise.reject(signal.reason);
      },
    });
    expect((await aborted.call()).exitCode).toBe(130);
    expect(aborted.events).toEqual([]);
    const broken = lifecycle(() => completed(1), { context: () => Promise.reject(new Error("db down")) });
    expect((await broken.call()).exitCode).toBe(70);
    expect(broken.events).toEqual([]);
  });

  test("cleanup failure after success is CONTEXT_CLEANUP_FAILED with the returned state, never exit 0", async () => {
    const seen: unknown[] = [];
    const { call } = lifecycle(() => completed(1), {
      dispose: () => Promise.reject(new Error("socket stuck")),
      onDiagnostic: (d) => seen.push(d),
    });
    const r = await call();
    expect(r).toMatchObject({ exitCode: 70, kind: "unreported", stdout: "", stderr: expect.stringContaining("diagnostic CONTEXT_CLEANUP_FAILED: \"Cleaning up the execution context failed\"\n") });
    expect(resultJson(r).error).toMatchObject({ code: "CONTEXT_CLEANUP_FAILED", details: { handlerReturned: "completed" } });
    expect(seen).toHaveLength(1);
  });

  test("cleanup failure keeps an existing failure or interruption classification", async () => {
    const failing = lifecycle(() => failed({ code: "NOPE", message: "no" }), { dispose: () => { throw new Error("x"); } });
    const r = await failing.call();
    expect(r).toMatchObject({ exitCode: 1, kind: "failed", stdout: "", stderr: expect.stringContaining("diagnostic CONTEXT_CLEANUP_FAILED: \"Cleaning up the execution context failed\"\n") });
    expect(resultJson(r).error.code).toBe("NOPE");
  });

  test("discovery, invalid input and context-free built-ins create nothing", async () => {
    const { events, call } = lifecycle(() => completed(1));
    await call("--help");
    await call("--nope");
    expect(events).toEqual([]);
  });
});

describe("cancellation", () => {
  test("an already aborted signal prevents context and handler", async () => {
    const controller = new AbortController();
    controller.abort();
    const { call, effects } = harness({ signal: controller.signal });
    const r = await call("echo", "a");
    expect(r).toMatchObject({ exitCode: 130, kind: "interrupted" });
    expect(resultJson(r).error.code).toBe("INTERRUPTED");
    expect(effects).toEqual([]);
  });

  test("a handler's completed result is reported even if cancellation arrives during it", async () => {
    const controller = new AbortController();
    const target = application({
      name: "t",
      version: "1",
      summary: "t",
      commands: {
        x: command({
          summary: "x",
          output: output<string>(),
          run: async (_i, _c, { signal }) => {
            controller.abort();
            return completed(signal.aborted ? "done anyway" : "?");
          },
        }),
      },
    });
    const r = await execute(target, ["x"], { context: () => undefined, signal: controller.signal });
    expect(r.exitCode).toBe(0);
    expect(resultJson(r).data).toBe("done anyway");
  });
});

describe("no built-in schema command", () => {
  test("schema is an unknown command, rejected before context, stdin or handlers", async () => {
    for (const argv of [["schema"], ["schema", "jobs"], ["schema", "--help"]]) {
      const { call, effects } = harness();
      const r = await call(...argv);
      expect(r, argv.join(" ")).toMatchObject({ exitCode: 2, kind: "invalid" });
      expect(resultJson(r).error).toMatchObject({ code: "UNKNOWN_COMMAND", message: "Unknown command: tool schema" });
      expect(effects).toEqual([]);
    }
  });

  test("bare and --help root help list only authored commands", async () => {
    const bare = (await harness().call()).stdout;
    expect(bare).toBe((await harness().call("--help")).stdout);
    expect(bare).not.toContain("schema");
    expect(bare).toMatch(/Commands:\n {2}echo .*\n {2}jobs <command> .*\n {2}read .*\n\n/);
  });

  test("authors may declare their own schema command, with its own constraints", async () => {
    const tree = { echo, jobs: app.spec.commands.jobs };
    const effects: string[] = [];
    let described: ReturnType<typeof applicationSchema> | undefined;
    const schemaCommand = command({
      summary: "Describe this tool",
      input: { positionals: [{ name: "path", summary: "Command path", variadic: true }] },
      constraints: (rule) => [
        rule(["path"], "path names a command or group", ({ path }) => (path.length === 0 || Object.hasOwn(tree, path[0]!) ? undefined : `${path[0]} is not a command`)),
      ],
      output: output<unknown>(),
      run: ({ path }) => {
        effects.push("run");
        return completed(path.length === 0 ? described : (described!.commands as Record<string, unknown>)[path[0]!]);
      },
    });
    const authored = application({ name: "tool", version: "1", summary: "t", commands: { ...tree, schema: schemaCommand } });
    described = applicationSchema(authored);
    const call = (...argv: string[]) => execute(authored, argv, { context: () => ({ greeting: "hi", calls: [] }) });

    expect(JSON.parse((await call("schema")).stdout).data.commands.schema.summary).toBe("Describe this tool");
    expect(JSON.parse((await call("schema", "jobs")).stdout).data).toMatchObject({ kind: "group" });
    const missing = await call("schema", "nope");
    expect(missing).toMatchObject({ exitCode: 2, kind: "invalid" });
    expect(resultJson(missing).error).toEqual({
      code: "INVALID_INPUT",
      message: "Invalid input: nope is not a command",
      details: { inputs: ["path"], expected: "path names a command or group", reason: "nope is not a command" },
    });
    // Rules on help run only when their inputs were given; a variadic counts once it has a value.
    expect((await call("schema", "nope", "--help")).exitCode).toBe(2);
    expect((await call("schema", "--help")).exitCode).toBe(0);
    expect(effects).toEqual(["run", "run"]);
    expect((await call()).stdout).toMatch(/\n {2}schema +Describe this tool\n/);
  });
});

describe("schema generation and version", () => {
  test("version is text", async () => {
    expect((await harness().call("--version")).stdout).toBe("tool 1.2.3\n");
  });

  test("applicationSchema describes the authored tree from declarations", () => {
    // oxlint-disable-next-line no-explicit-any -- deep assertions over generated JSON
    const schema = applicationSchema(app) as unknown as { commands: Record<string, any> };
    expect(Object.keys(schema.commands)).toEqual(["echo", "jobs", "read"]);
    expect(schema.commands.jobs.commands.deep).toMatchObject({ kind: "group", commands: { fail: { kind: "command" } } });
    expect(schema.commands.echo.input.options.count).toMatchObject({ type: "integer", syntax: "decimal-integer" });
    expect(schema.commands.echo.input.options.ratio).toMatchObject({ type: "number", syntax: "json-number" });
    expect(schema.commands.echo.input.options.format).toEqual({ type: "string", summary: "Output format", required: false, values: ["json", "csv"] });
    expect(schema.commands.echo.examples).toEqual([
      { summary: "Echo twice", invocation: "tool echo hi --count 2" },
      { summary: "Words that look like options", invocation: "tool echo --tag a --tag b --loud -- -x 'two words'" },
    ]);
    expect(schema.commands.read.input.stdin).toEqual({ format: "json", summary: "Any JSON" });

    expect(schema.commands.jobs.commands.submit).toMatchObject({ kind: "command", usage: "tool jobs submit <job>" });
  });

  test("help usage lines carry the application name", async () => {
    const help = (await harness().call("echo", "--help")).stdout;
    expect(help).toContain(
      "tool echo <first> [rest...] [--count <integer 1..3>] [--ratio <number>] [--format <json|csv>] [--tag <string>...] [--title <string>] [--loud]",
    );
    expect(help).toContain("tool echo hi --count 2");
    const root = (await harness().call()).stdout;
    expect(root).toContain("jobs <command>");
    expect(root).toMatch(/--help .*\n\s+--human .*\n\s+--version/);
    expect((await harness().call("jobs")).stdout).toContain("--human");
    expect((await harness().call("jobs")).stdout).not.toContain("--version");
  });
});

describe("result information in help", () => {
  const described = (fields?: unknown, extra: Record<string, unknown> = {}) =>
    application({
      name: "tool",
      version: "1",
      summary: "t",
      commands: {
        deep: group({
          summary: "Deep",
          commands: {
            list: command({
              summary: "List",
              output: output({ summary: "Items", ...(fields === undefined ? {} : { fields: fields as never }) }),
              run: () => completed({ items: [{ id: 1 }] }),
              ...extra,
            }),
          },
        }),
      },
    });

  test("root help carries the envelope, both success states and every exit class once", async () => {
    const target = described([{ path: "data.items[].id", summary: "Item id" }]);
    const root = (await execute(target, [], { context: () => ({}) })).stdout;
    expect(root).toBe((await execute(target, ["--help"], { context: () => ({}) })).stdout);
    expect(root).toContain("By default, successful results go to stdout; failures and diagnostics go to stderr:");
    expect(root).toContain("an error was reported; work may already have happened");
    expect(root).not.toContain("did not happen");
    expect(root).toContain("Check state before retrying; an error does not undo work.");
    expect(root).toContain('{"status":"completed","data":...}');
    expect(root).toContain('{"status":"accepted","data":...}');
    expect(root).toContain('{"status":"failed","error":{"code","message","details"?}}');
    for (const code of ["0", "1", "2", "70", "130"]) expect(root).toMatch(new RegExp(`\\n {4}${code} +\\S`));
    expect(root).toContain("work already done is not undone");
  });

  test("command help lists declared fields and refers to root help, without repeating the envelope", async () => {
    const target = described([
      { path: "data.items[]", summary: "Items" },
      { path: "data.items[].id", summary: "Item id" },
    ]);
    const help = (await execute(target, ["deep", "list", "--help"], { context: () => ({}) })).stdout;
    expect(help).toContain(
      [
        "Output:",
        "  Items",
        "  data.items[]     Items",
        "  data.items[].id  Item id",
        "  Successful JSON on stdout; failures on stderr. Use --human for readable output.",
        "  For result states and exit codes, run `tool --help`.",
      ].join("\n"),
    );
    expect(help).not.toContain("accepted");
    expect(help).not.toContain("Exit");
    expect(help).not.toContain('"status"');
  });

  test("without fields, command help shows the summary and the references only; nothing is invented", async () => {
    const help = (await execute(described(), ["deep", "list", "--help"], { context: () => ({}) })).stdout;
    expect(help).toContain("Output:\n  Items\n  Successful JSON on stdout; failures on stderr. Use --human for readable output.\n  For result states and exit codes, run `tool --help`.\n");
    expect(applicationSchema(described()).commands.deep).toMatchObject({ commands: { list: { output: { summary: "Items" } } } });
    expect((applicationSchema(described()).commands.deep as GroupSchema).commands.list).not.toHaveProperty("output.fields");
  });

  test("group help stays selective and points to root help", async () => {
    const help = (await execute(described([{ path: "data", summary: "All" }]), ["deep"], { context: () => ({}) })).stdout;
    expect(help).toContain("For result states and exit codes, run `tool --help`.");
    expect(help).not.toContain("data");
    expect(help).not.toContain('"status"');
  });

  test("root arrays and primitive results can be described; applicationSchema publishes the same metadata", () => {
    const fields = [
      { path: "data", summary: "Whole result" },
      { path: "data[]", summary: "Each entry" },
      { path: 'data[][" "]', summary: "A space key" },
      { path: 'data[]["two words"]', summary: "Keys with spaces" },
      { path: 'data[]["line\\nbreak"]', summary: "An escaped newline" },
      { path: 'data[]["a.b"]', summary: "Keys with dots" },
      { path: 'data[][""]', summary: "Empty key" },
      { path: 'data[]["[x]"].y', summary: "Brackets and a nested key" },
      { path: 'data[]["quote \\" and \\u00e9"]', summary: "JSON string escapes" },
    ];
    const list = (applicationSchema(described(fields)).commands.deep as GroupSchema).commands.list as CommandSchema;
    if (list.payload) throw new Error("expected an ordinary command");
    expect(list.output.fields).toEqual(fields);
  });

  test("malformed field descriptions are authoring errors", () => {
    const issues = (fields: unknown) => {
      try {
        command({ summary: "x", output: output({ fields: fields as never }), run: () => completed(null) });
      } catch (error) {
        return (error as AuthoringError).issues;
      }
      return [];
    };
    expect(issues("data")).toEqual(["output fields must be an array"]);
    expect(issues([{ path: "", summary: "s" }])).toEqual(["output field 0 has no path"]);
    expect(issues([{ path: "data.x", summary: " " }])).toEqual(["output field 0 has no summary"]);
    expect(issues([{ path: "data.x", summary: "s", type: "string" }])).toEqual(['output field 0 has unknown key "type"']);
    const grammar = (path: string) => `output field 0 path ${JSON.stringify(path)} must start with data and continue with .key, [] or ["key"] segments`;
    for (const bad of ["notes[].id", "data..x", "data.", "data[a]", 'data["a]', 'data["\\q"]', "datax", 'data.a"b', "data[0]"]) {
      expect(issues([{ path: bad, summary: "s" }]), bad).toEqual([grammar(bad)]);
    }
    expect(issues([{ path: "data.x", summary: "a" }, { path: "data.x", summary: "b" }])).toEqual(['output field 1 path "data.x" describes a field already described']);
    expect(issues([{ path: "data.x", summary: "a" }, { path: 'data["x"]', summary: "b" }])).toEqual(['output field 1 path "data[\\"x\\"]" describes a field already described']);
    expect(issues(["data.x"])).toEqual(["output field 0 must be an object"]);
    // Bare keys cannot carry whitespace or control characters; those keys use quoted form.
    for (const bad of ["data.na me", "data.a\nb", "data.a\tb", "data.a\u007fb", "data.a\u0085b", 'data["a\nb"]', 'data["a\u2028b"]']) {
      expect(issues([{ path: bad, summary: "s" }]), JSON.stringify(bad)).toEqual([grammar(bad)]);
    }
    // Sparse arrays: holes are rejected, not published as null.
    // oxlint-disable-next-line no-sparse-arrays
    expect(issues([, { path: "data.x", summary: "s" }])).toEqual(["output field 0 is missing"]);
    const holey: unknown[] = [];
    holey[1] = { path: "data.x", summary: "s" };
    expect(issues(holey)).toEqual(["output field 0 is missing"]);
  });

  test("field descriptions are snapshotted when the command is declared", async () => {
    const fields = [{ path: "data.items[]", summary: "Items" }];
    const decl = output({ summary: "Items", fields });
    const cmd = command({ summary: "x", output: decl, run: () => completed(null) });
    fields.push({ path: "data.late", summary: "Late" });
    fields[0]!.summary = "Changed";
    expect(cmd.spec.output.fields).toEqual([{ path: "data.items[]", summary: "Items" }]);
    expect(Object.isFrozen(cmd.spec.output.fields)).toBe(true);
  });
});
