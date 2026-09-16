// Checks against the built package: what a consumer installs and imports.
// Requires `pnpm build` first (pnpm test runs it).

import { execFileSync } from "node:child_process";
import { existsSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function importGraph(entry: string): { files: string[]; specifiers: string[] } {
  const files: string[] = [];
  const specifiers: string[] = [];
  const pending = [resolve(root, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.includes(file)) continue;
    files.push(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:import|export)\s[^;]*?from\s*"([^"]+)"|import\s*\(\s*"([^"]+)"\s*\)|import\s*"([^"]+)"/g)) {
      const spec = match[1] ?? match[2] ?? match[3]!;
      if (spec.startsWith(".")) pending.push(resolve(dirname(file), spec));
      else specifiers.push(spec);
    }
  }
  return { files, specifiers };
}

describe("deterministic root export", () => {
  const graph = importGraph(pkg.exports["."].default);

  test("imports no Node built-ins, adapter libraries or anything external", () => {
    expect(graph.files.length).toBeGreaterThan(5);
    expect(graph.specifiers).toEqual([]);
  });

  test("does not touch process, environment, clock or randomness", () => {
    for (const file of graph.files) {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/\bprocess\b|\bDate\b|Math\.random|globalThis|\bfetch\s*\(|performance\.now|setTimeout|setInterval/);
    }
  });

  test("node and adapter entries are separate", () => {
    expect(importGraph(pkg.exports["./node"].default).specifiers).toEqual([]);
    // The neverthrow adapter uses only neverthrow types, so its runtime has no import.
    expect(importGraph(pkg.exports["./neverthrow"].default).specifiers).toEqual([]);
    expect(importGraph(pkg.exports["./effect"].default).specifiers).toEqual(["effect"]);
    expect(Object.keys(pkg.peerDependencies ?? {}).sort()).toEqual(["effect", "neverthrow"]);
    expect(pkg.peerDependenciesMeta).toEqual({ effect: { optional: true }, neverthrow: { optional: true } });
    expect(pkg.dependencies).toBeUndefined();
  });
});

