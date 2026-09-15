// Author input contract: forwarded arguments, option value boundary, provided() in
// constraints, helpers, unknown keys, optional stdin and dynamicCommand, through the
// public API and execute().
import { describe, expect, test } from "vitest";
import { lintSchema, type SchemaShape } from "../src/lint/index.ts";
import {
  application,
  applicationSchema,
  AuthoringError,
  check,
  command,
  completed,
  dynamicCommand,
  execute,
  flag,
  group,
  integer,
  output,
  parseInvocation,
  payload,
  positional,
  stdinJson,
  renderHelp,
  string,
  stdinText,
  type ConstraintFactory,
  type ExecuteOptions,
} from "../src/index.ts";

interface Launch {
  contexts: number;
  launched: { kind: string; args: string[] }[];
}

/** A fake child launcher: the context records launches instead of starting processes. */
function launcher(): { state: Launch; options: ExecuteOptions<{ launch: (kind: string, args: string[]) => void }> } {
  const state: Launch = { contexts: 0, launched: [] };
  return {
    state,
    options: {
      context: () => {
        state.contexts++;
        return { launch: (kind: string, args: string[]) => state.launched.push({ kind, args }) };
      },
    },
  };
}

const spawn = command({
  summary: "Start an agent",
  input: {
    positionals: [{ name: "kind", summary: "Agent kind", required: true }],
    options: { detach: { summary: "Run in the background", type: "boolean" } },
    forward: { name: "agent-args", summary: "Arguments passed to the agent" },
  },
  constraints: (rule) => [
    rule(["detach", "agent-args"], "--detach needs arguments after --", ({ detach }, { provided }) =>
      detach && !provided("agent-args") ? "give the agent arguments after --" : undefined,
    ),
  ],
  examples: [
    { summary: "Choose a model", input: { kind: "claude", "agent-args": ["--model", "opus"] } },
    { summary: "Empty tail", input: { kind: "claude", detach: true, "agent-args": [] } },
  ],
  output: output<{ kind: string; args: string[] }>(),
  run: (input, ctx: { launch: (kind: string, args: string[]) => void }) => {
    ctx.launch(input.kind, input["agent-args"]);
    return completed({ kind: input.kind, args: input["agent-args"] });
  },
});

const app = application({
  name: "ops",
  version: "1.0.0",
  summary: "Ops",
  commands: { spawn, agent: group({ summary: "Agents", commands: { spawn } }) },
});

