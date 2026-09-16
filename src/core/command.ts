// Commands and groups are independent declarations. A command does not know
// the path it is mounted at; an application binds commands into a tree.

import { constraintScope, isValueCheck, type Constraint, type ConstraintFactory } from "./constraints.ts";
import { inputDeclarationIssues, isValidName, type ArgsOf, type ExampleInputOf, type FlagNames, type InputDecl, type InputDeclCheck, type InputOf, type StdinWhenCheck } from "./input.ts";
import { AuthoringError } from "./errors.ts";
import { fieldIssues, type OutputField } from "./fields.ts";
import { isPayload, type PayloadDecl, type PayloadHandlerResult, type RecordOf, type TextPayload } from "./payload.ts";
import { jsonCopy, type Outcome } from "./result.ts";
import { snapshot } from "./snapshot.ts";

export interface Execution {
  /** Aborted when the caller cancels. Aborting does not roll back work already done. */
  readonly signal: AbortSignal;
}

export type Handler<I, C, A> = (input: I, context: C, execution: Execution) => Outcome<A> | Promise<Outcome<A>>;

declare const OUTPUT: unique symbol;

/**
 * Describes a command's result data. The type parameter constrains handlers,
 * result mapping and renderers at compile time. Only parse checks data at run
 * time; without it the type is a declaration the framework does not verify.
 */
export interface OutputDecl<A> {
  readonly summary?: string;
  /**
   * A JSON Schema included in applicationSchema() for callers. It is not used
   * for validation, and nothing checks that it agrees with parse.
   */
  readonly schema?: Readonly<Record<string, unknown>>;
  /**
   * Checks successful data exactly once, right after run and before result
   * mapping and presentation. May normalize: its return value is what is
   * reported. Throwing makes the execution an internal error.
   */
  readonly parse?: (data: unknown) => A;
  /** Result fields to describe in help and applicationSchema(). */
  readonly fields?: readonly OutputField[];
  /** Ordinary results only; payload declarations have kind "payload". */
  readonly kind?: never;
  readonly [OUTPUT]?: A;
}

export type { OutputField };
export { AuthoringError };

export interface OutputOptions {
  summary?: string;
  schema?: Readonly<Record<string, unknown>>;
  fields?: readonly OutputField[];
}

export function output<A>(decl: OutputOptions & { parse: (data: unknown) => A }): OutputDecl<A>;
export function output<A>(decl?: OutputOptions): OutputDecl<A>;
export function output<A>(decl: OutputOptions & { parse?: (data: unknown) => A } = {}): OutputDecl<A> {
  return Object.freeze({ ...decl });
}

/** An example invocation, written as input values. Its argv is generated from the declaration at each mounted path. */
/** What result mapping may change. Currently only the reported status. */
export interface ResultMapping {
  readonly status: "completed" | "accepted";
  readonly data?: never;
  readonly error?: never;
}

export interface Example<D extends InputDecl = InputDecl> {
  summary: string;
  input: ExampleInputOf<D>;
}

export interface CommandSpec<D extends InputDecl, C, A> {
  summary: string;
  description?: string;
  examples?: readonly Example<NoInfer<D>>[];
  input?: D;
  /**
   * Rules across arguments, built with the factory: rule(["from", "to"], description, check).
   * Called once when the command is declared. Rules run while argv is parsed; a
   * broken rule is invalid input (exit 2). Descriptions appear in help and schema.
   */
  constraints?: (rule: ConstraintFactory<ArgsOf<NoInfer<D>>>) => readonly Constraint<ArgsOf<NoInfer<D>>>[];
  output: OutputDecl<A>;
  run: Handler<InputOf<D>, C, NoInfer<A>>;
  /**
   * Decides the reported status of completed data, e.g. accepted. Receives data
   * already checked by output.parse and cannot replace it. Not applied to
   * failures or to results the handler returned as accepted.
   */
  result?: (data: NoInfer<A>, input: InputOf<D>) => ResultMapping;
  /** Presentation for --human. Without it, --human prints indented JSON. */
  human?: (data: NoInfer<A>, input: InputOf<D>) => string;
}

