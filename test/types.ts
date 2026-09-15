// Compile-time checks, verified by `tsc --noEmit` (pnpm typecheck). Each expected
// error directive must stay an error; an unused directive fails the build.

import { Effect } from "effect";
import { err, ok, okAsync } from "neverthrow";
import { fromEffect } from "../src/adapters/effect.ts";
import { fromNeverthrow } from "../src/adapters/neverthrow.ts";
import {
  accepted,
  payload,
  records,
  stop,
  type Command,
  type CommandSchema,
  type JsonlPayload,
  type TextPayload,
  type PayloadCommand,
  type Stop,
  check,
  application,
  authoring,
  command,
  completed,
  execute,
  failed,
  group,
  output,
  applicationSchema,
  parseInvocation,
  type Application,
  type Constraint,
  type ApplicationView,
  type ConstraintFactory,
  dynamicCommand,
  flag,
  integer,
  positional,
  stdinJson,
  stdinText,
  string,
  type InputDecl,
  type InputOf,
  type StdinDecl,
  type StdinShape,
} from "../src/index.ts";
import { run } from "../src/node/index.ts";
import { fromList } from "./support/gates.ts";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const expectType = <T extends true>(value: T) => value;

// ── input inference ────────────────────────────────────────────────────────

const decl = {
  positionals: [
    { name: "id", summary: "id", type: "integer", required: true },
    { name: "label", summary: "label" },
    { name: "files", summary: "files", variadic: true },
  ],
  options: {
    format: { summary: "f", values: ["json", "csv"], default: "json" },
    limit: { summary: "l", type: "number" },
    tag: { summary: "t", repeat: true },
    dry: { summary: "d", type: "boolean" },
  },
  stdin: { summary: "s", format: "text" },
} as const;

expectType<
  Equal<
    InputOf<typeof decl>,
    {
      id: number;
      label: string | undefined;
      files: string[];
      format: "json" | "csv";
      limit: number | undefined;
      tag: string[];
      dry: boolean;
      stdin: string;
    }
  >
>(true);

interface Ctx {
  db: { get(id: number): string };
}
interface Other {
  clock: () => number;
}

const { command: ctxCommand } = authoring<Ctx>();

// Inline handlers receive declared input and bound context without annotations.
const show = ctxCommand({
  summary: "show",
  input: { positionals: [{ name: "id", summary: "id", type: "integer", required: true }], options: { json: { summary: "j", type: "boolean" } } },
  output: output<{ text: string }>(),
  run: (input, ctx) => {
    expectType<Equal<typeof input, { id: number; json: boolean }>>(true);
    expectType<Equal<typeof ctx, Ctx>>(true);
    return completed({ text: ctx.db.get(input.id) });
  },
  human: (data, input) => `${data.text} ${input.id}`,
  result: (data) => ({ status: data.text ? "accepted" : "completed" }),
});

// Output parse infers the data type.
const parsed = ctxCommand({
  summary: "parsed output",
  output: output({ parse: (data: unknown) => ({ size: Number(data) }) }),
  run: () => completed({ size: 1 }),
  human: (data) => {
    expectType<Equal<typeof data, { size: number }>>(true);
    return String(data.size);
  },
});
void parsed;

// Examples are input values checked against the declaration.
ctxCommand({
  summary: "examples",
  input: {
    positionals: [{ name: "id", summary: "id", type: "integer", required: true }, { name: "label", summary: "label" }],
    options: { mode: { summary: "m", values: ["a", "b"] }, tag: { summary: "t", repeat: true }, dry: { summary: "d", type: "boolean" } },
    stdin: { summary: "s", format: "json" },
  },
  output: output<null>(),
  run: () => completed(null),
  examples: [
    { summary: "minimal", input: { id: 1 } },
    { summary: "full", input: { id: 1, label: "x", mode: "b", tag: ["p", "q"], dry: true } },
    // @ts-expect-error required positional is missing
    { summary: "missing", input: { label: "x" } },
    // @ts-expect-error not an allowed value
    { summary: "enum", input: { id: 1, mode: "c" } },
    // @ts-expect-error repeatable options take arrays
    { summary: "repeat", input: { id: 1, tag: "p" } },
    // @ts-expect-error stdin is not an argument
    { summary: "stdin", input: { id: 1, stdin: {} } },
    // @ts-expect-error argv is generated, not written
    { summary: "argv", argv: ["1"] },
  ],
});

ctxCommand({
  summary: "parse disagrees with payload",
  output: output({ parse: (data: unknown) => String(data) }),
  // @ts-expect-error parse declares string data
  run: () => completed(1),
});

ctxCommand({
  summary: "constraints",
  input: {
    positionals: [{ name: "from", summary: "f", type: "integer", required: true }, { name: "to", summary: "t", type: "integer" }],
    options: { tag: { summary: "t", repeat: true, check: check.string("lowercase", (v) => v === v.toLowerCase()) } },
    stdin: { summary: "s", format: "json", shape: { description: "numbers", parse: (v: unknown) => (Array.isArray(v) ? { ok: true as const, value: v as number[] } : { ok: false as const, reason: "x" }) } },
  },
  constraints: (rule) => [
    rule(["from", "to"], "ordered", (values) => {
      expectType<Equal<typeof values, { readonly from: number; readonly to: number | undefined }>>(true);
      return values.to !== undefined && values.from > values.to ? "unordered" : undefined;
    }),
    rule(["tag"], "few tags", ({ tag }) => {
      expectType<Equal<typeof tag, readonly string[]>>(true);
      // @ts-expect-error rule inputs are read-only
      tag.push("x");
      return undefined;
    }),
    // @ts-expect-error unknown dependency name
    rule(["from", "nope"], "d", () => undefined),
    // @ts-expect-error stdin is not an argument dependency
    rule(["stdin"], "d", () => undefined),
    // @ts-expect-error a rule needs at least one input
    rule([], "d", () => undefined),
    // @ts-expect-error dependency values keep their declared scalar types
    rule(["from"], "d", ({ from }) => (from.startsWith("1") ? "x" : undefined)),
    // @ts-expect-error rules return a reason string or undefined
    rule(["from"], "d", () => true),
  ],
  output: output<null>(),
  run: (input) => {
    expectType<Equal<typeof input.stdin, number[]>>(true);
    return completed(null);
  },
});

// @ts-expect-error a string check on an integer
command({
  summary: "check type mismatch",
  input: { options: { n: { summary: "n", type: "integer", check: check.string("d", () => true) } } },
  output: output<null>(),
  run: () => completed(null),
});

// @ts-expect-error patterns are for strings
command({
  summary: "pattern on number",
  input: { options: { n: { summary: "n", type: "number", pattern: { regex: "1", description: "d" } } } },
  output: output<null>(),
  run: () => completed(null),
});

command({
  summary: "literal rule",
  input: { positionals: [{ name: "from", summary: "f", type: "integer", required: true }] },
  // @ts-expect-error a rule must come from the factory; a literal with a wrongly typed callback is not a rule
  constraints: () => [{ inputs: ["from"], description: "d", check: ({ from }: { from: string }) => (from.startsWith("1") ? "x" : undefined) }],
  output: output<null>(),
  run: () => completed(null),
});

