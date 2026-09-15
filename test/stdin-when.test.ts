import { resultJson } from "./support/result-json.ts";
import { describe, expect, test } from "vitest";
import {
  application,
  applicationSchema,
  AuthoringError,
  check,
  command,
  completed,
  execute,
  output,
  payload,
  records,
  type AnyCommand,
  type CommandSchema,
  type ExecuteOptions,
  type InputDecl,
} from "../src/index.ts";

interface Probe {
  reads: number;
  shapes: number;
  contexts: number;
  seen: unknown[];
}

function probe(): Probe {
  return { reads: 0, shapes: 0, contexts: 0, seen: [] };
}

function options(p: Probe, text = '["a","b"]'): ExecuteOptions<unknown> {
  return {
    context: () => {
      p.contexts++;
      return {};
    },
    readStdin: async () => {
      p.reads++;
      return text;
    },
  };
}

function locate(p: Probe) {
  return command({
    summary: "Locate",
    input: {
      positionals: [{ name: "scope", summary: "Scope, or - to read IDs from stdin", required: true }],
      options: {
        limit: { summary: "Limit", type: "integer", default: 10 },
        ids: { summary: "Read IDs", type: "boolean" },
        mode: { summary: "Mode", values: ["list", "stdin"], default: "list" },
      },
      stdin: {
        summary: "IDs as a JSON array",
        format: "json",
        when: { input: "scope", equals: "-" },
        shape: {
          description: "array of strings",
          parse: (value: unknown) => {
            p.shapes++;
            return Array.isArray(value) && value.every((v) => typeof v === "string") ? { ok: true as const, value: value as string[] } : { ok: false as const, reason: "expected strings" };
          },
        },
      },
    },
    output: output<{ scope: string; stdin: string[] | undefined; has: boolean }>(),
    run: (input) => {
      p.seen.push(input.stdin);
      return completed({ scope: input.scope, stdin: input.stdin, has: Object.hasOwn(input, "stdin") });
    },
  });
}

const appOf = (cmd: AnyCommand) => application({ name: "tool", version: "1", summary: "t", commands: { run: cmd } });