declare const FRAMING_OPTION: unique symbol;

/** Compile-time check that a text payload's NUL option names a declared boolean option. The hint key cannot be written by an author. */
export type FramingCheck<D, P> = P extends TextPayload<infer O>
  ? [O] extends [never]
    ? unknown
    : O extends FlagNames<D>
      ? unknown
      : { readonly [FRAMING_OPTION]: `framing option "${O}" must be a declared boolean option` }
  : unknown;

/** A command whose stdout is a declared payload rather than a JSON result. */
export interface PayloadCommandSpec<D extends InputDecl, C, P extends PayloadDecl> {
  summary: string;
  description?: string;
  examples?: readonly Example<NoInfer<D>>[];
  input?: D;
  constraints?: (rule: ConstraintFactory<ArgsOf<NoInfer<D>>>) => readonly Constraint<ArgsOf<NoInfer<D>>>[];
  output: P;
  /** Returns records(source) to stream, or failed(fault) before any record. */
  run: (input: InputOf<D>, context: C, execution: Execution) => PayloadHandlerResult<RecordOf<NoInfer<P>>> | Promise<PayloadHandlerResult<RecordOf<NoInfer<P>>>>;
  result?: never;
  human?: never;
}

export interface PayloadCommand<D extends InputDecl = InputDecl, C = unknown, P extends PayloadDecl = PayloadDecl> {
  readonly kind: "command";
  readonly spec: Readonly<PayloadCommandSpec<D, C, P>>;
}

export interface Command<D extends InputDecl = InputDecl, C = unknown, A = unknown> {
  readonly kind: "command";
  readonly spec: Readonly<CommandSpec<D, C, A>>;
}

/** A command with its type parameters erased, as stored in a tree. */
export interface AnyCommand {
  readonly kind: "command";
  readonly spec: {
    readonly summary: string;
    readonly description?: string;
    readonly examples?: readonly { readonly summary: string; readonly input: unknown }[];
    readonly input?: InputDecl;
    readonly output: OutputDecl<unknown> | PayloadDecl;
    readonly constraints?: (...args: never[]) => unknown;
    readonly run: (...args: never[]) => unknown;
    readonly result?: (...args: never[]) => unknown;
    readonly human?: (...args: never[]) => unknown;
  };
}

export type Tree = Readonly<Record<string, AnyCommand | Group>>;

export interface GroupSpec<T extends Tree> {
  summary: string;
  description?: string;
  commands: T;
}

export interface Group<T extends Tree = Tree> {
  readonly kind: "group";
  readonly spec: Readonly<GroupSpec<T>>;
}

// Commands and groups built by command() and group(); trees accept nothing else.
const declared = new WeakSet<object>();

export function isDeclared(node: unknown): node is AnyCommand | Group {
  return typeof node === "object" && node !== null && declared.has(node);
}

function declare<T extends object>(node: T): T {
  declared.add(Object.freeze(node));
  return node;
}

const constraintsBySpec = new WeakMap<object, readonly Constraint[]>();

/** The cross-input rules declared by a command, in declaration order. */
export function constraintsOf(spec: object): readonly Constraint[] {
  return constraintsBySpec.get(spec) ?? [];
}