let stringRule: Constraint<{ from: string }> | undefined;
command({
  summary: "string rule",
  input: { positionals: [{ name: "from", summary: "f", required: true }] },
  constraints: (rule) => {
    stringRule = rule(["from"], "d", ({ from }) => (from.startsWith("1") ? "x" : undefined));
    return [stringRule];
  },
  output: output<null>(),
  run: () => completed(null),
});
command({
  summary: "incompatible reuse",
  input: { positionals: [{ name: "from", summary: "f", type: "integer", required: true }] },
  // @ts-expect-error a rule for string input cannot apply to an integer declaration
  constraints: () => [stringRule!],
  output: output<null>(),
  run: () => completed(null),
});

// @ts-expect-error check.number tests numbers
check.number("d", (v: string) => v.length > 0);

// ── negative cases ─────────────────────────────────────────────────────────

ctxCommand({
  summary: "result cannot replace data",
  output: output<{ text: string }>(),
  run: () => completed({ text: "x" }),
  // @ts-expect-error result decides the status only
  result: () => ({ status: "accepted", data: { text: "y" } }),
});

ctxCommand({
  summary: "result is not an outcome",
  output: output<{ text: string }>(),
  run: () => completed({ text: "x" }),
  // @ts-expect-error result returns {status}, not an Outcome
  result: (data) => accepted(data),
});

ctxCommand({
  summary: "result status",
  output: output<{ text: string }>(),
  run: () => completed({ text: "x" }),
  // @ts-expect-error failed is not a result status
  result: () => ({ status: "failed" }),
});

ctxCommand({
  summary: "wrong payload",
  output: output<{ text: string }>(),
  // @ts-expect-error data does not match the output declaration
  run: () => completed({ txt: "x" }),
});

ctxCommand({
  summary: "unknown input",
  input: { positionals: [{ name: "id", summary: "id", required: true }] },
  output: output<string>(),
  // @ts-expect-error input has no property "name"
  run: (input) => completed(input.name),
});

ctxCommand({
  summary: "unknown context",
  output: output<number>(),
  // @ts-expect-error Ctx has no clock
  run: (_input, ctx) => completed(ctx.clock()),
});

ctxCommand({
  summary: "renderer type",
  output: output<number>(),
  run: () => completed(1),
  // @ts-expect-error data is a number
  human: (data) => data.toUpperCase(),
});

ctxCommand({
  summary: "not an outcome",
  output: output<number>(),
  // @ts-expect-error handlers return Outcome, not bare values
  run: () => 1,
});

ctxCommand({
  summary: "neverthrow is not a core outcome",
  output: output<number>(),
  // @ts-expect-error a Result must be wrapped explicitly with fromNeverthrow
  run: () => ok(1),
});

// @ts-expect-error summary is required
command({ output: output<number>(), run: () => completed(1) });

command({
  summary: "bad positional type",
  // @ts-expect-error unsupported type
  input: { positionals: [{ name: "x", summary: "x", type: "date" }] },
  output: output<null>(),
  run: () => completed(null),
});

// Widened shared declarations cannot claim a presence or array shape they do not have.
const widenedRepeat = { summary: "t", repeat: true };
const widenedRequired = { name: "id", summary: "i", required: true };
command({
  summary: "widened",
  // @ts-expect-error repeat widened to boolean
  input: { options: { tag: widenedRepeat } },
  output: output<null>(),
  run: () => completed(null),
});
command({
  summary: "widened positional",
  // @ts-expect-error required widened to boolean
  input: { positionals: [widenedRequired] },
  output: output<null>(),
  run: () => completed(null),
});
const sharedRepeat = { summary: "t", repeat: true } as const;
command({
  summary: "shared as const",
  input: { options: { tag: sharedRepeat } },
  output: output<null>(),
  run: (input) => {
    expectType<Equal<typeof input, { tag: string[] }>>(true);
    return completed(null);
  },
});
// Misplaced keys do not change the inferred shape (and are rejected at declaration time).
command({
  summary: "misplaced",
  input: { options: { tag: { summary: "t", variadic: true } }, positionals: [{ name: "id", summary: "i", repeat: true }] },
  output: output<null>(),
  run: (input) => {
    expectType<Equal<typeof input, { tag: string | undefined; id: string | undefined }>>(true);
    return completed(null);
  },
});
command({
  summary: "required false",
  // @ts-expect-error required is literal true or omitted
  input: { options: { tag: { summary: "t", required: false } } },
  output: output<null>(),
  run: () => completed(null),
});

// ── adapters ───────────────────────────────────────────────────────────────

type DomainError = { reason: string };

ctxCommand({
  summary: "neverthrow",
  input: { positionals: [{ name: "id", summary: "id", type: "integer", required: true }] },
  output: output<string>(),
  run: fromNeverthrow((input, ctx) => {
    expectType<Equal<typeof input, { id: number }>>(true);
    expectType<Equal<typeof ctx, Ctx>>(true);
    return input.id > 0 ? okAsync(ctx.db.get(input.id)) : err<string, DomainError>({ reason: "negative" });
  }, { error: (e) => ({ code: "BAD", message: e.reason }) }),
});

ctxCommand({
  summary: "neverthrow without mapper",
  output: output<string>(),
  // @ts-expect-error a domain error that is not a Fault needs an error mapper
  run: fromNeverthrow(() => err<string, DomainError>({ reason: "x" })),
});

ctxCommand({
  summary: "neverthrow wrong payload",
  output: output<string>(),
  // @ts-expect-error Ok payload must match the output
  run: fromNeverthrow(() => ok(1)),
});

ctxCommand({
  summary: "effect",
  output: output<number>(),
  run: fromEffect((_input, ctx) => Effect.succeed(ctx.db.get(1).length)),
});

ctxCommand({
  summary: "effect mapper",
  output: output<number>(),
  run: fromEffect(() => Effect.fail<DomainError>({ reason: "x" }), { error: (e) => ({ code: "E", message: e.reason }) }),
});

ctxCommand({
  summary: "effect without mapper",
  output: output<number>(),
  // @ts-expect-error a typed failure that is not a Fault needs an error mapper
  run: fromEffect(() => Effect.fail<DomainError>({ reason: "x" })),
});

class Service extends Effect.Tag("Service")<Service, { value: number }>() {}

ctxCommand({
  summary: "effect requirements",
  output: output<number>(),
  // @ts-expect-error effects must have their requirements provided
  run: fromEffect(() => Effect.map(Service, (s) => s.value)),
});

// ── composition and context ────────────────────────────────────────────────

const tick = authoring<Other>().command({ summary: "tick", output: output<number>(), run: (_i, ctx) => completed(ctx.clock()) });
const plain = command({ summary: "plain", output: output<null>(), run: () => failed({ code: "X", message: "x" }) });

const app = application({
  name: "app",
  version: "1",
  summary: "app",
  commands: { show, time: group({ summary: "time", commands: { tick, plain } }) },
});
expectType<Equal<typeof app, Application<Ctx & Other, typeof app.spec.commands>>>(true);

const both: Ctx & Other = { db: { get: () => "" }, clock: () => 0 };
void execute(app, [], { context: () => both });
// @ts-expect-error the context must satisfy every mounted command
void execute(app, [], { context: () => ({ db: { get: () => "" } }) });
void run(app, { context: async () => both });
// @ts-expect-error run requires the same context
void run(app, { context: () => ({ clock: () => 0 }) });