describe("stdin.when selects whether stdin is read", () => {
  test("a positional value selects stdin; any other value does not read it or require a reader", async () => {
    const p = probe();
    const app = appOf(locate(p));
    const selected = await execute(app, ["run", "-"], options(p));
    expect(resultJson(selected).data).toEqual({ scope: "-", stdin: ["a", "b"], has: true });
    expect(p).toMatchObject({ reads: 1, shapes: 1, contexts: 1 });

    // No readStdin at all: an unselected stdin needs no reader.
    const inactive = await execute(app, ["run", "all"], { context: () => ({}) });
    expect(inactive.exitCode).toBe(0);
    expect(resultJson(inactive).data).toEqual({ scope: "all", has: false });
    expect(p).toMatchObject({ reads: 1, shapes: 1 });
  });

  test("options, defaults, false booleans and absent optional values", async () => {
    const make = (when: { input: string; equals: string | number | boolean }, decl: InputDecl["options"]) => {
      const p = probe();
      const cmd = command({
        summary: "x",
        input: { options: decl, stdin: { summary: "s", format: "text", when } } as never,
        output: output<unknown>(),
        run: (input: { stdin?: string }) => completed(input.stdin ?? null),
      } as never) as AnyCommand;
      return { p, app: appOf(cmd) };
    };
    // A default counts as the effective value.
    const byDefault = make({ input: "mode", equals: "stdin" }, { mode: { summary: "m", values: ["list", "stdin"], default: "stdin" } });
    expect(JSON.parse((await execute(byDefault.app, ["run"], options(byDefault.p, "text"))).stdout).data).toBe("text");
    expect(JSON.parse((await execute(byDefault.app, ["run", "--mode", "list"], options(byDefault.p, "text"))).stdout).data).toBeNull();
    expect(byDefault.p.reads).toBe(1);

    // false can be the selecting value of a flag.
    const noFlag = make({ input: "inline", equals: false }, { inline: { summary: "i", type: "boolean" } });
    expect(JSON.parse((await execute(noFlag.app, ["run"], options(noFlag.p, "piped"))).stdout).data).toBe("piped");
    expect(JSON.parse((await execute(noFlag.app, ["run", "--inline"], options(noFlag.p, "piped"))).stdout).data).toBeNull();
    expect(noFlag.p.reads).toBe(1);

    // An absent optional value never matches, and numbers compare without coercion.
    const numeric = make({ input: "count", equals: 0 }, { count: { summary: "c", type: "integer" } });
    expect(JSON.parse((await execute(numeric.app, ["run"], options(numeric.p, "x"))).stdout).data).toBeNull();
    expect(JSON.parse((await execute(numeric.app, ["run", "--count", "0"], options(numeric.p, "x"))).stdout).data).toBe("x");
    expect(numeric.p.reads).toBe(1);

    // An empty selected text is an empty string, not undefined.
    const empty = make({ input: "inline", equals: false }, { inline: { summary: "i", type: "boolean" } });
    expect(JSON.parse((await execute(empty.app, ["run"], options(empty.p, ""))).stdout).data).toBe("");
  });

  test("an active stdin keeps its read, JSON and shape errors before the context", async () => {
    const p = probe();
    const app = appOf(locate(p));
    const badJson = await execute(app, ["run", "-"], options(p, "not json"));
    expect(badJson.exitCode).toBe(2);
    const badShape = await execute(app, ["run", "-"], options(p, "[1]"));
    expect(resultJson(badShape).error).toMatchObject({ code: "INVALID_INPUT", details: { input: "stdin", reason: "expected strings" } });
    const noReader = await execute(app, ["run", "-"], { context: () => ({}) });
    expect(noReader.exitCode).toBe(70);
    expect(p.contexts).toBe(0);
  });

  test("invalid arguments fail before the condition, stdin or context", async () => {
    const p = probe();
    const app = appOf(locate(p));
    for (const argv of [["run"], ["run", "-", "--limit", "x"], ["run", "-", "--bogus"]]) {
      expect((await execute(app, argv, options(p))).exitCode).toBe(2);
    }
    expect(p).toMatchObject({ reads: 0, shapes: 0, contexts: 0 });
  });

  test("help never reads stdin and states the condition; schema publishes it", async () => {
    const p = probe();
    const app = appOf(locate(p));
    const help = (await execute(app, ["run", "-", "--help"], options(p))).stdout;
    expect(help).toContain('Stdin:\n  json, read only when <scope> is "-" — IDs as a JSON array');
    expect(p.reads).toBe(0);
    const stdin = (applicationSchema(app).commands.run as CommandSchema).input.stdin;
    expect(stdin).toEqual({ format: "json", summary: "IDs as a JSON array", shape: { description: "array of strings", custom: true }, when: { input: "scope", equals: "-" } });

    const flag = command({
      summary: "x",
      input: { options: { ids: { summary: "i", type: "boolean" }, from: { summary: "f", default: "file" } }, stdin: { summary: "IDs", format: "text", when: { input: "ids", equals: true } } },
      output: output<null>(),
      run: () => completed(null),
    });
    const unconditional = command({ summary: "y", input: { stdin: { summary: "All", format: "text" } }, output: output<null>(), run: () => completed(null) });
    const both = application({ name: "tool", version: "1", summary: "t", commands: { flag, unconditional } });
    expect((await execute(both, ["flag", "--help"], { context: () => ({}) })).stdout).toContain("text, read only when --ids is given — IDs");
    expect((await execute(both, ["unconditional", "--help"], { context: () => ({}) })).stdout).toContain("text, read on every run — All");

    const byOption = command({
      summary: "z",
      input: { positionals: [{ name: "scope", summary: "s" }], options: { mode: { summary: "m", values: ["list", "stdin"] } }, stdin: { summary: "IDs", format: "text", when: { input: "mode", equals: "stdin" } } },
      output: output<null>(),
      run: () => completed(null),
    });
    const byOptional = command({
      summary: "w",
      input: { positionals: [{ name: "scope", summary: "s" }], stdin: { summary: "IDs", format: "text", when: { input: "scope", equals: "-" } } },
      output: output<null>(),
      run: () => completed(null),
    });
    const more = application({ name: "tool", version: "1", summary: "t", commands: { "by-option": byOption, "by-optional": byOptional } });
    expect((await execute(more, ["by-option", "--help"], { context: () => ({}) })).stdout).toContain('text, read only when --mode is "stdin" — IDs');
    // An optional positional is written as in usage, not as a required <name>.
    expect((await execute(more, ["by-optional", "--help"], { context: () => ({}) })).stdout).toContain('text, read only when [scope] is "-" — IDs');
    expect((applicationSchema(both).commands.unconditional as CommandSchema).input.stdin).not.toHaveProperty("when");
  });

  test("payload commands keep their channels with a conditional stdin", async () => {
    const reads: number[] = [];
    const cmd = command({
      summary: "Export",
      input: { positionals: [{ name: "scope", summary: "s", required: true }], stdin: { summary: "IDs", format: "text", when: { input: "scope", equals: "-" } } },
      output: payload.text({ records: "ids", framing: "lf" }),
      run: (input) =>
        records(
          (async function* () {
            yield* (input.stdin ?? "none").split(" ");
          })(),
        ),
    });
    const app = application({ name: "tool", version: "1", summary: "t", commands: { export: cmd } });
    const read = async () => {
      reads.push(1);
      return "a b";
    };
    expect((await execute(app, ["export", "-"], { context: () => ({}), readStdin: read })).stdout).toBe("a\nb\n");
    expect((await execute(app, ["export", "all"], { context: () => ({}) })).stdout).toBe("none\n");
    const bad = await execute(app, ["export", "-", "--human"], { context: () => ({}), readStdin: read });
    expect(bad).toMatchObject({ exitCode: 2, stdout: "" });
    expect(reads).toHaveLength(1);
  });
});