describe("forwarded arguments", () => {
  test("the tail after the first -- is passed through verbatim, flags and empty strings included", async () => {
    const { state, options } = launcher();
    const tail = ["--model", "opus", "", "--", "-h", "--help", "--human", "--json", "-"];
    const r = await execute(app, ["agent", "spawn", "claude", "--", ...tail], options);
    expect(r.exitCode).toBe(0);
    expect(state.launched).toEqual([{ kind: "claude", args: tail }]);
    expect(state.contexts).toBe(1);
  });

  test("no delimiter gives an empty tail; a bare delimiter counts as provided", async () => {
    const a = launcher();
    expect((await execute(app, ["spawn", "claude"], a.options)).exitCode).toBe(0);
    expect(a.state.launched).toEqual([{ kind: "claude", args: [] }]);
    const b = launcher();
    const refused = await execute(app, ["spawn", "claude", "--detach"], b.options);
    expect(refused.exitCode).toBe(2);
    expect(b.state.contexts).toBe(0);
    const c = launcher();
    expect((await execute(app, ["spawn", "claude", "--detach", "--"], c.options)).exitCode).toBe(0);
    expect(c.state.launched).toEqual([{ kind: "claude", args: [] }]);
  });

  test("extra arguments before the delimiter and a missing own argument fail before any context", async () => {
    const { state, options } = launcher();
    const stray = await execute(app, ["spawn", "claude", "stray", "--", "x"], options);
    expect(stray.exitCode).toBe(2);
    expect(stray.outcome).toMatchObject({ status: "failed", error: { code: "INVALID_INPUT", message: "Unexpected argument: stray", details: { hint: "arguments for <agent-args> go after --" } } });
    const missing = await execute(app, ["spawn", "--", "claude", "--model", "opus"], options);
    expect(missing.exitCode).toBe(2);
    expect(missing.outcome).toMatchObject({ error: { message: "Missing argument: <kind>" } });
    expect(state.contexts).toBe(0);
    expect(state.launched).toEqual([]);
  });

  test("an option before the delimiter is still parsed; after it, it belongs to the tail", () => {
    expect(parseInvocation(app, ["spawn", "claude", "--detach", "--", "--detach"])).toMatchObject({ kind: "run", input: { detach: true, "agent-args": ["--detach"] } });
  });

  test("help, usage, examples and schema describe the same boundary at every mount depth", () => {
    const depth1 = renderHelp(app, ["spawn"], spawn);
    const depth2 = renderHelp(app, ["agent", "spawn"], spawn);
    expect(depth1).toContain("ops spawn <kind> [--detach] [-- <agent-args>...]");
    expect(depth1).toContain("-- <agent-args>...  Arguments passed to the agent (every argument after -- is passed through unchanged)");
    expect(depth1).toContain('Arguments before -- cannot start with "-" (except "-" and negative numbers).');
    expect(depth1).toContain("  ops spawn claude -- --model opus");
    expect(depth1).toContain("  ops spawn claude --detach --");
    expect(depth2).toContain("  ops agent spawn claude -- --model opus");
    const schema = applicationSchema(app).commands.spawn;
    expect(schema).toMatchObject({ kind: "command", usage: "ops spawn <kind> [--detach] [-- <agent-args>...]", input: { forward: { name: "agent-args", summary: "Arguments passed to the agent" } } });
    expect(schema && "examples" in schema && schema.examples.map((e) => e.invocation)).toEqual(["ops spawn claude -- --model opus", "ops spawn claude --detach --"]);
  });

  test("the declaration is validated: no variadic positional alongside forward, no unknown keys, names claimed", () => {
    const bad = (input: unknown) => () => (command as unknown as (s: unknown) => unknown)({ summary: "x", input, output: output(), run: () => completed(null) });
    expect(bad({ positionals: [{ name: "rest", summary: "r", variadic: true }], forward: { name: "tail", summary: "t" } })).toThrow(/is variadic; a command with forward passes extra arguments only after --/);
    expect(bad({ forward: { name: "tail", summary: "t", sumary: "x" } })).toThrow(/forward has unknown key "sumary"/);
    expect(bad({ options: { tail: { summary: "o" } }, forward: { name: "tail", summary: "t" } })).toThrow(/forward "tail" duplicates another input name/);
    expect(bad({ forward: { name: "tail", summary: "" } })).toThrow(/forward has no summary/);
  });

  test("an example positional that starts like an option cannot precede a forward tail", () => {
    expect(() =>
      command({
        summary: "x",
        input: { positionals: [{ name: "kind", summary: "k", required: true }], forward: { name: "rest", summary: "r" } },
        examples: [{ summary: "dash", input: { kind: "-x" } }],
        output: output<null>(),
        run: () => completed(null),
      }),
    ).not.toThrow();
    expect(() =>
      application({
        name: "t",
        version: "1",
        summary: "t",
        commands: {
          x: command({
            summary: "x",
            input: { positionals: [{ name: "kind", summary: "k", required: true }], forward: { name: "rest", summary: "r" } },
            examples: [{ summary: "dash", input: { kind: "-x" } }],
            output: output<null>(),
            run: () => completed(null),
          }),
        },
      }),
    ).toThrow(/a positional value starting with "-" cannot be written before <rest>/);
  });

  test("without forward, -- keeps its end-of-options meaning", () => {
    const echo = command({ summary: "e", input: { positionals: [{ name: "words", summary: "w", variadic: true }] }, output: output<null>(), run: () => completed(null) });
    const plain = application({ name: "t", version: "1", summary: "t", commands: { echo } });
    expect(parseInvocation(plain, ["echo", "a", "--", "-x", "--"])).toMatchObject({ kind: "run", input: { words: ["a", "-x", "--"] } });
  });
});