const contextFree = application({ name: "p", version: "1", summary: "p", commands: { plain } });
void execute(contextFree, [], { context: () => undefined });

// Commands whose contexts cannot both be satisfied are rejected where they are composed.
const needsText = authoring<{ store: string }>().command({ summary: "text", output: output<null>(), run: () => completed(null) });
const needsNumber = authoring<{ store: number }>().command({ summary: "number", output: output<null>(), run: () => completed(null) });
// @ts-expect-error mounted commands require incompatible types for context.store
application({ name: "c", version: "1", summary: "c", commands: { needsText, g: group({ summary: "g", commands: { needsNumber } }) } });

// The context requirement survives assignment: a typed application is not a bare Application.
// @ts-expect-error Application<unknown> would erase the Ctx & Other requirement
const erased: Application<unknown> = app;
void erased;
// @ts-expect-error nor Application<{}>
const erasedEmpty: Application<{}> = app;
void erasedEmpty;
// Discovery needs no context and accepts the view.
const view: ApplicationView = app;
void parseInvocation(view, ["--help"]);
void applicationSchema(app);
// @ts-expect-error a view is not executable
void execute(view, [], { context: () => ({}) });

// ── payload output ─────────────────────────────────────────────────────────

interface Block {
  sessionId: string;
  text: string;
}
const parseBlock = (value: unknown): Block => value as Block;

const blocks = ctxCommand({
  summary: "blocks",
  input: { positionals: [{ name: "scope", summary: "s", required: true }] },
  output: payload.jsonl({ parse: parseBlock, fields: [{ path: "sessionId", summary: "Session" }] }),
  run: (input, ctx, { signal }) => {
    expectType<Equal<typeof input, { scope: string }>>(true);
    expectType<Equal<typeof ctx, Ctx>>(true);
    void signal;
    async function* source(): AsyncGenerator<Block | Stop> {
      yield { sessionId: "s", text: ctx.db.get(1) };
      yield stop({ code: "CORRUPT", message: "corrupt" });
    }
    return input.scope ? records(source()) : failed({ code: "NO_SCOPE", message: "none" });
  },
});
expectType<Equal<typeof blocks, PayloadCommand<{ readonly positionals: readonly [{ readonly name: "scope"; readonly summary: "s"; readonly required: true }] }, Ctx, JsonlPayload<Block>>>>(true);

ctxCommand({
  summary: "wrong record",
  output: payload.jsonl({ parse: parseBlock }),
  // @ts-expect-error records must be Blocks
  run: () => records(fromList([{ sessionId: 1 }])),
});

ctxCommand({
  summary: "text records are strings",
  output: payload.text({ records: "paths", framing: "lf" }),
  // @ts-expect-error text payload records are strings
  run: () => records(fromList([1, 2])),
});

ctxCommand({
  summary: "payload is not a result",
  output: payload.jsonl(),
  // @ts-expect-error payload handlers return records(...) or failed(...), not completed(...)
  run: () => completed({ a: 1 }),
});

ctxCommand({
  summary: "ordinary is not a payload",
  output: output<{ a: number }>(),
  // @ts-expect-error ordinary handlers return outcomes, not records
  run: () => records(fromList([{ a: 1 }])),
});

ctxCommand({
  summary: "no human",
  output: payload.jsonl(),
  run: () => records(fromList([])),
  // @ts-expect-error payload commands have no human renderer
  human: () => "x",
});

ctxCommand({
  summary: "no result mapping",
  output: payload.jsonl(),
  run: () => records(fromList([])),
  // @ts-expect-error payload commands have no result mapping
  result: () => ({ status: "accepted" }),
});

ctxCommand({
  summary: "framing option",
  input: { options: { null: { summary: "n", type: "boolean" } } },
  output: payload.text({ records: "paths", framing: { default: "lf", nul: "null" } }),
  run: () => records(fromList(["a"])),
});

// @ts-expect-error the NUL option must be a declared boolean option
command({
  summary: "missing framing option",
  input: { options: { zero: { summary: "z" } } },
  output: payload.text({ records: "paths", framing: { default: "lf", nul: "zero" } }),
  run: () => records(fromList(["a"])),
});

// @ts-expect-error stop takes a Fault
stop({ reason: "x" });

// @ts-expect-error JSONL records are objects
payload.jsonl<string>();

// An ordinary plain object shaped like a payload is not a payload declaration.
command({
  summary: "fake payload",
  // @ts-expect-error payload declarations come from payload.jsonl or payload.text
  output: { kind: "payload", format: "jsonl", maxRecordBytes: 1 },
  run: () => records(fromList([])),
});

// Legacy explicit generics keep their meaning: the third argument is the result data.
const legacy = command<{ readonly positionals: readonly [{ readonly name: "id"; readonly summary: "id"; readonly required: true }] }, Ctx, { text: string }>({
  summary: "legacy",
  input: { positionals: [{ name: "id", summary: "id", required: true }] },
  output: output<{ text: string }>(),
  run: (input, ctx) => completed({ text: `${input.id}${ctx.db.get(1)}` }),
});
expectType<Equal<typeof legacy, Command<{ readonly positionals: readonly [{ readonly name: "id"; readonly summary: "id"; readonly required: true }] }, Ctx, { text: string }>>>(true);
command<{}, Ctx, { text: string }>({
  summary: "legacy wrong data",
  output: output<{ text: string }>(),
  // @ts-expect-error the explicit data type still constrains run
  run: () => completed({ txt: "x" }),
});
const legacyAuthoring = ctxCommand<{}, number>({ summary: "legacy authoring", output: output<number>(), run: (_i, ctx) => completed(ctx.db.get(1).length) });
expectType<Equal<typeof legacyAuthoring, Command<{}, Ctx, number>>>(true);

// A payload annotated with the exported TextPayload type and fixed framing needs no option.
const fixedFraming: TextPayload = payload.text({ records: "paths", framing: "nul" });
command({ summary: "annotated", output: fixedFraming, run: () => records(fromList(["a"])) });
// A widened option name cannot be checked against the declared options, so it is rejected.
const dynamicName: string = "null";
const widened: TextPayload<string> = payload.text({ records: "paths", framing: { default: "lf", nul: dynamicName } });
// @ts-expect-error a widened option name cannot be proven to be a declared boolean option
command({ summary: "widened", input: { options: { null: { summary: "n", type: "boolean" } } }, output: widened, run: () => records(fromList(["a"])) });

// Command schemas narrow to exactly one of output or payload.
declare const someSchema: CommandSchema;
if (someSchema.payload) {
  expectType<Equal<typeof someSchema.payload.format, "jsonl" | "text">>(true);
  // @ts-expect-error a payload command has no ordinary output
  void someSchema.output.summary;
} else {
  void someSchema.output.summary;
}

// ── conditional stdin ──────────────────────────────────────────────────────

command({
  summary: "conditional text",
  input: { positionals: [{ name: "scope", summary: "s", required: true }], stdin: { summary: "ids", format: "text", when: { input: "scope", equals: "-" } } },
  output: output<null>(),
  run: (input) => {
    expectType<Equal<typeof input.stdin, string | undefined>>(true);
    return completed(null);
  },
});