describe("installed without optional adapter libraries", () => {
  const consumer = mkdtempSync(join(tmpdir(), "cli-for-ai-consumer-"));
  afterAll(() => rmSync(consumer, { recursive: true, force: true }));

  const installed = join(consumer, "node_modules", "cli-for-ai");
  mkdirSync(installed, { recursive: true });
  for (const entry of pkg.files as string[]) {
    try {
      cpSync(join(root, entry), join(installed, entry), { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  cpSync(join(root, "package.json"), join(installed, "package.json"));
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "module", private: true }));

  const node = (script: string) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: consumer, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  test("root and /node import and run a plain application", () => {
    writeFileSync(
      join(consumer, "app.mjs"),
      `import { application, command, completed, output } from "cli-for-ai";
import { run } from "cli-for-ai/node";
const app = application({ name: "demo", version: "1.0.0", summary: "Demo", commands: {
  hello: command({ summary: "Greet", input: { positionals: [{ name: "who", summary: "Name", required: true }] },
    output: output(), run: (i) => completed({ hello: i.who }) }) } });
await run(app, { context: () => ({}) });
`,
    );
    const out = execFileSync(process.execPath, ["app.mjs", "hello", "world"], { cwd: consumer, encoding: "utf8" });
    expect(JSON.parse(out)).toEqual({ status: "completed", data: { hello: "world" } });
    expect(node(`import * as m from "cli-for-ai"; console.log(typeof m.execute, typeof m.fromNeverthrow)`)).toBe("function undefined\n");
  });

  test("a JavaScript consumer streams a payload command through the built package", () => {
    writeFileSync(
      join(consumer, "payload.mjs"),
      `import { application, command, payload, records } from "cli-for-ai";
import { run } from "cli-for-ai/node";
const app = application({ name: "demo", version: "1.0.0", summary: "Demo", commands: {
  rows: command({ summary: "Rows", output: payload.jsonl(), run: () => records((async function* () { yield { a: 1 }; yield { b: "x\\ny" }; })()) }),
  paths: command({ summary: "Paths", output: payload.text({ records: "paths", framing: "nul" }), run: () => records((async function* () { yield "a b"; })()) }) } });
await run(app, { context: () => ({}) });
`,
    );
    expect(execFileSync(process.execPath, ["payload.mjs", "rows"], { cwd: consumer, encoding: "utf8" })).toBe('{"a":1}\n{"b":"x\\ny"}\n');
    expect(execFileSync(process.execPath, ["payload.mjs", "paths"], { cwd: consumer, encoding: "utf8" })).toBe("a b\0");
  });

  test("the effect subpath fails only because effect is absent; neverthrow needs no runtime library", () => {
    let stderr = "";
    try {
      node(`await import("cli-for-ai/effect")`);
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr);
    }
    expect(stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(stderr).toContain("'effect'");
    expect(node(`import { fromNeverthrow } from "cli-for-ai/neverthrow"; console.log(typeof fromNeverthrow)`)).toBe("function\n");
  });

  test("published source maps resolve to included source files", () => {
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith(".map")) {
          const map = JSON.parse(readFileSync(path, "utf8"));
          for (const source of map.sources) expect(existsSync(resolve(dirname(path), map.sourceRoot ?? "", source)), path).toBe(true);
        }
      }
    };
    visit(join(installed, "dist"));
  });

  const tsc = (files: Record<string, string>, types: string[], emitDeclarations = false) => {
    const dir = mkdtempSync(join(consumer, "ts-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2024", lib: ["ES2024"], strict: true, noEmit: !emitDeclarations, declaration: emitDeclarations, emitDeclarationOnly: emitDeclarations, skipLibCheck: false, types },
        include: Object.keys(files),
      }),
    );
    try {
      execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", dir], { cwd: consumer, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (emitDeclarations) {
        for (const name of Object.keys(files)) {
          const emitted = readFileSync(join(dir, name.replace(/\.ts$/, ".d.ts")), "utf8");
          expect(emitted).not.toContain("cli-for-ai/dist/");
          expect(emitted).not.toContain("node_modules/");
        }
      }
      return "";
    } catch (error) {
      return String((error as { stdout?: string }).stdout);
    }
  };

  test("a TypeScript consumer type-checks the built declarations with Node types", () => {
    mkdirSync(join(consumer, "node_modules", "@types"), { recursive: true });
    symlinkSync(realpathSync(join(root, "node_modules/@types/node")), join(consumer, "node_modules/@types/node"), "dir");
    const source = `import { application, authoring, completed, execute, output, payload, records } from "cli-for-ai";
import { run } from "cli-for-ai/node";
interface Ctx { greeting: string }
const { command } = authoring<Ctx>();
const hello = command({
  summary: "Greet",
  input: { positionals: [{ name: "who", summary: "Name", required: true }] },
  output: output({ parse: (data: unknown) => String(data) }),
  run: (input, ctx) => completed(\`\${ctx.greeting} \${input.who}\`),
});
const app = application({ name: "demo", version: "1.0.0", summary: "Demo", commands: { hello } });
void execute(app, ["hello", "x"], { context: () => ({ greeting: "hi" }) });
const code: Promise<number> = run(app, { context: () => ({ greeting: "hi" }) });
void code;
// @ts-expect-error the context is checked through the published declarations
void execute(app, [], { context: () => ({}) });
const rows = command({
  summary: "Rows",
  output: payload.jsonl({ parse: (value: unknown) => value as { id: number } }),
  run: (_input, ctx) => records((async function* () { yield { id: ctx.greeting.length }; })()),
});
const noHuman = command({
  summary: "Rows",
  output: payload.jsonl(),
  run: () => records((async function* () {})()),
  // @ts-expect-error payload commands have no human renderer
  human: () => "x",
});
const wrongRecord = command({
  summary: "Rows",
  output: payload.jsonl({ parse: (value: unknown) => value as { id: number } }),
  // @ts-expect-error records must match the payload declaration
  run: () => records((async function* () { yield { id: "one" }; })()),
});
void [rows, noHuman, wrongRecord];
const locate = command({
  summary: "Locate",
  input: { positionals: [{ name: "scope", summary: "Scope", required: true }], stdin: { summary: "IDs", format: "text", when: { input: "scope", equals: "-" } } },
  output: output<number>(),
  run: (input) => {
    const ids: string | undefined = input.stdin;
    // @ts-expect-error a conditional stdin can be undefined
    const certain: string = input.stdin;
    void certain;
    return completed(ids === undefined ? 0 : ids.length);
  },
});
// @ts-expect-error the condition must name a declared argument
const unknownInput = command({ summary: "Bad", input: { stdin: { summary: "IDs", format: "text", when: { input: "scope", equals: "-" } } }, output: output<number>(), run: () => completed(0) });
void [locate, unknownInput];
`;
    expect(tsc({ "consumer.ts": source }, ["node"])).toBe("");
  });

  test("consumer modules can emit declarations for exported authoring helpers and commands", () => {
    expect(tsc({
      "context.ts": `import { authoring } from "cli-for-ai";
export interface Context { prefix: string }
export const command = authoring<Context>().command;
export const kit = authoring<Context>();
export const { command: bound } = authoring<Context>();`,
      "commands.ts": `import { completed, output, payload, records } from "cli-for-ai";
import { command } from "./context.js";
export interface CallsData { count: number }
export const calls = command({ summary: "Calls", output: output<CallsData>(), run: (_input, ctx) => completed({ count: ctx.prefix.length }) });
export const rows = command({ summary: "Rows", output: payload.jsonl<CallsData>(), run: () => records((async function* () { yield { count: 1 }; })()) });`,
      "app.ts": `import { application } from "cli-for-ai";
import { calls, rows } from "./commands.js";
export const app = application({ name: "demo", version: "1.0.0", summary: "Demo", commands: { calls, rows } });`,
    }, ["node"], true)).toBe("");
  });

  // Each negative compiles in its own process; shared CI runners need more than the unit-test budget.
  test("the built declarations keep the author input contract: sound inference, private hints, forward, provided and dynamicCommand", () => {
    const valid = `import { application, command, completed, dynamicCommand, flag, integer, output, positional, stdinJson, stdinText, string, type ConstraintFactory, type InputDecl, type InputOf, type StdinShape } from "cli-for-ai";
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const expectType = <T extends true>(value: T) => value;
expectType<Equal<InputOf<{ options: { x: { summary: string; type: "boolean" | "string" } } }>, { x: string | boolean | undefined }>>(true);
expectType<Equal<InputOf<{ positionals: [{ name: "left" | "right"; summary: string; required: true }] }>, { left?: string; right?: string }>>(true);
const needsWait = <A extends { timeout: number; wait: boolean }>(rule: ConstraintFactory<A>) =>
  rule(["timeout", "wait"], "--timeout requires --wait", ({ wait }, { provided }) => (provided("timeout") && !wait ? "add --wait" : undefined));
const ids: StdinShape<string[]> = { description: "ids", parse: (v) => (Array.isArray(v) ? { ok: true, value: v.map(String) } : { ok: false, reason: "array" }) };
const send = command({
  summary: "Send",
  input: {
    positionals: [positional("scope", string({ summary: "Scope", values: ["all", "-"], default: "all" }))],
    options: { wait: flag({ summary: "Wait" }), timeout: integer({ summary: "Seconds", min: 1, default: 30 }) },
    forward: { name: "rest", summary: "Rest" },
    stdin: stdinText({ summary: "ids", when: { input: "scope", equals: "-" } }),
  },
  constraints: (rule) => [needsWait(rule)],
  output: output<number>(),
  run: (input) => {
    expectType<Equal<typeof input, { scope: "all" | "-"; wait: boolean; timeout: number; rest: string[]; stdin?: string }>>(true);
    return completed(input.timeout);
  },
});
const load = command({ summary: "Load", input: { stdin: stdinJson({ summary: "ids", shape: ids }) }, output: output<number>(), run: (input) => completed(input.stdin.length) });
const plugin = dynamicCommand({ summary: "Plugin", input: JSON.parse("{}") as InputDecl, output: output<unknown>(), run: (input) => completed(input.anything) });
application({ name: "demo", version: "1.0.0", summary: "Demo", commands: { send, load, plugin } });
const whenScope = { summary: "ids", when: { input: "scope", equals: "-" } } as const;
command({ summary: "Nonfresh", input: { positionals: [{ name: "scope", summary: "s", default: "all" }], stdin: stdinText(whenScope) }, output: output<null>(), run: (input) => {
  expectType<Equal<typeof input, { scope: string; stdin?: string }>>(true);
  return completed(null);
} });
const x = { name: "x", summary: "x", required: true } as const;
const y = { name: "y", summary: "y", required: true } as const;
expectType<Equal<InputOf<{ positionals: readonly [typeof x] | readonly [typeof x, typeof y] }>, { x: string } | { x: string; y: string }>>(true);
expectType<Equal<InputOf<{ positionals: readonly [] | readonly [typeof x] }>, {} | { x: string }>>(true);
expectType<Equal<InputOf<{ forward: { name: "a" | "b"; summary: string } }>, { a?: string[]; b?: string[] }>>(true);
const plugins: Record<string, import("cli-for-ai").DynamicCommand> = { plugin };
function maybe(both: boolean, tuple: readonly [typeof x] | undefined) {
  command({ summary: "Maybe", input: { positionals: both ? [x] as const : undefined }, output: output<number>(), run: (input) => {
    expectType<Equal<typeof input, {} | { x: string }>>(true);
    return completed("x" in input ? input.x.length : 0);
  } });
  command({ summary: "Whole", input: both ? { positionals: [x] } : undefined, output: output<number>(), run: (input) => completed("x" in input ? input.x.length : 0) });
  command({ summary: "Param", input: { positionals: tuple }, examples: [{ summary: "none", input: {} }], output: output<null>(), run: () => completed(null) });
}
void maybe;
expectType<Equal<InputOf<{ positionals?: readonly [typeof x] }>, {} | { x: string }>>(true);
application({ name: "plugins", version: "1.0.0", summary: "Plugins", commands: plugins });
`;
    expect(tsc({ "valid.ts": valid }, ["node"])).toBe("");

    const negatives: Record<string, [string, RegExp]> = {
      "i1.ts": [
        `import { command, completed, output } from "cli-for-ai";
const kind = "string" as "boolean" | "string";
export const c = command({ summary: "x", input: { options: { x: { summary: "x", type: kind } } }, output: output<string>(), run: (input) => completed(input.x?.toUpperCase() ?? "") });
`,
        /Property 'toUpperCase' does not exist on type 'string \| boolean'/,
      ],
      "copied-top-level.ts": [
        `import { command, completed, output } from "cli-for-ai";
declare const options: Record<string, { summary: string; required: true }>;
export const c = command({ summary: "x", inputDeclaration: "input names are not literal; use dynamicCommand() for a declaration built at run time", input: { options }, output: output<null>(), run: () => completed(null) });
`,
        /'inputDeclaration' does not exist/,
      ],
      "quick-fix-key.ts": [
        `import { command, completed, output } from "cli-for-ai";
declare const INPUT_DECLARATION: unique symbol;
declare const options: Record<string, { summary: string; required: true }>;
export const c = command({ summary: "x", [INPUT_DECLARATION]: "input names are not literal; use dynamicCommand() for a declaration built at run time", input: { options }, output: output<null>(), run: () => completed(null) });
`,
        /INPUT_DECLARATION/,
      ],
      "copied-when.ts": [
        `import { command, completed, output } from "cli-for-ai";
export const c = command({ summary: "x", input: { positionals: [{ name: "scope", summary: "s" }], stdin: { summary: "s", format: "text", when: { input: "scop", equals: "-", stdinWhen: "expected scope equals -" } } }, output: output<null>(), run: () => completed(null) });
`,
        /STDIN_WHEN/,
      ],
      "wrong-when.ts": [
        `import { command, completed, output } from "cli-for-ai";
export const c = command({ summary: "x", input: { options: { all: { summary: "a", type: "boolean" } }, stdin: { summary: "s", format: "text", when: { input: "all", equals: "yes" } } }, output: output<null>(), run: () => completed(null) });
`,
        /expected all equals true\|false/,
      ],
      "forward-example.ts": [
        `import { command, completed, output } from "cli-for-ai";
export const c = command({ summary: "x", input: { positionals: [{ name: "kind", summary: "k", required: true }], forward: { name: "rest", summary: "r" } }, examples: [{ summary: "e", input: { kind: "a", rest: "--model" } }], output: output<null>(), run: () => completed(null) });
`,
        /not assignable to type 'string\[\]'/,
      ],
      "stdin-nonfresh.ts": [
        `import { command, completed, output, stdinText } from "cli-for-ai";
const ids = { summary: "ids", when: { input: "scope", equals: "-" } } as const;
export const c = command({ summary: "x", input: { positionals: [{ name: "scope", summary: "s", default: "all" }], stdin: stdinText(ids) }, output: output<number>(), run: (input) => completed(input.stdin.length) });
`,
        /'input.stdin' is possibly 'undefined'/,
      ],
      "stdin-spread.ts": [
        `import { command, completed, output, stdinText } from "cli-for-ai";
declare const conditional: boolean;
const stdin = stdinText({ summary: "ids", ...(conditional ? { when: { input: "scope", equals: "-" } as const } : {}) });
export const c = command({ summary: "x", input: { positionals: [{ name: "scope", summary: "s", default: "all" }], stdin }, output: output<number>(), run: (input) => completed(input.stdin.length) });
`,
        /'input.stdin' is possibly 'undefined'/,
      ],
      "stdin-extracted-wrong-when.ts": [
        `import { command, completed, flag, output, stdinJson, type StdinShape } from "cli-for-ai";
declare const ids: StdinShape<string[]>;
const stdin = stdinJson({ summary: "ids", shape: ids, when: { input: "from", equals: "yes" } });
export const c = command({ summary: "x", input: { options: { from: flag({ summary: "f" }) }, stdin }, output: output<null>(), run: () => completed(null) });
`,
        /expected from equals true\|false/,
      ],
      "stdin-nonfresh-extra-key.ts": [
        `import { stdinText } from "cli-for-ai";
const declaration = { summary: "s", required: true };
export const s = stdinText(declaration);
`,
        /unknown declaration key \\"required\\"/,
      ],
      "forward-union.ts": [
        `import { command, completed, output } from "cli-for-ai";
declare const name: "a" | "b";
export const c = command({ summary: "x", input: { forward: { name, summary: "tail" } }, output: output<number>(), run: (input) => completed(input.a.length) });
`,
        /'input.a' is possibly 'undefined'/,
      ],
      "positionals-undefined.ts": [
        `import { command, completed, output } from "cli-for-ai";
declare const both: boolean;
const x = { name: "x", summary: "x", required: true } as const;
export const c = command({ summary: "p", input: { positionals: both ? [x] as const : undefined }, output: output<number>(), run: (input) => completed(input.x.length) });
`,
        /Property 'x' does not exist on type '\{\} \| \{ x: string; \}'/,
      ],
      "input-undefined.ts": [
        `import { command, completed, output } from "cli-for-ai";
export function make(both: boolean) {
  const x = { name: "x", summary: "x", required: true } as const;
  return command({ summary: "p", input: both ? { positionals: [x] } : undefined, output: output<number>(), run: (input) => completed(input.x.length) });
}
`,
        /Property 'x' does not exist on type '\{\}'/,
      ],
      "positionals-undefined-selector.ts": [
        `import { command, completed, output } from "cli-for-ai";
export function make(tuple: readonly [{ readonly name: "x"; readonly summary: "x" }] | undefined) {
  return command({ summary: "p", input: { positionals: tuple, stdin: { summary: "s", format: "text", when: { input: "x", equals: "-" } } }, output: output<null>(), run: () => completed(null) });
}
`,
        /no single-value argument can select stdin/,
      ],
      "tuple-union.ts": [
        `import { command, completed, output } from "cli-for-ai";
const x = { name: "x", summary: "x", required: true } as const;
const y = { name: "y", summary: "y", required: true } as const;
declare const positionals: readonly [typeof x] | readonly [typeof x, typeof y];
export const c = command({ summary: "x", input: { positionals }, output: output<number>(), run: (input) => completed(input.y.length) });
`,
        /Property 'y' does not exist/,
      ],
      "dynamic-context.ts": [
        `import { dynamicCommand, output, completed, type DynamicCommand, type InputDecl } from "cli-for-ai";
declare const input: InputDecl;
export const c: DynamicCommand = dynamicCommand<{ db: string }>({ summary: "x", input, output: output<null>(), run: () => completed(null) });
`,
        /is not assignable to type 'DynamicCommand/,
      ],
    };
    for (const [file, [source, message]] of Object.entries(negatives)) {
      const out = tsc({ [file]: source }, ["node"]);
      expect(out, file).toMatch(message);
    }

    // The hint symbols are private: no declaration file exports them.
    const exported = readdirSync(join(installed, "dist"), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".d.ts"))
      .filter((file) => /export (declare )?const (INPUT_DECLARATION|STDIN_WHEN|FRAMING_OPTION|CONTEXT_CONFLICT|DECLARATION)\b/.test(readFileSync(join(installed, "dist", file), "utf8")));
    expect(exported).toEqual([]);
    expect(readFileSync(join(installed, "dist/core/input.d.ts"), "utf8")).toMatch(/declare const INPUT_DECLARATION: unique symbol;/);
  }, 30_000);

  test("consumer type requirements: root needs AbortSignal from Node or DOM types; the neverthrow subpath needs neverthrow", () => {
    const rootSource = `import { command, completed, output } from "cli-for-ai";\nexport const c = command({ summary: "x", output: output<null>(), run: () => completed(null) });\n`;
    expect(tsc({ "root.ts": rootSource }, [])).toContain("AbortSignal");
    const adapter = `import { fromNeverthrow } from "cli-for-ai/neverthrow";\nvoid fromNeverthrow;\n`;
    expect(tsc({ "adapter.ts": adapter }, ["node"])).toContain("neverthrow");
  });

  test("lint and upgrade subpaths still import", () => {
    expect(node(`import { lintSchema } from "cli-for-ai/lint"; import { isNewer } from "cli-for-ai/upgrade"; console.log(typeof lintSchema, isNewer("1.1.0", "1.0.0"))`)).toBe("function true\n");
  });
});