function buildConstraints(define: (rule: unknown) => unknown, input: InputDecl | undefined): readonly Constraint[] | { issues: string[] } {
  const { factory, owns } = constraintScope();
  let rules: unknown[];
  try {
    const built = define(factory);
    if (!Array.isArray(built)) return { issues: ["constraints must return an array of rules"] };
    rules = Array.from(built);
  } catch {
    return { issues: ["constraints threw while building rules"] };
  }
  const names = new Set([...(input?.positionals ?? []).map((p) => p.name), ...Object.keys(input?.options ?? {}), ...(input?.forward ? [input.forward.name] : [])]);
  const issues: string[] = [];
  rules.forEach((rule, i) => {
    const what = `constraint ${i}`;
    // Provenance first: nothing else about an unknown object is read or trusted.
    if (!owns(rule)) {
      issues.push(`${what} was not built by this command's rule factory`);
      return;
    }
    const { inputs, description } = rule as Constraint;
    if (inputs.length === 0) issues.push(`${what} names no inputs`);
    if (typeof description !== "string" || !description.trim()) issues.push(`${what} has no description`);
    if (typeof (rule as Constraint).check !== "function") issues.push(`${what} check must be a function`);
    const seen = new Set<string>();
    for (const name of inputs) {
      if (typeof name !== "string" || !names.has(name)) issues.push(`${what} names unknown input "${String(name)}"`);
      else if (seen.has(name)) issues.push(`${what} names "${name}" twice`);
      seen.add(name as string);
    }
  });
  return issues.length > 0 ? { issues } : Object.freeze(rules as Constraint[]);
}

/** The data type an ordinary output declaration describes. */
export type DataOf<O> = O extends OutputDecl<infer A> ? A : unknown;

/** What every command declares, independent of its output kind. */
export type CommandBase<D extends InputDecl> = Omit<CommandSpec<D, never, never>, "output" | "run" | "result" | "human">;

/** The output-dependent part of a spec: a payload handler, or an ordinary result handler with its mapping and renderer. */
export interface OutputPart<D extends InputDecl, C, O> {
  output: O;
  run: O extends PayloadDecl ? PayloadCommandSpec<D, C, O>["run"] : CommandSpec<D, C, DataOf<O>>["run"];
  result?: O extends PayloadDecl ? never : CommandSpec<D, C, DataOf<O>>["result"];
  human?: O extends PayloadDecl ? never : CommandSpec<D, C, DataOf<O>>["human"];
}

/** The spec shape selected by the output declaration. */
export type SpecFor<D extends InputDecl, C, O> = CommandBase<D> & OutputPart<D, C, O>;

/** The command built from a spec with output declaration O. */
export type CommandFor<D extends InputDecl, C, O> = O extends PayloadDecl ? PayloadCommand<D, C, O> : Command<D, C, DataOf<O>>;

/** An input that may be undefined declares nothing on that branch: it is typed as an empty declaration alternative. */
export type Present<D> = D extends undefined ? {} : D;

/**
 * The inference site for D. A non-optional input: D member keeps an undefined alternative, which an
 * optional property would drop; commands without input match the second member.
 */
export type InputPresence<D> = { input: D } | { input?: undefined };

// One signature rather than overloads: the output declaration is inferred first, and the
// handler is then contextually typed for that kind of output only.
// NoInfer on the result: a command written inside a tree must not take its input type from the
// tree's erased command type, which would make an absent input look like a declared InputDecl.
// A is kept third so explicit command<D, C, A>() calls from ordinary code still mean the result
// type; the output declaration O defaults to OutputDecl<A> then, and is inferred otherwise.
export function command<
  const D extends InputDecl | undefined = {},
  C = unknown,
  A = unknown,
  O extends OutputDecl<any> | PayloadDecl = OutputDecl<A>,