command({
  summary: "conditional shape",
  input: {
    options: { ids: { summary: "i", type: "boolean" } },
    stdin: { summary: "ids", format: "json", when: { input: "ids", equals: true }, shape: { description: "d", parse: (v: unknown) => ({ ok: true as const, value: v as string[] }) } },
  },
  output: output<null>(),
  run: (input) => {
    expectType<Equal<typeof input.stdin, string[] | undefined>>(true);
    return completed(null);
  },
});

command({
  summary: "unconditional unchanged",
  input: { stdin: { summary: "all", format: "text" } },
  output: output<null>(),
  run: (input) => {
    expectType<Equal<typeof input.stdin, string>>(true);
    return completed(null);
  },
});

// @ts-expect-error when names an undeclared argument
command({ summary: "missing", input: { stdin: { summary: "s", format: "text", when: { input: "scope", equals: "-" } } }, output: output<null>(), run: () => completed(null) });

// @ts-expect-error a string argument cannot equal a number
command({ summary: "kind", input: { positionals: [{ name: "scope", summary: "s" }], stdin: { summary: "s", format: "text", when: { input: "scope", equals: 1 } } }, output: output<null>(), run: () => completed(null) });

// @ts-expect-error a flag compares with a boolean
command({ summary: "flag", input: { options: { ids: { summary: "i", type: "boolean" } }, stdin: { summary: "s", format: "text", when: { input: "ids", equals: "true" } } }, output: output<null>(), run: () => completed(null) });

// @ts-expect-error the value must be one of the declared values
command({ summary: "enum", input: { options: { mode: { summary: "m", values: ["a", "b"] } }, stdin: { summary: "s", format: "text", when: { input: "mode", equals: "c" } } }, output: output<null>(), run: () => completed(null) });

// @ts-expect-error a repeatable option cannot select stdin
command({ summary: "repeat", input: { options: { tag: { summary: "t", repeat: true } }, stdin: { summary: "s", format: "text", when: { input: "tag", equals: "x" } } }, output: output<null>(), run: () => completed(null) });

// @ts-expect-error a variadic positional cannot select stdin
command({ summary: "variadic", input: { positionals: [{ name: "rest", summary: "r", variadic: true }], stdin: { summary: "s", format: "text", when: { input: "rest", equals: "x" } } }, output: output<null>(), run: () => completed(null) });

// A when key typed as optional may be present, so stdin still includes undefined and the condition is still checked.
const optionalWhen: {
  positionals: readonly [{ name: "scope"; summary: string }];
  stdin: { format: "text"; summary: string; when?: { input: "scope"; equals: "-" } };
} = { positionals: [{ name: "scope", summary: "Scope" }], stdin: { format: "text", summary: "IDs", when: { input: "scope", equals: "-" } } };
command({
  summary: "optional when",
  input: optionalWhen,
  output: output<number>(),
  run: ({ stdin }) => {
    expectType<Equal<typeof stdin, string | undefined>>(true);
    // @ts-expect-error stdin may be undefined
    return completed(stdin.length);
  },
});
const optionalBadWhen: {
  positionals: readonly [{ name: "scope"; summary: string }];
  stdin: { format: "text"; summary: string; when?: { input: "nope"; equals: "-" } };
} = { positionals: [{ name: "scope", summary: "Scope" }], stdin: { format: "text", summary: "IDs" } };
// @ts-expect-error an optional when is checked as if present
command({ summary: "optional bad when", input: optionalBadWhen, output: output<null>(), run: () => completed(null) });
const widenedStdin: { stdin: StdinDecl } = { stdin: { format: "text", summary: "IDs" } };
// @ts-expect-error a widened StdinDecl may carry any condition, which cannot be checked
command({ summary: "widened stdin", input: widenedStdin, output: output<null>(), run: () => completed(null) });

// An option with enum values can select stdin with one of those values.
command({
  summary: "enum option condition",
  input: { options: { mode: { summary: "m", values: ["list", "stdin"], default: "list" } }, stdin: { summary: "s", format: "text", when: { input: "mode", equals: "stdin" } } },
  output: output<null>(),
  run: (input) => {
    expectType<Equal<typeof input.mode, "list" | "stdin">>(true);
    expectType<Equal<typeof input.stdin, string | undefined>>(true);
    return completed(null);
  },
});

// A format widened to "text" | "json" may yield any JSON value, so stdin is unknown, not string.
const widenedFormat: { stdin: { format: "text" | "json"; summary: string } } = { stdin: { format: "json", summary: "s" } };
command({
  summary: "widened format",
  input: widenedFormat,
  output: output<null>(),
  run: ({ stdin }) => {
    expectType<Equal<typeof stdin, unknown>>(true);
    return completed(null);
  },
});

// A union where one branch has a condition keeps undefined.
const unionStdin: { positionals: readonly [{ name: "scope"; summary: string }]; stdin: { format: "text"; summary: string } | { format: "text"; summary: string; when: { input: "scope"; equals: "-" } } } = {
  positionals: [{ name: "scope", summary: "s" }],
  stdin: { format: "text", summary: "s" },
};
command({
  summary: "union stdin",
  input: unionStdin,
  output: output<null>(),
  run: ({ stdin }) => {
    expectType<Equal<typeof stdin, string | undefined>>(true);
    // @ts-expect-error one branch may not have read stdin
    void stdin.length;
    return completed(null);
  },
});
const unionBadStdin: { stdin: { format: "text"; summary: string } | { format: "text"; summary: string; when: { input: "nope"; equals: "-" } } } = { stdin: { format: "text", summary: "s" } };
// @ts-expect-error a branch's condition is checked even inside a union
command({ summary: "union bad", input: unionBadStdin, output: output<null>(), run: () => completed(null) });

// ── stdin typing across unions (final audit) ───────────────────────────────

type ScopeArg = readonly [{ name: "scope"; summary: string }];

// an input declaration union where one branch has no stdin never yields a definite string.
function maybeWithoutStdin(input: { positionals: ScopeArg; stdin: { format: "text"; summary: string } } | { positionals: ScopeArg }) {
  return command({
    summary: "maybe stdin",
    input,
    output: output<null>(),
    run: ({ stdin }) => {
      expectType<Equal<typeof stdin, string | undefined>>(true);
      return completed(null);
    },
  });
}
void maybeWithoutStdin;
function optionalStdinKey(input: { positionals: ScopeArg; stdin?: { format: "text"; summary: string } }) {
  return command({
    summary: "optional stdin key",
    input,
    output: output<null>(),
    run: ({ stdin }) => {
      expectType<Equal<typeof stdin, string | undefined>>(true);
      return completed(null);
    },
  });
}
void optionalStdinKey;

// each condition keeps its own name and value.
type Selectors = { positionals: ScopeArg; options: { ids: { summary: string; type: "boolean" } } };
function correlated(input: Selectors & { stdin: { format: "text"; summary: string; when: { input: "scope"; equals: "-" } | { input: "ids"; equals: true } } }) {
  return command({ summary: "valid union of conditions", input, output: output<null>(), run: () => completed(null) });
}
void correlated;
function crossed(input: Selectors & { stdin: { format: "text"; summary: string; when: { input: "scope"; equals: true } | { input: "ids"; equals: "-" } } }) {
  // @ts-expect-error each name is checked with its own value: scope cannot equal true, ids cannot equal "-"
  return command({ summary: "crossed conditions", input, output: output<null>(), run: () => completed(null) });
}
void crossed;