describe("option value boundary", () => {
  const rename = command({
    summary: "Rename",
    input: { options: { name: { summary: "New name" }, count: { summary: "Count", type: "integer" } } },
    examples: [{ summary: "Dash name", input: { name: "--human" } }, { summary: "Plain", input: { name: "notes", count: -2 } }],
    output: output<{ name?: string; count?: number }>(),
    run: (input) => completed({ ...(input.name !== undefined ? { name: input.name } : {}), ...(input.count !== undefined ? { count: input.count } : {}) }),
  });
  const tool = application({ name: "tool", version: "1", summary: "t", commands: { rename } });
  const value = (...argv: string[]) => {
    const r = parseInvocation(tool, ["rename", ...argv]);
    return r.kind === "run" ? r.input : r;
  };

  test("lone - and negative JSON numbers are values; inline assignment takes any text", () => {
    expect(value("--name", "-")).toMatchObject({ name: "-" });
    expect(value("--name", "-3")).toMatchObject({ name: "-3" });
    expect(value("--name", "-1.5e3")).toMatchObject({ name: "-1.5e3" });
    expect(value("--count", "-3")).toMatchObject({ count: -3 });
    expect(value("--name=--human")).toMatchObject({ name: "--human" });
    expect(value("--name=")).toMatchObject({ name: "" });
    expect(value("--name=-x")).toMatchObject({ name: "-x" });
  });

  test("an option-shaped next token is a missing value with a generic hint that does not echo the token", () => {
    for (const next of ["--human", "-x", "--", "-01", "-3abc", "-secretToken"]) {
      const r = parseInvocation(tool, ["rename", "--name", next]);
      expect(r).toMatchObject({ kind: "invalid", fault: { code: "INVALID_INPUT", message: 'Missing value: --name. To give a value that starts with "-", write --name=<value>', details: { input: "--name", hint: "--name=<value>" } } });
      expect(JSON.stringify(r.kind === "invalid" ? r.fault : null)).not.toContain(next === "--" ? "\"--\"" : next);
    }
  });

  test("numeric value syntax is unchanged once the token is a value", () => {
    expect(value("--count=-01")).toMatchObject({ count: -1 });
    expect(parseInvocation(tool, ["rename", "--count=1.5"])).toMatchObject({ kind: "invalid", fault: { message: "Invalid value: --count 1.5" } });
  });

  test("examples use the inline spelling when a value starts like an option, and round-trip", () => {
    const help = renderHelp(tool, ["rename"], rename);
    expect(help).toContain("  tool rename --name=--human");
    expect(help).toContain("  tool rename --name notes --count -2");
  });

  test("short options are not aliases", () => {
    expect(parseInvocation(tool, ["rename", "-h"])).toMatchObject({ kind: "invalid", fault: { message: "Unknown option: -h" } });
  });
});

describe("constraints with provided()", () => {
  const needsWait = <A extends { timeout: number; wait: boolean }>(rule: ConstraintFactory<A>) =>
    rule(["timeout", "wait"], "--timeout requires --wait", ({ wait }, { provided }) => (provided("timeout") && !wait ? "add --wait" : undefined));
  const options = { wait: flag({ summary: "Wait" }), timeout: integer({ summary: "Seconds", min: 1, default: 30 }) };
  const send = command({ summary: "Send", input: { options }, constraints: (rule) => [needsWait(rule)], output: output<number>(), run: (input) => completed(input.timeout) });
  const poll = command({ summary: "Poll", input: { positionals: [{ name: "target", summary: "t", required: true }], options }, constraints: (rule) => [needsWait(rule)], output: output<number>(), run: (input) => completed(input.timeout) });
  const legacy = command({ summary: "Values only", input: { options }, constraints: (rule) => [rule(["wait"], "never", () => undefined)], output: output<null>(), run: () => completed(null) });
  const tool = application({ name: "tool", version: "1", summary: "t", commands: { send, legacy, nested: group({ summary: "n", commands: { poll } }) } });
  const ctx = { context: () => ({}) };

  test("an explicit value equal to the default is provided; an omitted one is not", async () => {
    expect((await execute(tool, ["send"], ctx)).outcome).toEqual({ status: "completed", data: 30 });
    expect((await execute(tool, ["send", "--timeout", "30"], ctx)).outcome).toMatchObject({ status: "failed", error: { message: "Invalid input: add --wait" } });
    expect((await execute(tool, ["send", "--wait", "--timeout", "30"], ctx)).exitCode).toBe(0);
  });

  test("a shared rule function binds to each command, at any depth", async () => {
    expect((await execute(tool, ["nested", "poll", "t1", "--timeout", "5"], ctx)).exitCode).toBe(2);
    expect((await execute(tool, ["nested", "poll", "t1", "--timeout", "5", "--wait"], ctx)).outcome).toEqual({ status: "completed", data: 5 });
    expect(applicationSchema(tool).commands.send).toMatchObject({ input: { constraints: [{ inputs: ["timeout", "wait"], description: "--timeout requires --wait" }] } });
  });

  test("help skips a rule until all of its inputs are given", async () => {
    expect((await execute(tool, ["send", "--timeout", "5", "--help"], ctx)).exitCode).toBe(0);
    expect((await execute(tool, ["send", "--timeout", "5", "--wait", "--help"], ctx)).exitCode).toBe(0);
  });

  test("one-argument checks keep working", async () => {
    expect((await execute(tool, ["legacy"], ctx)).exitCode).toBe(0);
  });

  test("asking about an input the rule does not name is a declared-rule defect", async () => {
    const probe = command({
      summary: "Probe",
      input: { options },
      constraints: (rule) => [rule(["wait"], "d", (_v, facts) => ((facts.provided as (n: string) => boolean)("timeout") ? "x" : undefined))],
      output: output<null>(),
      run: () => completed(null),
    });
    const r = await execute(application({ name: "t", version: "1", summary: "t", commands: { probe } }), ["probe"], ctx);
    expect(r.exitCode).toBe(70);
    expect(r.kind).toBe("internal");
  });
});