>(spec: SpecFor<Present<D>, C, O> & InputPresence<D> & StdinWhenCheck<Present<D>> & InputDeclCheck<Present<D>> & FramingCheck<Present<D>, O>): CommandFor<NoInfer<Present<D>>, C, O>;
export function command(spec: unknown): AnyCommand {
  // Value checks and payload declarations are branded, already frozen objects: keep them, do not copy.
  const copied = snapshot(spec, "command", (value) => isValueCheck(value) || isPayload(value));
  if (!copied.ok) throw new AuthoringError("command", [copied.issue]);
  const s = copied.value as CommandSpec<InputDecl, unknown, unknown> & Record<string, unknown>;
  const issues: string[] = [];
  const allowed = ["summary", "description", "examples", "input", "constraints", "output", "run", "result", "human"];
  for (const key of Reflect.ownKeys(s)) if (typeof key !== "string" || !allowed.includes(key)) issues.push(`unknown key "${String(key)}"`);
  if (typeof s.summary !== "string" || !s.summary.trim()) issues.push("summary is required");
  if (s.description !== undefined && typeof s.description !== "string") issues.push("description must be a string");
  if (typeof s.run !== "function") issues.push("run must be a function");
  if (typeof s.output !== "object" || s.output === null) issues.push("output is required");
  else if (isPayload(s.output as unknown)) {
    const out = s.output as unknown as PayloadDecl;
    if (s.result !== undefined) issues.push("result cannot be used with a payload output");
    if (s.human !== undefined) issues.push("human cannot be used with a payload output; payload commands reject --human");
    const framing = out.format === "text" ? out.framing : undefined;
    if (typeof framing === "object") {
      const option = (s.input?.options ?? {})[framing.nul];
      if (option === undefined || !Object.hasOwn(s.input?.options ?? {}, framing.nul) || option.type !== "boolean") {
        issues.push(`payload framing option "${framing.nul}" must be a declared boolean option`);
      }
    }
  } else {
      const o = s.output as unknown as Record<string, unknown>;
      for (const key of Object.keys(o)) if (!["summary", "schema", "parse", "fields"].includes(key)) issues.push(`output has unknown key "${key}"`);
      if (o.fields !== undefined) issues.push(...fieldIssues(o.fields, "data", "output field"));
      if (o.parse !== undefined && typeof o.parse !== "function") issues.push("output parse must be a function");
      if (o.summary !== undefined && typeof o.summary !== "string") issues.push("output summary must be a string");
      if (o.schema !== undefined) {
        // Published verbatim by applicationSchema(), so it must be plain JSON. The schema dialect is not checked.
        const copied = typeof o.schema === "object" && o.schema !== null && !Array.isArray(o.schema) ? jsonCopy(o.schema, "output.schema") : undefined;
        if (copied === undefined) issues.push("output schema must be a plain object");
        else if (!copied.ok) issues.push(`output schema is not plain JSON: ${copied.reason}`);
      }
  }
  let rules: readonly Constraint[] = [];
  if (s.constraints !== undefined) {
    if (typeof s.constraints !== "function") issues.push("constraints must be a function");
    else {
      const built = buildConstraints(s.constraints as (rule: unknown) => unknown, s.input);
      if ("issues" in built) issues.push(...built.issues);
      else rules = built;
    }
  }
  if (s.result !== undefined && typeof s.result !== "function") issues.push("result must be a function");
  if (s.human !== undefined && typeof s.human !== "function") issues.push("human must be a function");
  if (s.examples !== undefined && !Array.isArray(s.examples)) issues.push("examples must be an array");
  issues.push(...inputDeclarationIssues(s.input));
  if (issues.length > 0) throw new AuthoringError(`command "${typeof s.summary === "string" ? s.summary : "(no summary)"}"`, issues);
  constraintsBySpec.set(s, rules);
  return declare({ kind: "command", spec: s });
}

/** A command factory with a bound context, suitable for exported consumer helpers. */
export interface CommandFactory<C> {
  <const D extends InputDecl | undefined = {}, A = unknown, O extends OutputDecl<any> | PayloadDecl = OutputDecl<A>>(
    spec: SpecFor<Present<D>, C, O> & InputPresence<D> & StdinWhenCheck<Present<D>> & InputDeclCheck<Present<D>> & FramingCheck<Present<D>, O>,
  ): CommandFor<NoInfer<Present<D>>, C, O>;
}

/** The authoring helpers bound to a context type. */
export interface Authoring<C> {
  command: CommandFactory<C>;
}

/** Binds the context type for commands. It binds nothing else. */
export function authoring<C>(): Authoring<C> {
  return {
    command<const D extends InputDecl | undefined = {}, A = unknown, O extends OutputDecl<any> | PayloadDecl = OutputDecl<A>>(
      spec: SpecFor<Present<D>, C, O> & InputPresence<D> & StdinWhenCheck<Present<D>> & InputDeclCheck<Present<D>> & FramingCheck<Present<D>, O>,
    ): CommandFor<NoInfer<Present<D>>, C, O> {
      return command<D, C, A, O>(spec);
    },
  };
}