// an optional or union shape yields every value it can produce.
const numbers: StdinShape<number> = { description: "n", parse: () => ({ ok: true, value: 1 }) };
const lists: StdinShape<string[]> = { description: "l", parse: () => ({ ok: true, value: [] }) };
function optionalShape(input: { stdin: { format: "text"; summary: string; shape?: StdinShape<number> } }) {
  return command({
    summary: "optional shape",
    input,
    output: output<null>(),
    run: ({ stdin }) => {
      expectType<Equal<typeof stdin, number | string>>(true);
      return completed(null);
    },
  });
}
function unionShape(input: { positionals: ScopeArg; stdin: { format: "json"; summary: string; shape: StdinShape<number> | StdinShape<string[]>; when: { input: "scope"; equals: "-" } } }) {
  return command({
    summary: "union shape",
    input,
    output: output<null>(),
    run: ({ stdin }) => {
      expectType<Equal<typeof stdin, number | string[] | undefined>>(true);
      return completed(null);
    },
  });
}
void [optionalShape, unionShape, numbers, lists];

// keep literal keys with satisfies; a conditional name needs as const.
const plainStdin = { summary: "All", format: "text" } satisfies StdinDecl;
command({
  summary: "satisfies unconditional",
  input: { stdin: plainStdin },
  output: output<null>(),
  run: ({ stdin }) => {
    expectType<Equal<typeof stdin, string>>(true);
    return completed(null);
  },
});
const scopedStdin = { summary: "IDs", format: "text", when: { input: "scope", equals: "-" } } as const satisfies StdinDecl;
command({
  summary: "as const satisfies conditional",
  input: { positionals: [{ name: "scope", summary: "s", required: true }], stdin: scopedStdin },
  output: output<null>(),
  run: ({ stdin }) => {
    expectType<Equal<typeof stdin, string | undefined>>(true);
    return completed(null);
  },
});
const bareSatisfies = { summary: "IDs", format: "text", when: { input: "scope", equals: "-" } } satisfies StdinDecl;
expectType<Equal<typeof bareSatisfies.when.input, string>>(true);
// @ts-expect-error without as const the name widens to string and cannot be checked
command({ summary: "bare satisfies", input: { positionals: [{ name: "scope", summary: "s", required: true }], stdin: bareSatisfies }, output: output<null>(), run: () => completed(null) });

// a widened or optional StdinDecl, and an InputDecl annotation, cannot pass an unchecked condition.
function optionalWidened(input: { stdin?: StdinDecl }) {
  // @ts-expect-error an optional widened stdin may carry an unchecked condition
  return command({ summary: "optional widened", input, output: output<null>(), run: () => completed(null) });
}
function annotatedInputDecl(input: InputDecl) {
  // @ts-expect-error an InputDecl annotation may carry an unchecked condition
  return command({ summary: "annotated", input, output: output<null>(), run: () => completed(null) });
}
void [optionalWidened, annotatedInputDecl];
// A command without input, written inside a tree, is still unchecked and accepted.
application({ name: "tree", version: "1", summary: "t", commands: { plain: command({ summary: "plain", output: output<null>(), run: () => completed(null) }) } });

// every name in a union of names must accept the value.
function unionNames(input: { positionals: ScopeArg; options: { count: { summary: string; type: "integer" } }; stdin: { format: "text"; summary: string; when: { input: "scope" | "count"; equals: "-" } } }) {
  // @ts-expect-error count is a number, so it can never equal "-"
  return command({ summary: "union names", input, output: output<null>(), run: () => completed(null) });
}
function unionNamesOk(input: { positionals: ScopeArg; options: { mode: { summary: string } }; stdin: { format: "text"; summary: string; when: { input: "scope" | "mode"; equals: "-" } } }) {
  return command({ summary: "union names ok", input, output: output<null>(), run: () => completed(null) });
}
void [unionNames, unionNamesOk];

// ── author input contract ──────────────────────────────────────────────────

{
  // Single declaration object whose type may be boolean: a flag at run time is possible.
  type BoolOrString = { options: { x: { summary: string; type: "boolean" | "string" } } };
  expectType<Equal<InputOf<BoolOrString>, { x: string | boolean | undefined }>>(true);
  expectType<Equal<import("../src/core/input.ts").FlagNames<BoolOrString>, never>>(true);
  expectType<Equal<import("../src/core/input.ts").ExampleInputOf<BoolOrString>, { x?: string | boolean }>>(true);
  expectType<Equal<InputOf<{ options: { x: { summary: string; type: "boolean" | "integer"; default: 3 } } }>, { x: number | boolean }>>(true);
  expectType<Equal<InputOf<{ options: { x: { summary: string; type: "boolean" | "string"; repeat: true } } }>, { x: boolean | string[] }>>(true);
  const kind = "string" as "boolean" | "string";
  command({
    summary: "kind",
    input: { options: { x: { summary: "x", type: kind } } },
    output: output<string>(),
    run: (input) => {
      expectType<Equal<typeof input, { x: string | boolean | undefined }>>(true);
      // @ts-expect-error x may be a boolean at run time
      return completed(input.x?.toUpperCase() ?? "");
    },
  });
  // A possibly-boolean option is not a stdin selector.
  // @ts-expect-error x may be a flag, so it cannot select stdin by a string value
  command({ summary: "kind when", input: { options: { x: { summary: "x", type: kind } }, stdin: { summary: "s", format: "text", when: { input: "x", equals: "-" } } }, output: output<null>(), run: () => completed(null) });

  // Broad annotations yield every value the parser can produce.
  const broad = {} as import("../src/core/input.ts").OptionDecl;
  expectType<Equal<InputOf<{ options: { x: typeof broad } }>, { x: string | number | boolean | (string | number)[] | undefined }>>(true);

  // A union positional name yields optional keys, not two required keys.
  type EitherName = { positionals: [{ name: "left" | "right"; summary: string; required: true }] };
  expectType<Equal<InputOf<EitherName>, { left?: string; right?: string }>>(true);

  // Whole declaration unions are mapped branch by branch.
  type UnionDecl =
    | { positionals: [{ name: "scope"; summary: string }]; stdin: { summary: string; format: "text"; when: { input: "scope"; equals: "-" } } }
    | { options: { all: { summary: string; type: "boolean" } }; stdin: { summary: string; format: "text"; when: { input: "all"; equals: true } } };
  expectType<Equal<InputOf<UnionDecl>, { scope: string | undefined; stdin?: string } | { all: boolean; stdin?: string }>>(true);
}

