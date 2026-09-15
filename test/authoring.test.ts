import { describe, expect, test } from "vitest";
import { application, AuthoringError, check, command, completed, group, output, parseInvocation, type InputDecl } from "../src/index.ts";

const run = () => completed(null);
const issuesOf = (fn: () => unknown): readonly string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AuthoringError) return error.issues;
    throw error;
  }
  throw new Error("expected an AuthoringError");
};
// Runtime validation of arbitrary declarations; a widened InputDecl is rejected by the type check, so it is cast.
const inputIssues = (input: InputDecl) => issuesOf(() => command({ summary: "x", input: input as never, output: output(), run }));

describe("invalid declarations are authoring errors", () => {
  test("command summary, run and output are required", () => {
    expect(issuesOf(() => command({ summary: " ", output: output(), run }))).toEqual(["summary is required"]);
    // @ts-expect-error output is required
    expect(issuesOf(() => command({ summary: "x", run }))).toEqual(["output is required"]);
  });

  test("reserved and duplicate input names", () => {
    expect(inputIssues({ options: { help: { summary: "h", type: "boolean" } } })).toEqual(['option "help" is reserved']);
    expect(inputIssues({ options: { human: { summary: "h" } } })).toEqual(['option "human" is reserved']);
    expect(inputIssues({ positionals: [{ name: "stdin", summary: "s" }] })).toEqual(['positional "stdin" is reserved for declared stdin']);
    expect(inputIssues({ positionals: [{ name: "id", summary: "i" }], options: { id: { summary: "i" } } })).toEqual([
      'option "id" duplicates another input name',
    ]);
    expect(inputIssues({ options: { Name: { summary: "n" } } })).toEqual(['option "Name" must be lowercase kebab-case']);
  });

  test("unknown and misplaced keys", () => {
    const raw = (input: unknown) => inputIssues(input as InputDecl);
    expect(raw({ options: { tag: { summary: "t", variadic: true } } })).toEqual(['option "tag" has unknown key "variadic"']);
    expect(raw({ positionals: [{ name: "id", summary: "i", repeat: true }] })).toEqual(['positional "id" has unknown key "repeat"']);
    expect(raw({ positionals: [{ name: "id", summary: "i", requird: true }] })).toEqual(['positional "id" has unknown key "requird"']);
    expect(raw({ options: { tag: { summary: "t", required: false } } })).toEqual(['option "tag" required must be true or omitted']);
    expect(raw({ options: { tag: { summary: "t", repeat: false } } })).toEqual(['option "tag" repeat must be true or omitted']);
    expect(raw({ positionals: [{ name: "id", summary: "i", variadic: 1 }] })).toEqual(['positional "id" variadic must be true or omitted']);
    expect(raw({ positional: [] })).toEqual(['input has unknown key "positional"']);
    expect(raw({ stdin: { summary: "s", format: "json", required: true } })).toEqual(['stdin has unknown key "required"']);
    expect(raw({ options: { n: { summary: 1, min: "0", type: "number" } } })).toEqual(['option "n" has no summary', 'option "n" min must be a finite number']);
    expect(raw({ options: { n: { summary: "n", values: "a,b" } } })).toEqual(['option "n" values must be an array of strings']);
    expect(raw({ options: { n: new (class { summary = "n"; })() } })).toEqual(['command.input.options.n must be a plain object']);
  });

  test("invalid combinations", () => {
    expect(inputIssues({ positionals: [{ name: "a", summary: "a", variadic: true }, { name: "b", summary: "b" }] })).toEqual([
      'positional "a" is variadic but not last',
    ]);
    expect(inputIssues({ positionals: [{ name: "a", summary: "a" }, { name: "b", summary: "b", required: true }] })).toEqual([
      'required positional "b" follows an optional positional',
    ]);
    expect(inputIssues({ options: { n: { summary: "n", required: true, default: "x" } } })).toEqual([
      'option "n" is required and has a default',
    ]);
    expect(inputIssues({ options: { n: { summary: "n", type: "integer", values: ["a"] } } })).toEqual([
      'option "n" declares values but is not a string',
    ]);
    expect(inputIssues({ options: { n: { summary: "n", min: 1 } } })).toEqual(['option "n" declares bounds but is a string']);
    expect(inputIssues({ options: { n: { summary: "n", type: "integer", min: 5, max: 1 } } })).toEqual(['option "n" has min greater than max']);
    expect(inputIssues({ options: { n: { summary: "n", type: "integer", default: 1.5 } } })).toEqual([
      'option "n" default is invalid: expected a safe integer',
    ]);
    expect(inputIssues({ options: { n: { summary: "n", repeat: true, default: "a" } } })).toEqual([
      'option "n" collects several values and cannot have a default',
    ]);
    // @ts-expect-error boolean options take no value settings
    expect(inputIssues({ options: { n: { summary: "n", type: "boolean", required: true } } })).toEqual([
      'option "n" is boolean and cannot declare required',
    ]);
    // @ts-expect-error unsupported stdin format
    expect(inputIssues({ stdin: { summary: "s", format: "yaml" } })).toEqual(['stdin format "yaml" is not supported']);
  });

  test("output schema must be plain JSON", () => {
    const withSchema = (schema: unknown) => () => command({ summary: "x", output: output<null>({ schema: schema as never }), run });
    expect(issuesOf(withSchema({ maximum: Infinity }))).toEqual(["output schema is not plain JSON: output.schema.maximum is not a finite number"]);
    expect(issuesOf(withSchema({ enum: [undefined] }))).toEqual(["output schema is not plain JSON: output.schema.enum[0] is undefined"]);
    expect(issuesOf(withSchema({ format: () => "x" }))).toEqual(["output schema is not plain JSON: output.schema.format is function, which JSON cannot represent"]);
    expect(issuesOf(withSchema(["array"]))).toEqual(["output schema must be a plain object"]);
    expect(withSchema({ type: "object", properties: { id: { type: "integer", minimum: 1 } } })).not.toThrow();
  });

  test("groups and applications", () => {
    const leaf = command({ summary: "x", output: output(), run });
    expect(issuesOf(() => group({ summary: "g", commands: {} }))).toEqual(["commands must not be empty"]);
    // @ts-expect-error plain functions are not commands
    expect(issuesOf(() => group({ summary: "g", commands: { x: run } }))).toEqual(['"x" is not a command or group; build it with command() or group()']);
    // No command name is reserved: schema is an ordinary authored name.
    expect(Object.keys(application({ name: "t", version: "1", summary: "t", commands: { schema: leaf } }).commands)).toEqual(["schema"]);
    expect(issuesOf(() => application({ name: "T", version: "", summary: "t", commands: { Ok: leaf } }))).toEqual([
      "name must be lowercase kebab-case",
      "version is required",
      'command name "Ok" must be lowercase kebab-case',
    ]);
  });

  test("examples must satisfy the input contract after generation and parsing", () => {
    const decl = {
      positionals: [
        { name: "id", summary: "id", type: "integer", required: true },
        { name: "label", summary: "label" },
        { name: "extra", summary: "extra" },
      ],
      options: { mode: { summary: "m", values: ["a", "b"] } },
    } as const;
    const mount = (examples: { summary: string; input: Record<string, unknown> }[]) => () =>
      application({
        name: "t",
        version: "1",
        summary: "t",
        commands: {
          g: group({ summary: "g", commands: { show: command({ summary: "x", input: decl, output: output(), run, examples: examples as never }) } }),
        },
      });
    expect(issuesOf(mount([{ summary: "fraction", input: { id: 1.5 } }]))).toEqual(['example "fraction" of "g show" is invalid: Invalid value: id 1.5']);
    expect(issuesOf(mount([{ summary: "missing", input: {} }]))).toEqual(['example "missing" of "g show" is invalid: Missing argument: <id>']);
    expect(issuesOf(mount([{ summary: "gap", input: { id: 1, extra: "e" } }]))).toEqual(['example "gap" of "g show" is invalid: <extra> is given after omitted <label>']);
    expect(issuesOf(mount([{ summary: "enum", input: { id: 1, mode: "c" } }]))).toEqual(['example "enum" of "g show" is invalid: Invalid value: --mode c']);
    expect(issuesOf(mount([{ summary: "unknown", input: { id: 1, colour: "red" } }]))).toEqual(['example "unknown" of "g show" is invalid: unknown input "colour"']);
    expect(issuesOf(mount([{ summary: "number text", input: { id: 1, label: 5 } }]))).toEqual([
      'example "number text" of "g show" is invalid: "label" does not survive parsing: generated "5"',
    ]);
    expect(mount([{ summary: "ok", input: { id: 1, label: "--help", mode: "a" } }])).not.toThrow();
  });

  test("examples must also satisfy the command's constraints", () => {
    const ranged = (examples: { summary: string; input: { from: number; to: number } }[]) => () =>
      application({
        name: "t",
        version: "1",
        summary: "t",
        commands: {
          range: command({
            summary: "r",
            input: {
              positionals: [
                { name: "from", summary: "f", type: "integer", required: true },
                { name: "to", summary: "t", type: "integer", required: true },
              ],
            },
            constraints: (rule) => [rule(["from", "to"], "from must not exceed to", ({ from, to }) => (from > to ? "from is greater than to" : undefined))],
            output: output<null>(),
            examples,
            run,
          }),
        },
      });
    expect(issuesOf(ranged([{ summary: "backwards", input: { from: 5, to: 1 } }]))).toEqual([
      'example "backwards" of "range" is invalid: Invalid input: from is greater than to',
    ]);
    expect(ranged([{ summary: "forwards", input: { from: 1, to: 5 } }])).not.toThrow();
  });

  test("constraint declarations are checked when declared", () => {
    const base = { summary: "x", output: output<null>(), run };
    const positionals = [
      { name: "a", summary: "a" },
      { name: "b", summary: "b" },
    ] as const;
    const raw = (spec: Record<string, unknown>) => issuesOf(() => command({ ...base, ...spec } as never));
    expect(raw({ input: { positionals }, constraints: (rule: (...a: unknown[]) => unknown) => [rule(["a", "zz"], "d", () => undefined)] })).toEqual([
      'constraint 0 names unknown input "zz"',
    ]);
    expect(raw({ input: { positionals }, constraints: (rule: (...a: unknown[]) => unknown) => [rule([], "d", () => undefined)] })).toEqual(["constraint 0 names no inputs"]);
    expect(raw({ input: { positionals }, constraints: (rule: (...a: unknown[]) => unknown) => [rule(["a", "a"], "d", () => undefined)] })).toEqual([
      'constraint 0 names "a" twice',
    ]);
    expect(raw({ input: { positionals }, constraints: (rule: (...a: unknown[]) => unknown) => [rule(["a"], " ", () => undefined)] })).toEqual([
      "constraint 0 has no description",
    ]);
    expect(raw({ input: { positionals, stdin: { summary: "s", format: "text" } }, constraints: (rule: (...a: unknown[]) => unknown) => [rule(["stdin"], "d", () => undefined)] })).toEqual([
      'constraint 0 names unknown input "stdin"',
    ]);
    expect(raw({ constraints: () => "nope" })).toEqual(["constraints must return an array of rules"]);
    expect(raw({ input: { positionals }, constraints: () => [{ inputs: ["a"], description: "d", check: () => undefined }] })).toEqual([
      "constraint 0 was not built by this command's rule factory",
    ]);
    expect(raw({ constraints: () => { throw new Error("secret token"); } })).toEqual(["constraints threw while building rules"]);
  });

  test("rules must come from the declaring command's own factory", () => {
    const positionals = [{ name: "from", summary: "f", type: "integer", required: true }] as const;
    let captured: unknown;
    const first = command({
      summary: "first",
      input: { positionals },
      constraints: (rule) => {
        const built = rule(["from"], "positive", ({ from }) => (from > 0 ? undefined : "not positive"));
        captured = built;
        return [built];
      },
      output: output<null>(),
      run,
    });
    // Identical input names and types, but another command's factory.
    const reuse = issuesOf(() =>
      command({ summary: "second", input: { positionals }, constraints: () => [captured as never], output: output<null>(), run }),
    );
    expect(reuse).toEqual(["constraint 0 was not built by this command's rule factory"]);
    // A copy that looks identical is not the rule.
    const copied = issuesOf(() =>
      command({ summary: "third", input: { positionals }, constraints: () => [{ ...(captured as object) } as never], output: output<null>(), run }),
    );
    expect(copied).toEqual(["constraint 0 was not built by this command's rule factory"]);

    // Built rules and the materialized list are frozen, so nothing changes after declaration.
    const rule = captured as { inputs: string[]; check: unknown };
    expect(() => rule.inputs.push("zz")).toThrow(TypeError);
    expect(() => {
      rule.check = () => "hijacked";
    }).toThrow(TypeError);
    const app = application({ name: "t", version: "1", summary: "t", commands: { first } });
    expect(parseInvocation(app, ["first", "0"])).toMatchObject({ kind: "invalid", fault: { details: { inputs: ["from"], reason: "not positive" } } });
    expect(parseInvocation(app, ["first", "3"])).toMatchObject({ kind: "run" });
  });

  test("patterns must compile on their own before whole-value anchoring", () => {
    const value = (regex: string) => inputIssues({ options: { v: { summary: "v", pattern: { regex, description: "d" } } } } as InputDecl);
    expect(value("a)|(b")).toEqual(['option "v" pattern regex does not compile']);
    const target = application({
      name: "t",
      version: "1",
      summary: "t",
      commands: { x: command({ summary: "x", input: { options: { v: { summary: "v", pattern: { regex: "a|b(c)", description: "d" } } } }, output: output<null>(), run }) },
    });
    expect(parseInvocation(target, ["x", "--v", "a"])).toMatchObject({ kind: "run" });
    expect(parseInvocation(target, ["x", "--v", "bc"])).toMatchObject({ kind: "run" });
    for (const bad of ["a-anything", "abc", "b", "bcx"]) expect(parseInvocation(target, ["x", "--v", bad]), bad).toMatchObject({ kind: "invalid" });
  });

  test("patterns and checks are validated at declaration, including defaults", () => {
    const value = (option: Record<string, unknown>) => inputIssues({ options: { v: { summary: "v", ...option } } } as InputDecl);
    expect(value({ pattern: { regex: "(", description: "d" } })).toEqual(['option "v" pattern regex does not compile']);
    expect(value({ pattern: { regex: "a", description: "" } })).toEqual(['option "v" pattern has no description']);
    expect(value({ type: "integer", pattern: { regex: "1", description: "d" } })).toEqual(['option "v" declares a pattern but is not a string']);
    expect(value({ pattern: { regex: "a", description: "d", flags: "i" } })).toEqual(['option "v" pattern has unknown key "flags"']);
    expect(value({ check: { description: "d", test: () => true } })).toEqual(['option "v" check must be built with check.string or check.number']);
    expect(value({ type: "integer", check: check.string("d", () => true) })).toEqual(['option "v" check is for string values but the option "v" is integer']);
    expect(value({ default: "b", pattern: { regex: "a", description: "d" } })).toEqual(['option "v" default does not satisfy its constraint']);
    expect(value({ default: "x", check: check.string("d", () => { throw new Error("secret"); }) })).toEqual([
      'option "v" default could not be checked: An input check threw',
    ]);
    expect(inputIssues({ stdin: { summary: "s", format: "json", shape: { description: "", parse: 1 } } } as unknown as InputDecl)).toEqual([
      "stdin shape has no description",
      "stdin shape parse must be a function",
    ]);
  });

  test("one command can be mounted at several paths", () => {
    const leaf = command({ summary: "x", output: output(), run });
    expect(() => application({ name: "t", version: "1", summary: "t", commands: { a: leaf, g: group({ summary: "g", commands: { b: leaf } }) } })).not.toThrow();
  });
});