describe("stdin.when declarations", () => {
  const issues = (input: unknown) => {
    try {
      command({ summary: "x", input: input as never, output: output<null>(), run: () => completed(null) });
    } catch (error) {
      return (error as AuthoringError).issues;
    }
    return [];
  };
  const base = {
    positionals: [
      { name: "scope", summary: "s", required: true },
      { name: "rest", summary: "r", variadic: true },
    ],
    options: {
      tag: { summary: "t", repeat: true },
      mode: { summary: "m", values: ["a", "b"] },
      count: { summary: "c", type: "integer", min: 1 },
      flag: { summary: "f", type: "boolean" },
      named: { summary: "n", check: check.string("not empty", (v) => v.length > 0) },
    },
  };
  const when = (w: unknown) => issues({ ...base, stdin: { summary: "s", format: "text", when: w } });

  test.each([
    [{ input: "nope", equals: "x" }, 'stdin when.input "nope" is not a declared positional or option'],
    [{ input: "rest", equals: "x" }, 'stdin when.input "rest" takes several values; only a single-value argument can select stdin'],
    [{ input: "tag", equals: "x" }, 'stdin when.input "tag" takes several values; only a single-value argument can select stdin'],
    [{ input: "flag", equals: "true" }, 'stdin when.equals for boolean option "flag" must be true or false'],
    [{ input: "mode", equals: "c" }, 'stdin when.equals for "mode" can never match: expected one of a, b'],
    [{ input: "count", equals: "1" }, 'stdin when.equals for "count" can never match: expected an integer'],
    [{ input: "count", equals: 0 }, 'stdin when.equals for "count" can never match: expected at least 1'],
    [{ input: "count", equals: Number.NaN }, 'stdin when.equals for "count" can never match: expected an integer'],
    [{ input: "scope", equals: 1 }, 'stdin when.equals for "scope" can never match: expected a string'],
    [{ input: "scope", equals: ["-"] }, 'stdin when.equals for "scope" must be a string'],
    [{ input: "count", equals: true }, 'stdin when.equals for "count" must be an integer'],
    [{ input: "scope", equals: "-", or: "x" }, 'stdin when has unknown key "or"'],
    [{ input: "help", equals: true }, 'stdin when.input "help" is not a declared positional or option'],
    ["scope", "stdin when must be an object"],
  ])("%j", (w, message) => {
    expect(when(w)).toEqual([message]);
  });

  test("a malformed option declaration is an authoring error, not a TypeError from the condition check", () => {
    for (const bad of ["abc", null, 5]) {
      const found = issues({ options: { mode: bad }, stdin: { summary: "s", format: "text", when: { input: "mode", equals: "x" } } });
      expect(found.length, String(bad)).toBeGreaterThan(0);
      expect(found.some((i) => i.startsWith("stdin when")), String(bad)).toBe(false);
    }
  });

  test("valid conditions, including a checked string argument", () => {
    for (const w of [{ input: "scope", equals: "-" }, { input: "mode", equals: "a" }, { input: "count", equals: 3 }, { input: "flag", equals: false }, { input: "named", equals: "x" }]) {
      expect(when(w), JSON.stringify(w)).toEqual([]);
    }
  });

  test("the condition is snapshotted without running getters", async () => {
    let ran = false;
    const lazy = Object.defineProperty({ input: "scope" }, "equals", {
      enumerable: true,
      get: () => {
        ran = true;
        return "-";
      },
    });
    expect(() => command({ summary: "x", input: { ...base, stdin: { summary: "s", format: "text", when: lazy } } as never, output: output<null>(), run: () => completed(null) })).toThrow(AuthoringError);
    expect(ran).toBe(false);

    const condition: { input: "scope"; equals: string } = { input: "scope", equals: "-" };
    const cmd = command({ summary: "x", input: { positionals: [{ name: "scope", summary: "s", required: true }], stdin: { summary: "s", format: "text", when: condition } }, output: output<unknown>(), run: (input) => completed(input.stdin ?? null) });
    condition.equals = "all";
    const app = application({ name: "tool", version: "1", summary: "t", commands: { cmd } });
    expect(JSON.parse((await execute(app, ["cmd", "all"], { context: () => ({}) })).stdout).data).toBeNull();
    expect(Object.isFrozen(cmd.spec.input?.stdin?.when)).toBe(true);
  });
});