describe("unknown keys and copied diagnostics", () => {
  const untyped = <T>(f: T) => f as unknown as (spec: unknown) => unknown;

  test("a copied top-level hint is an unknown command key, rejected before any handler runs", () => {
    let ran = false;
    expect(() =>
      untyped(command)({
        summary: "copied",
        inputDeclaration: "input names are not literal; use dynamicCommand() for a declaration built at run time",
        input: { options: { anything: { summary: "a", required: true } } },
        output: output(),
        run: () => {
          ran = true;
          return completed(null);
        },
      }),
    ).toThrow(/unknown key "inputDeclaration"/);
    expect(ran).toBe(false);
  });

  test("a copied hint inside stdin.when is an unknown key", () => {
    expect(() =>
      untyped(command)({
        summary: "copied when",
        input: { positionals: [{ name: "scope", summary: "s" }], stdin: { summary: "ids", format: "text", when: { input: "scope", equals: "-", stdinWhen: "expected scope equals -" } } },
        output: output(),
        run: () => completed(null),
      }),
    ).toThrow(/stdin when has unknown key "stdinWhen"/);
  });

  test("existing command keys stay accepted; group and application reject unknown and symbol keys", () => {
    expect(() => command({ summary: "all keys", description: "d", input: {}, constraints: () => [], examples: [], output: output<string>(), run: () => completed("x"), result: () => ({ status: "completed" }), human: (d) => d })).not.toThrow();
    const leaf = command({ summary: "leaf", output: output<null>(), run: () => completed(null) });
    expect(() => untyped(group)({ summary: "g", commands: { leaf }, contextConflict: "x" })).toThrow(/unknown key "contextConflict"/);
    expect(() => untyped(application)({ name: "a", version: "1", summary: "a", commands: { leaf }, framingOption: "x" })).toThrow(/unknown key "framingOption"/);
    expect(() => untyped(command)({ summary: "sym", output: output(), run: () => completed(null), [Symbol("hint")]: "x" })).toThrow(AuthoringError);
  });
});