describe("declarations are immutable snapshots", () => {
  test("mutating a shared source declaration after declaring changes nothing", () => {
    const key = { name: "key" as const, summary: "Key", values: ["a", "b"] as string[], required: true as const };
    const input = { positionals: [key] };
    const handler = () => completed(null);
    const cmd = command({ summary: "x", input, output: output<null>(), run: handler });
    key.values.push("c");
    (key as { name: string }).name = "renamed";
    (input.positionals as unknown[]).push({ name: "stdin", summary: "late" });
    expect(cmd.spec.input?.positionals).toEqual([{ name: "key", summary: "Key", values: ["a", "b"], required: true }]);
    expect(cmd.spec.run).toBe(handler);
    expect(Object.isFrozen(cmd.spec) && Object.isFrozen(cmd.spec.input) && Object.isFrozen(cmd.spec.input?.positionals?.[0]?.values)).toBe(true);
    expect(() => {
      (cmd.spec as { run: unknown }).run = () => completed(1);
    }).toThrow(TypeError);
  });

  test("mounted groups and applications cannot gain unvalidated nodes", () => {
    const leaf = command({ summary: "x", output: output<null>(), run });
    const commands: Record<string, unknown> = { leaf };
    const g = group({ summary: "g", commands: commands as { leaf: typeof leaf } });
    commands.late = leaf;
    expect(Object.keys(g.spec.commands)).toEqual(["leaf"]);
    const app = application({ name: "t", version: "1", summary: "t", commands: { g } });
    expect(() => {
      (app.spec.commands as Record<string, unknown>).other = leaf;
    }).toThrow(TypeError);
    expect(() => {
      (g.spec.commands as Record<string, unknown>).late = leaf;
    }).toThrow(TypeError);
    expect(Object.keys(app.commands)).toEqual(["g"]);
  });

  test("getters are rejected without being executed; cycles and fabricated nodes are rejected", () => {
    let executed = false;
    const lazy = Object.defineProperty({ summary: "x", output: output<null>(), run }, "description", {
      enumerable: true,
      get: () => {
        executed = true;
        return "d";
      },
    });
    expect(issuesOf(() => command(lazy))).toEqual(["command.description is an accessor"]);
    expect(executed).toBe(false);

    const cyclic: Record<string, unknown> = { summary: "x" };
    cyclic.self = cyclic;
    expect(issuesOf(() => command({ summary: "x", output: output<null>({ schema: cyclic }), run }))).toEqual([
      "command.output.schema.self is a circular reference",
    ]);

    const fake = { kind: "command", spec: { summary: "x", output: output<null>(), run } } as const;
    expect(issuesOf(() => group({ summary: "g", commands: { fake: fake as never } }))).toEqual([
      '"fake" is not a command or group; build it with command() or group()',
    ]);
    expect(issuesOf(() => command({ summary: "x", output: output<null>(), run, extra: true } as never))).toEqual(['unknown key "extra"']);
  });
});