// Optional literal-preserving helpers.
{
  const timeout = integer({ summary: "Seconds", min: 1, default: 30 });
  const mode = string({ summary: "Mode", values: ["fast", "slow"], default: "fast" });
  const tags = string({ summary: "Tag", repeat: true });
  const verbose = flag({ summary: "Verbose" });
  expectType<Equal<InputOf<{ options: { timeout: typeof timeout; mode: typeof mode; tags: typeof tags; verbose: typeof verbose } }>, { timeout: number; mode: "fast" | "slow"; tags: string[]; verbose: boolean }>>(true);
  // @ts-expect-error a default must be one of the values
  string({ summary: "Mode", values: ["fast", "slow"], default: "medium" });
  // @ts-expect-error unknown declaration keys are rejected
  integer({ summary: "Seconds", requried: true });

  command({
    summary: "all",
    input: { stdin: stdinText({ summary: "text" }) },
    output: output<number>(),
    run: (input) => {
      expectType<Equal<typeof input, { stdin: string }>>(true);
      return completed(input.stdin.length);
    },
  });
  const ids: StdinShape<string[]> = { description: "ids", parse: (v) => (Array.isArray(v) ? { ok: true, value: v.map(String) } : { ok: false, reason: "array" }) };
  command({
    summary: "ids",
    input: { options: { from: flag({ summary: "From stdin" }) }, stdin: stdinJson({ summary: "ids", shape: ids, when: { input: "from", equals: true } }) },
    output: output<null>(),
    run: (input) => {
      expectType<Equal<typeof input, { from: boolean; stdin?: string[] }>>(true);
      return completed(null);
    },
  });
  command({
    summary: "doc",
    input: { stdin: stdinJson({ summary: "doc" }) },
    output: output<null>(),
    run: (input) => {
      expectType<Equal<typeof input, { stdin: unknown }>>(true);
      return completed(null);
    },
  });
  command({
    summary: "positional helper",
    input: { positionals: [positional("scope", string({ summary: "Scope", values: ["all", "-"], default: "all" }))], stdin: stdinText({ summary: "ids", when: { input: "scope", equals: "-" } }) },
    output: output<null>(),
    run: (input) => {
      expectType<Equal<typeof input, { scope: "all" | "-"; stdin?: string }>>(true);
      return completed(null);
    },
  });
}

// Nested stdin.when checking and private hint keys.
{
  type WhenOf<D> = import("../src/core/input.ts").WhenFor<D>;
  type Sel = { positionals: [{ name: "scope"; summary: string; values: ["all", "-"] }]; options: { all: { summary: string; type: "boolean" }; tag: { summary: string; repeat: true } } };
  expectType<Equal<Extract<WhenOf<Sel>, { readonly input: string }>, { readonly input: "scope"; readonly equals: "all" | "-" } | { readonly input: "all"; readonly equals: boolean }>>(true);
  expectType<Equal<keyof Exclude<WhenOf<Sel>, { readonly input: string }> extends symbol ? true : false, true>>(true);

  command({
    summary: "flag compared with a string",
    input: {
      options: { all: { summary: "all", type: "boolean" } },
      // @ts-expect-error a flag compares with true or false
      stdin: { summary: "s", format: "text", when: { input: "all", equals: "yes" } },
    },
    output: output<null>(),
    run: () => completed(null),
  });
  command({
    summary: "repeatable selector",
    input: {
      options: { tag: { summary: "t", repeat: true } },
      // @ts-expect-error a repeatable option cannot select stdin
      stdin: { summary: "s", format: "text", when: { input: "tag", equals: "-" } },
    },
    output: output<null>(),
    run: () => completed(null),
  });
  command({
    summary: "helper condition",
    input: {
      options: { all: { summary: "all", type: "boolean" } },
      // @ts-expect-error the helper keeps the condition literal, so it is checked
      stdin: stdinText({ summary: "s", when: { input: "all", equals: "yes" } }),
    },
    output: output<null>(),
    run: () => completed(null),
  });
  command({
    summary: "copied hint in when",
    input: {
      positionals: [{ name: "scope", summary: "s" }],
      // @ts-expect-error copying the expected text as a key does not satisfy the check
      stdin: { summary: "s", format: "text", when: { input: "scop", equals: "-", stdinWhen: "expected scope equals -" } },
    },
    output: output<null>(),
    run: () => completed(null),
  });
  const wide = {} as Record<string, { summary: string; required: true }>;
  // @ts-expect-error non-literal names belong to dynamicCommand()
  command({ summary: "wide", input: { options: wide }, output: output<null>(), run: () => completed(null) });
  command({
    summary: "copied top-level hint",
    // @ts-expect-error a copied diagnostic property is not a command key
    inputDeclaration: "input names are not literal; use dynamicCommand() for a declaration built at run time",
    input: { options: wide },
    output: output<null>(),
    run: () => completed(null),
  });
}

// constraints: provided(), shared rule functions, forward.
{
  const needsWait = <A extends { timeout: number; wait: boolean }>(rule: ConstraintFactory<A>) =>
    rule(["timeout", "wait"], "--timeout requires --wait", ({ wait }, { provided }) => (provided("timeout") && !wait ? "Use --wait" : undefined));
  const nameShape = <A extends { name: string | undefined }>(rule: ConstraintFactory<A>) =>
    rule(["name"], "name must not start with x", ({ name }) => {
      // The optional effective value keeps undefined for every command that shares the rule.
      const effective: string | undefined = name;
      // @ts-expect-error name may be undefined
      void name.startsWith("x");
      return effective !== undefined && effective.startsWith("x") ? "rename" : undefined;
    });
  const options = { wait: flag({ summary: "Wait" }), timeout: integer({ summary: "Seconds", min: 1, default: 30 }), name: string({ summary: "Name" }) };
  command({ summary: "one", input: { options }, constraints: (rule) => [needsWait(rule), nameShape(rule)], output: output<null>(), run: () => completed(null) });
  command({ summary: "two", input: { positionals: [{ name: "target", summary: "t", required: true }], options }, constraints: (rule) => [needsWait(rule), nameShape(rule)], output: output<null>(), run: () => completed(null) });
  command({
    summary: "missing dependency",
    input: { options: { wait: flag({ summary: "Wait" }) } },
    // @ts-expect-error the shared rule needs a timeout input
    constraints: (rule) => [needsWait(rule)],
    output: output<null>(),
    run: () => completed(null),
  });
  command({
    summary: "provided is limited to the rule's inputs",
    input: { options },
    // @ts-expect-error name is not an input of this rule
    constraints: (rule) => [rule(["wait"], "d", (_values, { provided }) => (provided("name") ? "x" : undefined))],
    output: output<null>(),
    run: () => completed(null),
  });
  // A rule written for values only still compiles.
  command({ summary: "values only", input: { options }, constraints: (rule) => [rule(["wait"], "d", ({ wait }) => (wait ? undefined : undefined))], output: output<null>(), run: () => completed(null) });

  const spawn = command({
    summary: "Spawn",
    input: { positionals: [{ name: "kind", summary: "Kind", required: true }], forward: { name: "agent-args", summary: "Arguments for the agent" } },
    constraints: (rule) => [rule(["agent-args"], "d", (values, { provided }) => (provided("agent-args") && values["agent-args"].length === 0 ? undefined : undefined))],
    examples: [{ summary: "Model", input: { kind: "claude", "agent-args": ["--model", "opus"] } }],
    output: output<string[]>(),
    run: (input) => {
      expectType<Equal<typeof input, { kind: string; "agent-args": string[] }>>(true);
      return completed(input["agent-args"]);
    },
  });
  command({
    summary: "Spawn",
    input: { positionals: [{ name: "kind", summary: "Kind", required: true }], forward: { name: "agent-args", summary: "Arguments" } },
    // @ts-expect-error forwarded arguments are strings
    examples: [{ summary: "Model", input: { kind: "claude", "agent-args": "--model opus" } }],
    output: output<null>(),
    run: () => completed(null),
  });
  void spawn;
}