describe("stdin and helpers", () => {
  test("an inactive conditional stdin is not read and leaves no stdin key", async () => {
    let reads = 0;
    const locate = command({
      summary: "Locate",
      input: { positionals: [{ name: "scope", summary: "s", default: "all" }], stdin: stdinText({ summary: "ids", when: { input: "scope", equals: "-" } }) },
      output: output<{ hasKey: boolean; ids?: string }>(),
      run: (input) => completed({ hasKey: "stdin" in input, ...(input.stdin !== undefined ? { ids: input.stdin } : {}) }),
    });
    const tool = application({ name: "t", version: "1", summary: "t", commands: { locate } });
    const options = { context: () => ({}), readStdin: async () => (reads++, "a\nb") };
    expect((await execute(tool, ["locate"], options)).outcome).toEqual({ status: "completed", data: { hasKey: false } });
    expect(reads).toBe(0);
    expect((await execute(tool, ["locate", "-"], options)).outcome).toEqual({ status: "completed", data: { hasKey: true, ids: "a\nb" } });
  });

  test("helper declarations keep runtime validation: defaults, bounds, patterns and checks", () => {
    expect(() => command({ summary: "x", input: { options: { n: integer({ summary: "n", min: 5, default: 1 }) } }, output: output<null>(), run: () => completed(null) })).toThrow(/default is invalid: expected at least 5/);
    const named = command({
      summary: "x",
      input: { options: { id: string({ summary: "id", pattern: { regex: "[a-z]+", description: "letters" } }), n: integer({ summary: "n", check: check.number("even", (v) => v % 2 === 0) }) } },
      output: output<null>(),
      run: () => completed(null),
    });
    const tool = application({ name: "t", version: "1", summary: "t", commands: { named } });
    expect(parseInvocation(tool, ["named", "--id", "ABC"])).toMatchObject({ kind: "invalid", fault: { details: { rule: "pattern", expected: "letters" } } });
    expect(parseInvocation(tool, ["named", "--n", "3"])).toMatchObject({ kind: "invalid", fault: { details: { rule: "check", expected: "even" } } });
    expect(() => command({ summary: "x", input: { options: { mode: { summary: "m", values: ["fast", "slow"], default: "medium" } } }, output: output<null>(), run: () => completed(null) })).toThrow(/default is invalid: expected one of fast, slow/);
  });
});

describe("dynamicCommand", () => {
  const manifest: unknown = JSON.parse(
    JSON.stringify({
      positionals: [{ name: "id", summary: "Item", required: true }],
      options: { limit: { summary: "Limit", type: "integer", min: 1, default: 10 }, verbose: { summary: "v", type: "boolean" } },
      stdin: { summary: "extra", format: "json", when: { input: "verbose", equals: true } },
    }),
  );

  test("runtime-built declarations get the same validation, parsing, constraints and stdin selection", async () => {
    const plugin = dynamicCommand({
      summary: "Plugin",
      input: manifest as never,
      constraints: (rule) => [rule(["limit"], "explicit limit must be small", (values, { provided }) => (provided("limit") && (values.limit as number) > 50 ? "limit too large" : undefined))],
      examples: [{ summary: "One", input: { id: "a1", limit: 5 } }],
      output: output<Record<string, unknown>>(),
      run: (input) => completed({ ...input }),
    });
    const tool = application({ name: "tool", version: "1", summary: "t", commands: { plugins: group({ summary: "p", commands: { plugin } }) } });
    const options = { context: () => ({}), readStdin: async () => '{"x":1}' };
    expect((await execute(tool, ["plugins", "plugin", "a1"], options)).outcome).toEqual({ status: "completed", data: { id: "a1", limit: 10, verbose: false } });
    expect((await execute(tool, ["plugins", "plugin", "a1", "--verbose"], options)).outcome).toEqual({ status: "completed", data: { id: "a1", limit: 10, verbose: true, stdin: { x: 1 } } });
    expect((await execute(tool, ["plugins", "plugin", "a1", "--limit", "99"], options)).exitCode).toBe(2);
    expect((await execute(tool, ["plugins", "plugin", "a1", "--limit", "0"], options)).exitCode).toBe(2);
    expect(renderHelp(tool, ["plugins", "plugin"], plugin)).toContain("tool plugins plugin a1 --limit 5");
  });

  test("an invalid runtime-built declaration is rejected when declared", () => {
    const bad = JSON.parse('{"options":{"n":{"summary":"n","type":"integer","requried":true}}}');
    expect(() => dynamicCommand({ summary: "bad", input: bad, output: output<null>(), run: () => completed(null) })).toThrow(/option "n" has unknown key "requried"/);
  });
});