export function group<const T extends Tree>(spec: GroupSpec<T>): Group<T> {
  const copied = snapshot(spec, "group", isDeclared);
  if (!copied.ok) throw new AuthoringError("group", [copied.issue]);
  const s = copied.value as GroupSpec<T> & Record<string, unknown>;
  const issues: string[] = [];
  for (const key of Reflect.ownKeys(s)) if (typeof key !== "string" || !["summary", "description", "commands"].includes(key)) issues.push(`unknown key "${String(key)}"`);
  if (typeof s.summary !== "string" || !s.summary.trim()) issues.push("summary is required");
  if (s.description !== undefined && typeof s.description !== "string") issues.push("description must be a string");
  issues.push(...treeIssues(s.commands));
  if (issues.length > 0) throw new AuthoringError(`group "${typeof s.summary === "string" ? s.summary : "(no summary)"}"`, issues);
  return declare({ kind: "group", spec: s });
}

export function treeIssues(commands: Tree | undefined): string[] {
  if (typeof commands !== "object" || commands === null || Array.isArray(commands)) return ["commands must be an object"];
  const issues: string[] = [];
  const entries = Object.entries(commands);
  if (entries.length === 0) issues.push("commands must not be empty");
  for (const [name, node] of entries) {
    if (!isValidName(name)) issues.push(`command name "${name}" must be lowercase kebab-case`);
    if (!isDeclared(node)) issues.push(`"${name}" is not a command or group; build it with command() or group()`);
  }
  return issues;
}

type NonUnknown<C> = unknown extends C ? never : C;

type ContextUnion<T> = {
  [K in keyof T]: T[K] extends { readonly spec: { readonly run: (input: never, context: infer C, ...rest: never[]) => unknown } }
    ? NonUnknown<C>
    : T[K] extends Group<infer U>
      ? ContextUnion<U>
      : never;
}[keyof T];

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

/** The context an application must provide: every mounted command's context, combined. */
export type ContextOf<T extends Tree> = UnionToIntersection<ContextUnion<T>>;

// ── declarations built at run time ──

/** Handler input for a declaration built at run time: names and value types are known only after validation. */
export type DynamicInput = Readonly<Record<string, unknown>>;

/**
 * A command whose input declaration is built at run time (for example from a
 * plugin manifest). The declaration, constraints, examples and output get exactly
 * the same validation and snapshot as command(); only the static types are
 * conservative: handlers receive DynamicInput and must decode what they read.
 */
export interface DynamicCommandSpec<C, O> {
  summary: string;
  description?: string;
  examples?: readonly { summary: string; input: DynamicInput }[];
  input?: InputDecl;
  constraints?: (rule: ConstraintFactory<DynamicInput>) => readonly Constraint<DynamicInput>[];
  output: O;
  run: O extends PayloadDecl
    ? (input: DynamicInput, context: C, execution: Execution) => PayloadHandlerResult<RecordOf<O>> | Promise<PayloadHandlerResult<RecordOf<O>>>
    : Handler<DynamicInput, C, DataOf<O>>;
  result?: O extends PayloadDecl ? never : (data: DataOf<O>, input: DynamicInput) => ResultMapping;
  human?: O extends PayloadDecl ? never : (data: DataOf<O>, input: DynamicInput) => string;
}

export interface DynamicCommand<C = unknown, O = OutputDecl<unknown> | PayloadDecl> {
  readonly kind: "command";
  readonly spec: Readonly<DynamicCommandSpec<C, O>>;
}

export function dynamicCommand<C = unknown, A = unknown, O extends OutputDecl<any> | PayloadDecl = OutputDecl<A>>(spec: DynamicCommandSpec<C, O>): DynamicCommand<C, O> {
  // The same implementation as command(): snapshot, declaration checks and constraint provenance.
  return (command as unknown as (spec: unknown) => DynamicCommand<C, O>)(spec);
}