// dynamicCommand: conservative handler types for declarations built at run time.
{
  const decl = JSON.parse("{}") as InputDecl;
  const dyn = dynamicCommand({
    summary: "Plugin",
    input: decl,
    constraints: (rule) => [rule(["limit"], "limit needs id", (values, { provided }) => (provided("limit") && values.limit === undefined ? "x" : undefined))],
    output: output<{ id: unknown }>(),
    run: (input) => {
      expectType<Equal<typeof input, Readonly<Record<string, unknown>>>>(true);
      return completed({ id: input.id });
    },
  });
  const dynRows = dynamicCommand({ summary: "Rows", input: decl, output: payload.jsonl(), run: () => records((async function* () { yield { a: 1 }; })()) });
  application({ name: "plugins", version: "1", summary: "p", commands: { dyn, rows: dynRows } });
}

// Stdin helpers keep the whole declaration, however it reaches the helper.
{
  const whenScope = { summary: "ids", when: { input: "scope", equals: "-" } } as const;
  const scope = positional("scope", string({ summary: "Scope", values: ["all", "-"], default: "all" }));
  command({
    summary: "extracted when",
    input: { positionals: [scope], stdin: stdinText(whenScope) },
    output: output<number>(),
    run: (input) => {
      expectType<Equal<typeof input, { scope: "all" | "-"; stdin?: string }>>(true);
      // @ts-expect-error stdin is absent unless scope is "-"
      return completed(input.stdin.length);
    },
  });
  const extracted = stdinText(whenScope);
  command({
    summary: "extracted helper result",
    input: { positionals: [scope], stdin: extracted },
    output: output<null>(),
    run: (input) => {
      expectType<Equal<typeof input, { scope: "all" | "-"; stdin?: string }>>(true);
      return completed(null);
    },
  });
  const maybeWhen = JSON.parse("true") as boolean;
  const spread = stdinText({ summary: "ids", ...(maybeWhen ? { when: { input: "scope", equals: "-" } as const } : {}) });
  command({
    summary: "conditional spread",
    input: { positionals: [scope], stdin: spread },
    output: output<null>(),
    run: (input) => {
      expectType<Equal<typeof input, { scope: "all" | "-"; stdin?: string }>>(true);
      return completed(null);
    },
  });
  const optionalWhen: { summary: string; when?: { input: "scope"; equals: "-" } } = JSON.parse("{}");
  command({
    summary: "optional when key",
    input: { positionals: [scope], stdin: stdinText(optionalWhen) },
    output: output<null>(),
    run: (input) => {
      expectType<Equal<typeof input, { scope: "all" | "-"; stdin?: string }>>(true);
      return completed(null);
    },
  });
  const ids: StdinShape<string[]> = { description: "ids", parse: (v) => (Array.isArray(v) ? { ok: true, value: v.map(String) } : { ok: false, reason: "array" }) };
  const jsonWhen = { summary: "ids", shape: ids, when: { input: "from", equals: true } } as const;
  command({
    summary: "json shape and when through a variable",
    input: { options: { from: flag({ summary: "From stdin" }) }, stdin: stdinJson(jsonWhen) },
    output: output<null>(),
    run: (input) => {
      expectType<Equal<typeof input, { from: boolean; stdin?: string[] }>>(true);
      return completed(null);
    },
  });
  const count: StdinShape<number> = { description: "a count", parse: (v) => (typeof v === "string" ? { ok: true, value: v.length } : { ok: false, reason: "text" }) };
  command({
    summary: "text shape",
    input: { stdin: stdinText({ summary: "n", shape: count }) },
    output: output<null>(),
    run: (input) => {
      expectType<Equal<typeof input, { stdin: number }>>(true);
      return completed(null);
    },
  });
  command({
    summary: "json shape",
    input: { stdin: stdinJson({ summary: "ids", shape: ids }) },
    output: output<null>(),
    run: (input) => {
      expectType<Equal<typeof input, { stdin: string[] }>>(true);
      return completed(null);
    },
  });
  // A stdin declaration that may or may not carry a condition makes stdin optional.
  const either = JSON.parse("{}") as { summary: string } | { summary: string; when: { input: "scope"; equals: "-" } };
  command({
    summary: "union declaration",
    input: { positionals: [scope], stdin: stdinText(either) },
    output: output<null>(),
    run: (input) => {
      expectType<Equal<typeof input, { scope: "all" | "-"; stdin?: string }>>(true);
      return completed(null);
    },
  });

  const wrongName = { summary: "ids", when: { input: "scop", equals: "-" } } as const;
  command({
    summary: "wrong when name through a variable",
    // @ts-expect-error scop is not an input
    input: { positionals: [scope], stdin: stdinText(wrongName) },
    output: output<null>(),
    run: () => completed(null),
  });
  const wrongValue = stdinJson({ summary: "ids", when: { input: "from", equals: "yes" } });
  command({
    summary: "wrong when value through an extracted helper",
    // @ts-expect-error a flag compares with true or false
    input: { options: { from: flag({ summary: "From stdin" }) }, stdin: wrongValue },
    output: output<null>(),
    run: () => completed(null),
  });
  // @ts-expect-error unknown declaration keys are rejected
  stdinText({ summary: "s", fromat: "json" });
  const extra = { summary: "s", required: true };
  // @ts-expect-error unknown keys are rejected for non-fresh declarations too
  stdinJson(extra);
}

// A forward name that is a union yields one optional key per name.
{
  const tail = JSON.parse('"a"') as "a" | "b";
  command({
    summary: "forward union",
    input: { forward: { name: tail, summary: "tail" } },
    constraints: (rule) => [
      // @ts-expect-error neither name is always present
      rule(["a"], "d", (values) => (values.a.length > 0 ? undefined : undefined)),
    ],
    examples: [{ summary: "b only", input: { b: ["x"] } }, { summary: "none", input: {} }],
    output: output<number>(),
    run: (input) => {
      expectType<Equal<typeof input, { a?: string[]; b?: string[] }>>(true);
      // @ts-expect-error a may be absent
      return completed(input.a.length);
    },
  });
}

// A union of positional tuples keeps each alternative's keys together.
{
  const x = { name: "x", summary: "x", required: true } as const;
  const y = { name: "y", summary: "y", required: true } as const;
  const yOptional = { name: "y", summary: "y" } as const;
  const xNumber = { name: "x", summary: "x", type: "integer", required: true } as const;
  type Pick2 = readonly [typeof x] | readonly [typeof x, typeof y];
  expectType<Equal<InputOf<{ positionals: Pick2 }>, { x: string } | { x: string; y: string }>>(true);
  expectType<Equal<InputOf<{ positionals: readonly [typeof x] | readonly [typeof x, typeof yOptional] }>, { x: string } | { x: string; y: string | undefined }>>(true);
  expectType<Equal<InputOf<{ positionals: readonly [] | readonly [typeof x] }>, {} | { x: string }>>(true);
  expectType<Equal<InputOf<{ positionals: readonly [typeof x] | readonly [typeof xNumber] }>, { x: string } | { x: number }>>(true);
  const tuple = JSON.parse("[]") as Pick2;
  command({
    summary: "tuple union",
    input: { positionals: tuple },
    constraints: (rule) => [
      rule(["x"], "x present in every alternative", (values) => (values.x.length > 0 ? undefined : undefined)),
      // @ts-expect-error y is not in every alternative
      rule(["y"], "d", () => undefined),
    ],
    examples: [{ summary: "x", input: { x: "a" } }, { summary: "x and y", input: { x: "a", y: "b" } }],
    output: output<number>(),
    run: (input) => {
      // @ts-expect-error y is absent in the one-element alternative
      void input.y.length;
      return completed("y" in input ? input.y.length : input.x.length);
    },
  });
  command({
    summary: "tuple union example",
    input: { positionals: tuple },
    // @ts-expect-error x is required in every alternative
    examples: [{ summary: "y only", input: { y: "b" } }],
    output: output<null>(),
    run: () => completed(null),
  });
  // Ordinary static declarations keep exact types.
  expectType<Equal<InputOf<{ positionals: [typeof x, typeof yOptional] }>, { x: string; y: string | undefined }>>(true);
}