describe("declaration boundaries", () => {
  test("stdin helpers copy own data properties without running getters and keep command validation", () => {
    let reads = 0;
    const withGetter = Object.defineProperty({ summary: "s" }, "when", { enumerable: true, get: () => (reads++, { input: "x", equals: true }) });
    expect(() => stdinText(withGetter as never)).toThrow(/when is an accessor/);
    expect(() => stdinJson(Object.defineProperty({ summary: "s" }, "shape", { enumerable: false, value: undefined }) as never)).toThrow(/shape is not enumerable/);
    expect(() => flag(Object.defineProperty({}, "summary", { enumerable: true, get: () => (reads++, "s") }) as never)).toThrow(/summary is an accessor/);
    expect(reads).toBe(0);
    const extra = JSON.parse('{"summary":"s","required":true}');
    expect(() => command({ summary: "x", input: { stdin: stdinText(extra) }, output: output<null>(), run: () => completed(null) })).toThrow(AuthoringError);
    const whenScope = { summary: "ids", when: { input: "scope", equals: "-" } } as const;
    const tool = application({
      name: "t",
      version: "1",
      summary: "t",
      commands: {
        locate: command({
          summary: "Locate",
          input: { positionals: [positional("scope", string({ summary: "s", default: "all" }))], stdin: stdinText(whenScope) },
          output: output<string>(),
          run: (input) => completed(input.stdin ?? "none"),
        }),
      },
    });
    expect(parseInvocation(tool, ["locate", "-"])).toMatchObject({ kind: "run" });
    const wrong = JSON.parse('{"summary":"ids","when":{"input":"scop","equals":"-"}}');
    expect(() => command({ summary: "x", input: { positionals: [{ name: "scope", summary: "s" }], stdin: stdinText(wrong) }, output: output<null>(), run: () => completed(null) })).toThrow(AuthoringError);
  });

  test("a non-enumerable key is rejected, not dropped, at every level", () => {
    const hiddenRequired = Object.defineProperty({ summary: "n" }, "required", { enumerable: false, value: true });
    expect(() => command({ summary: "x", input: { options: { n: hiddenRequired } }, output: output<null>(), run: () => completed(null) })).toThrow(/required is not enumerable/);
    const hiddenTop = Object.defineProperty({ summary: "x", output: output<null>(), run: () => completed(null) }, "inputDeclaration", { enumerable: false, value: "hint" });
    expect(() => command(hiddenTop)).toThrow(/inputDeclaration is not enumerable/);
    const hiddenInput = Object.defineProperty({ summary: "x", output: output<null>(), run: () => completed(null) }, "input", { enumerable: false, value: { options: { n: { summary: "n", required: true } } } });
    expect(() => command(hiddenInput)).toThrow(/input is not enumerable/);
    // Arrays and frozen plain declarations are still accepted.
    const frozen = Object.freeze({ positionals: Object.freeze([Object.freeze({ name: "a", summary: "a" })]) });
    expect(() => command({ summary: "x", input: frozen, output: output<null>(), run: () => completed(null) })).not.toThrow();
  });

  test("an unknown option with an inline value repeats only its name", async () => {
    const marker = "sk-test-9f3c2b7e";
    const deploy = command({ summary: "Deploy", input: { options: { "api-token": { summary: "Token" } } }, output: output<null>(), run: () => completed(null) });
    const rows = command({ summary: "Rows", output: payload.jsonl(), run: () => completed(null) as never });
    const tool = application({ name: "t", version: "1", summary: "t", commands: { deploy, rows, ops: group({ summary: "o", commands: { deploy } }) } });
    const cases = [
      ["deploy", `--api-key=${marker}`],
      ["deploy", `--api-key=${marker}`, "--human"],
      ["deploy", `--api-key=${marker}`, "--help"],
      ["deploy", "--help", `--api-key=${marker}`],
      ["deploy", `-k=${marker}`],
      ["rows", `--api-key=${marker}`],
      [`--api-key=${marker}`],
      ["ops", `--api-key=${marker}`],
      ["ops", `--api-key=${marker}`, "--help"],
    ];
    for (const argv of cases) {
      const result = await execute(tool, argv, { context: () => ({}) });
      expect(result.exitCode, argv.join(" ")).toBe(2);
      expect(result.stdout + result.stderr, argv.join(" ")).not.toContain(marker);
      expect(JSON.stringify(parseInvocation(tool, argv)), argv.join(" ")).not.toContain(marker);
    }
    const near = parseInvocation(tool, ["deploy", `--api-tokn=${marker}`]);
    expect(near).toMatchObject({ kind: "invalid", fault: { message: "Unknown option: --api-tokn", details: { input: "--api-tokn", suggestion: "--api-token" } } });
    expect(JSON.stringify(near)).not.toContain(marker);
    expect(parseInvocation(tool, [`--hepl=${marker}`])).toMatchObject({ kind: "invalid", fault: { details: { input: "--hepl", suggestion: "--help" } } });
  });

  test("lintSchema checks the summary of forwarded arguments in a supplied schema", () => {
    const schema: SchemaShape = {
      name: "t",
      version: "1",
      summary: "t",
      commands: { spawn: { kind: "command", summary: "Spawn", input: { forward: { name: "agent-args", summary: " " } }, output: { summary: "o" } } },
    };
    expect(lintSchema(schema).filter((f) => f.rule === "summary-present").map((f) => f.message)).toEqual(['forwarded arguments <agent-args> of "spawn" have no summary']);
    expect(lintSchema(applicationSchema(app)).filter((f) => f.level === "error")).toEqual([]);
  });

  test("positional tuple unions: examples validate against the declared alternative at run time", () => {
    const x = { name: "x", summary: "x", required: true } as const;
    const y = { name: "y", summary: "y", required: true } as const;
    const both = JSON.parse("true") as boolean;
    const tuple: readonly [typeof x] | readonly [typeof x, typeof y] = both ? [x, y] : [x];
    const make = (examples: readonly { summary: string; input: { x: string } | { x: string; y: string } }[]) =>
      command({ summary: "pick", input: { positionals: tuple }, examples, output: output<string>(), run: (input) => completed("y" in input ? input.y : input.x) });
    const ok = make([{ summary: "both", input: { x: "a", y: "b" } }]);
    const tool = application({ name: "t", version: "1", summary: "t", commands: { ok } });
    expect(renderHelp(tool, ["ok"], ok)).toContain("t ok a b");
    // An example for the other alternative is rejected when the application is built.
    expect(() => application({ name: "t", version: "1", summary: "t", commands: { bad: make([{ summary: "x only", input: { x: "a" } }]) } })).toThrow();
  });
});

describe("positionals that may be absent", () => {
  const x = { name: "x", summary: "x", required: true } as const;
  // Built through parameters so the absent alternative is the one actually declared.
  function declared(tuple: readonly [typeof x] | undefined, examples: readonly { summary: string; input: {} | { x: string } }[]) {
    return command({ summary: "pick", input: { positionals: tuple }, examples, output: output<string>(), run: (input) => completed("x" in input ? input.x : "none") });
  }
  function wholeInput(input: { positionals: readonly [typeof x] } | undefined) {
    return command({ summary: "whole", input, output: output<string>(), run: (values) => completed("x" in values ? values.x : "none") });
  }

  test("examples are validated against the absent alternative that is actually declared", () => {
    expect(() => application({ name: "t", version: "1", summary: "t", commands: { pick: declared(undefined, [{ summary: "x", input: { x: "a" } }]) } })).toThrow(/example/);
    expect(() => application({ name: "t", version: "1", summary: "t", commands: { pick: declared(undefined, [{ summary: "none", input: {} }]) } })).not.toThrow();
    // A typed example that omits x fails closed when the tuple is present.
    expect(() => application({ name: "t", version: "1", summary: "t", commands: { pick: declared([x], [{ summary: "none", input: {} }]) } })).toThrow(/example/);
  });

  test("an argument for an absent positional is invalid and no context is created", async () => {
    let contexts = 0;
    const options = { context: () => (contexts++, {}) };
    const tool = application({ name: "t", version: "1", summary: "t", commands: { pick: declared(undefined, []), whole: wholeInput(undefined), present: declared([x], []) } });
    for (const argv of [["pick", "a"], ["whole", "a"], ["present"]]) {
      const result = await execute(tool, argv, options);
      expect(result.exitCode, argv.join(" ")).toBe(2);
    }
    expect(contexts).toBe(0);
    expect((await execute(tool, ["pick"], options)).outcome).toEqual({ status: "completed", data: "none" });
    expect((await execute(tool, ["whole"], options)).outcome).toEqual({ status: "completed", data: "none" });
    expect((await execute(tool, ["present", "a"], options)).outcome).toEqual({ status: "completed", data: "a" });
  });
});