// A default DynamicCommand is mountable when it needs no context; required context is never erased.
{
  const decl = JSON.parse("{}") as InputDecl;
  const plugins: Record<string, import("../src/index.ts").DynamicCommand> = {
    a: dynamicCommand({ summary: "A", input: decl, output: output<null>(), run: () => completed(null) }),
    b: dynamicCommand({ summary: "B", input: decl, output: payload.jsonl(), run: () => records((async function* () { yield { a: 1 }; })()) }),
  };
  application({ name: "plugins", version: "1", summary: "p", commands: plugins });
  const needsDb = dynamicCommand<{ db: string }>({ summary: "Db", input: decl, output: output<null>(), run: () => completed(null) });
  // @ts-expect-error a command that needs context cannot be stored as a context-free DynamicCommand
  const erased: import("../src/index.ts").DynamicCommand = needsDb;
  void erased;
}

// Positionals that may be absent: an undefined or missing alternative declares no positionals.
{
  type ArgsOf<D> = import("../src/index.ts").ArgsOf<D>;
  type ExampleInputOf<D> = import("../src/index.ts").ExampleInputOf<D>;
  type WhenOf<D> = Extract<import("../src/core/input.ts").WhenFor<D>, { readonly input: string }>;
  const x = { name: "x", summary: "x", required: true } as const;
  const y = { name: "y", summary: "y" } as const;

  type MaybeTuple = { positionals: readonly [typeof x] | undefined };
  expectType<Equal<InputOf<MaybeTuple>, {} | { x: string }>>(true);
  expectType<Equal<ArgsOf<MaybeTuple>, {} | { x: string }>>(true);
  expectType<Equal<ExampleInputOf<MaybeTuple>, {} | { x: string }>>(true);
  expectType<Equal<WhenOf<MaybeTuple>, never>>(true);

  type OptionalKey = { positionals?: readonly [typeof x] };
  expectType<Equal<InputOf<OptionalKey>, {} | { x: string }>>(true);
  expectType<Equal<ArgsOf<OptionalKey>, {} | { x: string }>>(true);
  expectType<Equal<ExampleInputOf<OptionalKey>, {} | { x: string }>>(true);
  expectType<Equal<WhenOf<OptionalKey>, never>>(true);

  type EmptyOrTuple = { positionals: readonly [] | readonly [typeof x, typeof y] };
  expectType<Equal<InputOf<EmptyOrTuple>, {} | { x: string; y: string | undefined }>>(true);
  expectType<Equal<WhenOf<EmptyOrTuple>, never>>(true);
  // Static tuples and a name shared by every alternative stay exact and selectable.
  type Static = { positionals: readonly [typeof x, typeof y] };
  expectType<Equal<InputOf<Static>, { x: string; y: string | undefined }>>(true);
  expectType<Equal<WhenOf<Static>, { readonly input: "x"; readonly equals: string } | { readonly input: "y"; readonly equals: string }>>(true);
  type Variants = { positionals: readonly [typeof x] | readonly [typeof x, typeof y] };
  expectType<Equal<WhenOf<Variants>, { readonly input: "x"; readonly equals: string }>>(true);
  expectType<Equal<InputOf<{}>, {}>>(true);

  // Parameter-shaped values: no branch is narrowed away by a const initializer.
  function declare(both: boolean, tuple: readonly [typeof x] | undefined) {
    command({
      summary: "property may be undefined",
      input: { positionals: both ? ([x] as const) : undefined },
      output: output<number>(),
      run: (input) => {
        expectType<Equal<typeof input, {} | { x: string }>>(true);
        // @ts-expect-error x is absent when positionals is undefined
        void input.x.length;
        return completed("x" in input ? input.x.length : 0);
      },
    });
    command({
      summary: "parameter tuple",
      input: { positionals: tuple, options: { all: flag({ summary: "All" }) }, stdin: stdinText({ summary: "s", when: { input: "all", equals: true } }) },
      examples: [{ summary: "none", input: {} }, { summary: "x", input: { x: "a" } }],
      output: output<null>(),
      run: (input) => {
        expectType<Equal<typeof input, { all: boolean; stdin?: string } | { x: string; all: boolean; stdin?: string }>>(true);
        return completed(null);
      },
    });
    command({
      summary: "selector that may be absent",
      input: {
        positionals: tuple,
        // @ts-expect-error x is not declared when positionals is undefined
        stdin: { summary: "s", format: "text", when: { input: "x", equals: "-" } },
      },
      output: output<null>(),
      run: () => completed(null),
    });
    command({
      summary: "whole input may be undefined",
      input: both ? { positionals: [x] } : undefined,
      output: output<number>(),
      run: (input) => {
        expectType<Equal<typeof input, {} | { x: string }>>(true);
        // @ts-expect-error x is absent when input is undefined
        return completed(input.x.length);
      },
    });
    const optional = (both ? { positionals: [x] as const } : {}) as { positionals?: readonly [typeof x] };
    command({
      summary: "optional key",
      input: optional,
      output: output<number>(),
      run: (input) => {
        expectType<Equal<typeof input, {} | { x: string }>>(true);
        // @ts-expect-error x is absent when the key is missing
        return completed(input.x.length);
      },
    });
    authoring<{ db: string }>().command({
      summary: "authoring, input may be undefined",
      input: both ? { positionals: [x] } : undefined,
      output: output<number>(),
      run: (input, context) => {
        expectType<Equal<typeof input, {} | { x: string }>>(true);
        return completed(context.db.length);
      },
    });
  }
  void declare;

  // No-input commands keep contextual inference and literal types.
  const bare = command({ summary: "bare", output: output<"ok">(), run: (input) => {
    expectType<Equal<typeof input, {}>>(true);
    return completed("ok");
  } });
  const literal = command({ summary: "literal", input: { options: { mode: { summary: "m", values: ["a", "b"] } } }, output: output<string>(), run: (input) => {
    expectType<Equal<typeof input, { mode: "a" | "b" | undefined }>>(true);
    return completed(input.mode ?? "");
  } });
  application({ name: "t", version: "1", summary: "t", commands: { bare, literal } });
}

// Fixed framing must not acquire a NUL selector from an erased tree context.
application({ name: "inline-text", version: "1", summary: "inline text", commands: {
  text: command({ summary: "text", output: payload.text({ records: "rows", framing: "lf", readerClose: "allow" }),
    run: () => records((async function* () { yield "row"; })()),
  }),
} });
