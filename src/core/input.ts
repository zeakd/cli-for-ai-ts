// Input declarations: one source for parsing, validation, help and schema.
// Positionals are ordered on the command line and named in the handler.
// Options are named in both places.

import { checkScalar, compilePattern, isValueCheck, type PatternDecl, type ValueCheck } from "./constraints.ts";

export type ValueType = "string" | "number" | "integer";

interface ValueDecl {
  summary: string;
  /** Defaults to "string". */
  type?: ValueType;
  /** Restricts accepted values. Only valid with type "string". */
  values?: readonly string[];
  /** Inclusive bounds. Only valid with type "number" or "integer". */
  min?: number;
  max?: number;
  /**
   * Literal true only: a flag widened to boolean could not tell handlers
   * whether the value is present, so omit the key for optional input.
   */
  required?: true;
  default?: string | number;
  /** Whole-value regular expression for string values. Published with its description. */
  pattern?: PatternDecl;
  /** Custom per-value check from check.string or check.number. Its description is published. */
  check?: ValueCheck<"string"> | ValueCheck<"number">;
}

export interface PositionalDecl extends ValueDecl {
  name: string;
  /** Collects every remaining positional into an array. Only the last positional may be variadic. */
  variadic?: true;
}

export interface ValueOptionDecl extends ValueDecl {
  /** The option may be given several times; the handler receives an array. */
  repeat?: true;
}

export interface FlagOptionDecl {
  summary: string;
  type: "boolean";
}

export type OptionDecl = ValueOptionDecl | FlagOptionDecl;

export type ShapeResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface StdinShape<T> {
  /** Published description of the accepted shape. */
  description: string;
  /** Checks decoded stdin before the context exists. reason is a public, author-written message. */
  parse: (value: unknown) => ShapeResult<T>;
}

/**
 * Reads stdin only when one scalar argument has a given value, compared after
 * parsing, defaults and argument constraints: strict equality, no coercion. An
 * absent optional argument never matches; a boolean option can match false.
 */
export interface StdinCondition {
  /** A declared positional or option that takes a single value. */
  input: string;
  equals: string | number | boolean;
}

export interface StdinDecl {
  summary: string;
  /** "text" passes the string through; "json" parses it before the handler runs. */
  format: "text" | "json";
  /** Validates and may normalize decoded stdin. Invalid shape is an input error (exit 2). */
  shape?: StdinShape<unknown>;
  /** Without it, stdin is read on every execution. With it, only when the condition holds; otherwise input.stdin is undefined. */
  when?: StdinCondition;
}

/**
 * Arguments after the first `--`, passed through as written: no option parsing, no
 * conversion, empty strings and further `--` tokens kept. Own positionals must come
 * before the delimiter. The handler receives string[] ([] when no delimiter was given);
 * giving the delimiter counts as providing the input, even with nothing after it.
 */
export interface ForwardDecl {
  name: string;
  summary: string;
}

export interface InputDecl {
  positionals?: readonly PositionalDecl[];
  options?: Readonly<Record<string, OptionDecl>>;
  /** Pass-through arguments after `--`. A command with forward cannot declare a variadic positional. */
  forward?: ForwardDecl;
  /** Declared stdin: read on every execution, or only when its condition holds. */
  stdin?: StdinDecl;
}

// ── inference ──────────────────────────────────────────────────────────────
// Positionals and options map separately: variadic means an array only on a
// positional, repeat only on an option. Every value-shaping key is read soundly:
// a key counts as set only when its literal is present, so a widened or optional
// key (for example an OptionDecl annotation) yields every value the parser can
// produce. A union of whole declarations is mapped branch by branch.

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The kinds a declaration may parse as: its type key, "string" when the key may be absent. */
type Kinds<D> = D extends unknown ? ("type" extends keyof D ? Exclude<D["type" & keyof D], undefined> | (undefined extends D["type" & keyof D] ? "string" : never) : "string") : never;
type StringPart<D> = D extends { values: readonly (infer V extends string)[] } ? V : string;
type ScalarOf<D> = D extends unknown
  ? ("string" extends Kinds<D> ? StringPart<D> : never) | ([Extract<Kinds<D>, "number" | "integer">] extends [never] ? never : number)
  : never;

/** true when a many-valued key (repeat or variadic) is set, false when absent, boolean when it may be either. */
type Many<D, K extends string> = D extends unknown ? (K extends keyof D ? (D[K & keyof D] extends true ? true : boolean) : false) : never;
type Presence<D, V> = D extends { required: true } | { default: string | number } ? V : V | undefined;
type Collected<D, K extends string> = D extends unknown
  ? (true extends Many<D, K> ? ScalarOf<D>[] : never) | (false extends Many<D, K> ? Presence<D, ScalarOf<D>> : never)
  : never;

type PositionalValue<P> = Collected<P, "variadic">;
/** A declaration that may be a flag ("boolean" among its kinds) can yield a boolean at run time. */
type OptionValue<O> = O extends unknown
  ? O extends { type: "boolean" }
    ? boolean
    : ("boolean" extends Kinds<O> ? boolean : never) | ([Exclude<Kinds<O>, "boolean">] extends [never] ? never : Collected<O, "repeat">)
  : never;

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * Each alternative of a positionals union (e.g. two tuple types), taken apart before element names are merged.
 * An absent key or an undefined alternative declares no positionals, so it stays as an empty alternative.
 */
type PositionalAlternatives<D> = D extends { positionals: infer T }
  ? PositionalList<T>
  : D extends { positionals?: infer T }
    ? PositionalList<T> | readonly []
    : readonly [];
type PositionalList<T> = T extends readonly PositionalDecl[] ? T : readonly [];

/** A positional whose name is a union produces exactly one of those keys at run time, so each is optional. */
type PositionalsOfList<T> = T extends readonly (infer P extends PositionalDecl)[]
  ? { [Q in P as true extends IsUnion<Q["name"]> ? never : Q["name"]]: PositionalValue<Q> } & {
      [Q in P as true extends IsUnion<Q["name"]> ? Q["name"] : never]?: PositionalValue<Q>;
    }
  : never;

/** One object per positionals alternative; {} for an alternative without positionals. */
type PositionalsOf<D> = PositionalsOfList<PositionalAlternatives<D>>;

type OptionsOf<D> = D extends { options: infer O extends Readonly<Record<string, OptionDecl>> } ? { -readonly [K in keyof O]: OptionValue<O[K]> } : {};

/** A forward name that is a union produces exactly one of those keys at run time, so each is optional. */
type ForwardOf<D> = D extends { forward: { name: infer N extends string } } ? (true extends IsUnion<N> ? { [K in N]?: string[] } : { [K in N]: string[] }) : {};

// ── stdin typing ──
// Every union is taken apart first: branches of the input declaration, then branches of
// its stdin declaration, then branches of a condition. A handler never sees a definite
// value that some branch does not guarantee. Stdin that may not be read has no key.

declare const NO_STDIN: unique symbol;
/** Marks a branch of the input declaration that has, or may have, no stdin. */
type NoStdin = { readonly [NO_STDIN]: true };

/** Each possible stdin declaration, with NoStdin for branches where stdin is absent or optional. */
type StdinBranches<D> = D extends unknown
  ? "stdin" extends keyof D
    ? undefined extends D["stdin" & keyof D]
      ? Exclude<D["stdin" & keyof D], undefined> | NoStdin
      : D["stdin" & keyof D]
    : NoStdin
  : never;

/** What decoding one stdin declaration yields before any shape: a string only when the format is surely "text". */
type DecodedOf<S> = S extends { format: infer F } ? ("json" extends F ? unknown : string) : unknown;

/** What a shape's parse can return as its value; unknown when the parse type cannot be read. */
type ShapedOf<Shape> = Shape extends { parse: (value: never) => infer R } ? (R extends { ok: true; value: infer T } ? T : never) : unknown;

/** The value one stdin declaration yields when read: its shape results, or the decoded value when there may be no shape. */
type ReadValueOf<S> = "shape" extends keyof S
  ? ShapedOf<Exclude<S["shape" & keyof S], undefined>> | (undefined extends S["shape" & keyof S] ? DecodedOf<S> : never)
  : DecodedOf<S>;

type MayBeAbsent<S> = S extends NoStdin ? true : "when" extends keyof S ? true : false;
type ReadValues<S> = S extends NoStdin ? never : ReadValueOf<S>;

type StdinOf<D> = [Exclude<StdinBranches<D>, NoStdin>] extends [never]
  ? {}
  : true extends MayBeAbsent<StdinBranches<D>>
    ? { stdin?: ReadValues<StdinBranches<D>> }
    : { stdin: ReadValues<StdinBranches<D>> };

/** In a union where some branch declares stdin, branches without it expose stdin as absent, so handlers can still read input.stdin. */
type AbsentStdin<D, All> = [Exclude<StdinBranches<All>, NoStdin>] extends [never] ? {} : [Exclude<StdinBranches<D>, NoStdin>] extends [never] ? { stdin?: undefined } : {};

/** The value a handler receives for an input declaration. */
export type InputOf<D> = InputBranches<D, D>;
type InputBranches<D, All> = D extends unknown ? (PositionalsOf<D> extends infer P ? (P extends unknown ? Simplify<P & OptionsOf<D> & ForwardOf<D> & StdinOf<D> & AbsentStdin<D, All>> : never) : never) : never;

/** Argument values only: what constraints and examples see. */
export type ArgsOf<D> = D extends unknown ? (PositionalsOf<D> extends infer P ? (P extends unknown ? Simplify<P & OptionsOf<D> & ForwardOf<D>> : never) : never) : never;

// ── declaration checks ──
// Hint properties use private unique symbols: an author cannot write them, so a copied
// diagnostic can never satisfy a check.

declare const INPUT_DECLARATION: unique symbol;
declare const STDIN_WHEN: unique symbol;

type CheckKind<X> = X extends { type: "number" | "integer" } ? "number" : "string";
type Mismatch<X> = X extends { check: ValueCheck<infer K> }
  ? K extends CheckKind<X> ? never : true
  : X extends { pattern: unknown } ? (X extends { type: "number" | "integer" } ? true : never) : never;
type PositionalMismatch<D> = D extends { positionals: readonly (infer P)[] } ? Mismatch<P> : never;
type OptionMismatch<D> = D extends { options: infer O } ? { [K in keyof O]: Mismatch<O[K]> }[keyof O] : never;

/** Single-value arguments and the value a stdin condition compares against. Possibly-many or possibly-flag declarations are not selectors. */
type Selectable<X, K extends string> = true extends Many<X, K> ? false : true;
/** Per positionals alternative; a union of maps exposes only the names every alternative declares. */
type ScalarPositionals<T> = T extends readonly (infer P extends PositionalDecl)[]
  ? { [Q in P as Selectable<Q, "variadic"> extends true ? (true extends IsUnion<Q["name"]> ? never : Q["name"]) : never]: ScalarOf<Q> }
  : never;
type ScalarArgs<D> = ScalarPositionals<PositionalAlternatives<D>> &
  (D extends { options: infer O extends Readonly<Record<string, OptionDecl>> }
    ? {
        [K in keyof O as [O[K]] extends [{ type: "boolean" }] ? K : "boolean" extends Kinds<O[K]> ? never : Selectable<O[K], "repeat"> extends true ? K : never]: [O[K]] extends [{ type: "boolean" }]
          ? boolean
          : ScalarOf<O[K]>;
      }
    : {});

/** Each possible condition of one stdin declaration; an optional when key is checked as if present. */
type ConditionsOf<S> = S extends unknown ? ("when" extends keyof S ? Exclude<S["when" & keyof S], undefined> : never) : never;

/**
 * One condition checked against one input branch. A union of names is checked name by
 * name against the same value, so every name the condition may use must accept it.
 */
type ConditionMismatch<Db, W> = W extends unknown
  ? W extends { input: infer N; equals: infer V }
    ? [N] extends [keyof ScalarArgs<Db>]
      ? NameMismatch<Db, N, V>
      : true
    : true
  : never;

type NameMismatch<Db, N, V> = N extends keyof ScalarArgs<Db> ? ([V] extends [ScalarArgs<Db>[N]] ? never : true) : true;

// Only a declaration branch without a stdin key has no condition to check; an optional or widened stdin is checked.
type WhenMismatch<D> = D extends unknown ? ("stdin" extends keyof D ? ConditionMismatch<D, ConditionsOf<Exclude<StdinBranches<D>, NoStdin>>> : never) : never;

/** Valid conditions as a union keyed by argument name. */
type ValidWhen<D> = { [K in keyof ScalarArgs<D> & string]: { readonly input: K; readonly equals: ScalarArgs<D>[K] } }[keyof ScalarArgs<D> & string];
type Shown<V> = V extends boolean ? "true|false" : V extends string | number ? `${V}` : "?";
type ExpectedWhen<D> = { [K in keyof ScalarArgs<D> & string]: `${K} equals ${Shown<ScalarArgs<D>[K]>}` }[keyof ScalarArgs<D> & string];

/**
 * The type a stdin condition must have. The hint branch never matches an authored value; it
 * makes a mismatch report the accepted conditions instead of collapsing to never.
 */
export type WhenFor<D> = [keyof ScalarArgs<D>] extends [never]
  ? { readonly [STDIN_WHEN]: "no single-value argument can select stdin" }
  : ValidWhen<D> | { readonly [STDIN_WHEN]: ExpectedWhen<D> extends infer E extends string ? `expected ${E}` : never };

/**
 * Checks input.stdin.when at the nested property. A union of whole declarations is not
 * checked here (intersecting it would reject valid unions); it is checked per branch at the call.
 */
export type StdinWhenCheck<D> = { input?: NestedChecked<D> extends true ? { readonly stdin?: { readonly when?: WhenFor<D> } } : unknown };

/** A condition naming a union of arguments is checked name by name at the call instead. */
type UnionNamedCondition<D> = ConditionsOf<Exclude<StdinBranches<D>, NoStdin>> extends infer W ? (W extends { input: infer N } ? IsUnion<N> : false) : false;
type NestedChecked<D> = true extends IsUnion<D> ? false : "stdin" extends keyof D ? (true extends UnionNamedCondition<D> ? false : true) : false;

type NestedFires<D> = NestedChecked<D> extends false ? false : [Exclude<ConditionsOf<Exclude<StdinBranches<D>, NoStdin>>, ValidWhen<D>>] extends [never] ? false : true;

/** Names that are not literal: a declaration built at run time belongs to dynamicCommand(). */
type WideNames<D> =
  | (D extends { positionals?: infer P } ? (Exclude<P, undefined> extends readonly (infer Q extends PositionalDecl)[] ? (string extends Q["name"] ? true : never) : never) : never)
  | (D extends { options?: infer O } ? (string extends keyof Exclude<O, undefined> ? true : never) : never)
  | (D extends { forward?: infer F } ? (Exclude<F, undefined> extends { name: infer N } ? (string extends N ? true : never) : never) : never);

/** Compile-time rejection of non-literal names, a check or pattern that does not fit its value type, or a stdin condition on an unknown argument or value. */
export type InputDeclCheck<D> = [WideNames<D>] extends [never]
  ? [PositionalMismatch<D> | OptionMismatch<D>] extends [never]
    ? NestedFires<D> extends true
      ? unknown
      : [WhenMismatch<D>] extends [never]
        ? unknown
        : {
            readonly [INPUT_DECLARATION]: "stdin.when must name a declared single-value argument by its literal name and a value of its type; keep literals with `as const satisfies StdinDecl`";
          }
    : { readonly [INPUT_DECLARATION]: "a check or pattern does not match its value type (patterns are for strings; use check.number for numbers)" }
  : { readonly [INPUT_DECLARATION]: "input names are not literal; use dynamicCommand() for a declaration built at run time" };

type Given<D, K extends string> = D extends unknown ? (true extends Many<D, K> ? ScalarOf<D>[] : never) | (false extends Many<D, K> ? ScalarOf<D> : never) : never;
type GivenPositional<P> = Given<P, "variadic">;
type GivenOption<O> = O extends unknown
  ? O extends { type: "boolean" }
    ? boolean
    : ("boolean" extends Kinds<O> ? boolean : never) | ([Exclude<Kinds<O>, "boolean">] extends [never] ? never : Given<O, "repeat">)
  : never;

type ExamplePositionalsOfList<T> = T extends readonly (infer P extends PositionalDecl)[]
  ? { [Q in P as Q extends { required: true } ? (true extends IsUnion<Q["name"]> ? never : Q["name"]) : never]: GivenPositional<Q> } & {
      [Q in P as Q extends { required: true } ? (true extends IsUnion<Q["name"]> ? Q["name"] : never) : Q["name"]]?: GivenPositional<Q>;
    }
  : never;
type ExamplePositionals<D> = ExamplePositionalsOfList<PositionalAlternatives<D>>;

type ExampleOptions<D> = D extends { options: infer O extends Readonly<Record<string, OptionDecl>> }
  ? { -readonly [K in keyof O as O[K] extends { required: true } ? K : never]: GivenOption<O[K]> } & {
      -readonly [K in keyof O as O[K] extends { required: true } ? never : K]?: GivenOption<O[K]>;
    }
  : {};

type ExampleForward<D> = D extends { forward: { name: infer N extends string } } ? { [K in N]?: string[] } : {};

/** Input values for an example: required inputs must be given, stdin is not part of argv. One shape per declaration alternative. */
export type ExampleInputOf<D> = D extends unknown
  ? ExamplePositionals<D> extends infer P
    ? P extends unknown
      ? Simplify<P & ExampleOptions<D> & ExampleForward<D>>
      : never
    : never
  : never;

/** Boolean option names: the only options that can select NUL framing. */
export type FlagNames<D> = D extends { options: infer O } ? { [K in keyof O]: [O[K]] extends [{ type: "boolean" }] ? K : never }[keyof O] & string : never;

// ── authoring validation ───────────────────────────────────────────────────

/** Option names owned by the framework on every command. */
export const RESERVED_OPTIONS = ["help", "human", "version"] as const;

const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Problems in an input declaration. These are authoring mistakes, not caller errors. */
const INPUT_KEYS = ["positionals", "options", "forward", "stdin"];
const VALUE_KEYS = ["summary", "type", "values", "min", "max", "required", "default", "pattern", "check"];
const POSITIONAL_KEYS = ["name", ...VALUE_KEYS, "variadic"];
const OPTION_KEYS = [...VALUE_KEYS, "repeat"];
const FLAG_KEYS = ["summary", "type"];
const STDIN_KEYS = ["summary", "format", "shape", "when"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): string[] {
  return Reflect.ownKeys(value)
    .filter((k) => typeof k !== "string" || !allowed.includes(k))
    .map((k) => `${what} has unknown key "${String(k)}"`);
}

export function inputDeclarationIssues(input: InputDecl | undefined): string[] {
  if (input === undefined) return [];
  if (!isPlainObject(input)) return ["input must be a plain object"];
  const issues: string[] = unknownKeys(input, INPUT_KEYS, "input");
  if (input.positionals !== undefined && !Array.isArray(input.positionals)) return [...issues, "input.positionals must be an array"];
  if (input.options !== undefined && !isPlainObject(input.options)) return [...issues, "input.options must be a plain object"];
  const names = new Set<string>();
  const claim = (name: string, what: string) => {
    if (!isValidName(name)) issues.push(`${what} "${name}" must be lowercase kebab-case`);
    if ((RESERVED_OPTIONS as readonly string[]).includes(name)) issues.push(`${what} "${name}" is reserved`);
    if (name === "stdin") issues.push(`${what} "stdin" is reserved for declared stdin`);
    if (names.has(name)) issues.push(`${what} "${name}" duplicates another input name`);
    names.add(name);
  };

  const positionals = input.positionals ?? [];
  let optionalSeen = false;
  positionals.forEach((p, i) => {
    if (!isPlainObject(p as unknown)) {
      issues.push(`positional ${i} must be a plain object`);
      return;
    }
    issues.push(...unknownKeys(p as unknown as Record<string, unknown>, POSITIONAL_KEYS, `positional "${String(p.name)}"`));
    if (typeof p.name !== "string") {
      issues.push(`positional ${i} has no name`);
      return;
    }
    if (p.variadic !== undefined && p.variadic !== true) issues.push(`positional "${p.name}" variadic must be true or omitted`);
    claim(p.name, "positional");
    issues.push(...valueIssues(p as unknown as Record<string, unknown>, `positional "${p.name}"`));
    if (p.variadic && i !== positionals.length - 1) {
      issues.push(`positional "${p.name}" is variadic but not last`);
    }
    const optional = !p.required;
    if (!optional && optionalSeen) {
      issues.push(`required positional "${p.name}" follows an optional positional`);
    }
    if (optional) optionalSeen = true;
  });

  for (const name of Reflect.ownKeys(input.options ?? {})) {
    if (typeof name !== "string") {
      issues.push("options has a symbol key");
      continue;
    }
    const o = (input.options as Record<string, unknown>)[name];
    claim(name, "option");
    if (!isPlainObject(o)) {
      issues.push(`option "${name}" must be a plain object`);
      continue;
    }
    if (o.type === "boolean") {
      const extra = Reflect.ownKeys(o).filter((k) => !FLAG_KEYS.includes(k as string));
      if (extra.length > 0) issues.push(`option "${name}" is boolean and cannot declare ${extra.map(String).join(", ")}`);
      if (typeof o.summary !== "string" || !o.summary.trim()) issues.push(`option "${name}" has no summary`);
    } else {
      issues.push(...unknownKeys(o, OPTION_KEYS, `option "${name}"`));
      if (o.repeat !== undefined && o.repeat !== true) issues.push(`option "${name}" repeat must be true or omitted`);
      issues.push(...valueIssues(o, `option "${name}"`));
    }
  }

  if (input.forward !== undefined) {
    if (!isPlainObject(input.forward as unknown)) issues.push("input.forward must be a plain object");
    else {
      const forward = input.forward as unknown as Record<string, unknown>;
      issues.push(...unknownKeys(forward, ["name", "summary"], "forward"));
      if (typeof forward.name !== "string") issues.push("forward has no name");
      else claim(forward.name, "forward");
      if (typeof forward.summary !== "string" || !forward.summary.trim()) issues.push("forward has no summary");
      const variadic = positionals.find((p) => isPlainObject(p as unknown) && p.variadic);
      if (variadic) issues.push(`positional "${variadic.name}" is variadic; a command with forward passes extra arguments only after --`);
    }
  }

  if (input.stdin !== undefined) {
    if (!isPlainObject(input.stdin)) return [...issues, "stdin must be a plain object"];
    const stdin = input.stdin as unknown as Record<string, unknown>;
    issues.push(...unknownKeys(stdin, STDIN_KEYS, "stdin"));
    if (typeof stdin.summary !== "string" || !stdin.summary.trim()) issues.push("stdin has no summary");
    if (stdin.format !== "text" && stdin.format !== "json") issues.push(`stdin format "${String(stdin.format)}" is not supported`);
    if (stdin.shape !== undefined) {
      const shape = stdin.shape as Record<string, unknown>;
      if (!isPlainObject(shape)) issues.push("stdin shape must be an object");
      else {
        issues.push(...unknownKeys(shape, ["description", "parse"], "stdin shape"));
        if (typeof shape.description !== "string" || !shape.description.trim()) issues.push("stdin shape has no description");
        if (typeof shape.parse !== "function") issues.push("stdin shape parse must be a function");
      }
    }
    if (stdin.when !== undefined) issues.push(...whenIssues(stdin.when, input));
  }
  return issues;
}

/**
 * Whether declared stdin is read for these parsed arguments: always without a
 * condition, otherwise only when the named argument strictly equals the value.
 */
export function stdinSelected(stdin: StdinDecl, values: Readonly<Record<string, unknown>>): boolean {
  if (stdin.when === undefined) return true;
  return Object.hasOwn(values, stdin.when.input) && values[stdin.when.input] === stdin.when.equals;
}

function whenIssues(when: unknown, input: InputDecl): string[] {
  if (!isPlainObject(when)) return ["stdin when must be an object"];
  const issues = unknownKeys(when, ["input", "equals"], "stdin when");
  if (typeof when.input !== "string") return [...issues, "stdin when.input must name an argument"];
  const name = when.input;
  const positional = (input.positionals ?? []).find((p) => isPlainObject(p as unknown) && p.name === name);
  const options = (input.options ?? {}) as Readonly<Record<string, OptionDecl>>;
  const declaredOption = Object.hasOwn(options, name);
  const equals = when.equals;
  if (!positional && !declaredOption) return [...issues, `stdin when.input "${name}" is not a declared positional or option`];
  // A malformed option declaration is reported on its own; the condition cannot be checked against it.
  if (declaredOption && !isPlainObject(options[name] as unknown)) return issues;
  const option = declaredOption ? options[name] : undefined;
  if (positional?.variadic || (option && "repeat" in option && option.repeat)) {
    return [...issues, `stdin when.input "${name}" takes several values; only a single-value argument can select stdin`];
  }
  if (option?.type === "boolean") {
    if (typeof equals !== "boolean") issues.push(`stdin when.equals for boolean option "${name}" must be true or false`);
    return issues;
  }
  const decl = (positional ?? option) as ValueDecl;
  if (typeof equals !== "string" && typeof equals !== "number") {
    return [...issues, `stdin when.equals for "${name}" must be ${decl.type === "integer" ? "an integer" : `a ${decl.type ?? "string"}`}`];
  }
  const problem = checkValue(decl, equals);
  if (problem) issues.push(`stdin when.equals for "${name}" can never match: ${problem}`);
  return issues;
}

function valueIssues(d: Record<string, unknown>, what: string): string[] {
  const issues: string[] = [];
  if (typeof d.summary !== "string" || !d.summary.trim()) issues.push(`${what} has no summary`);
  if (d.type !== undefined && !["string", "number", "integer"].includes(d.type as string)) {
    issues.push(`${what} has unsupported type "${String(d.type)}"`);
    return issues;
  }
  const type = (d.type ?? "string") as ValueType;
  if (d.required !== undefined && d.required !== true) issues.push(`${what} required must be true or omitted`);
  if (d.values !== undefined) {
    if (!Array.isArray(d.values) || d.values.some((v) => typeof v !== "string")) issues.push(`${what} values must be an array of strings`);
    else if (d.values.length === 0) issues.push(`${what} declares an empty value list`);
    if (type !== "string") issues.push(`${what} declares values but is not a string`);
  }
  for (const bound of ["min", "max"] as const) {
    if (d[bound] === undefined) continue;
    if (typeof d[bound] !== "number" || !Number.isFinite(d[bound])) issues.push(`${what} ${bound} must be a finite number`);
    if (type === "string") issues.push(`${what} declares bounds but is a string`);
  }
  if (typeof d.min === "number" && typeof d.max === "number" && d.min > d.max) issues.push(`${what} has min greater than max`);
  if (d.required && d.default !== undefined) issues.push(`${what} is required and has a default`);
  if ((d.variadic || d.repeat) && d.default !== undefined) issues.push(`${what} collects several values and cannot have a default`);
  if (d.pattern !== undefined) {
    const pattern = d.pattern as Record<string, unknown>;
    if (!isPlainObject(pattern)) issues.push(`${what} pattern must be an object`);
    else {
      issues.push(...unknownKeys(pattern, ["regex", "description"], `${what} pattern`));
      if (typeof pattern.description !== "string" || !pattern.description.trim()) issues.push(`${what} pattern has no description`);
      if (typeof pattern.regex !== "string") issues.push(`${what} pattern regex must be a string`);
      else if (compilePattern(pattern.regex) instanceof Error) issues.push(`${what} pattern regex does not compile`);
    }
    if (type !== "string") issues.push(`${what} declares a pattern but is not a string`);
  }
  if (d.check !== undefined) {
    if (!isValueCheck(d.check)) issues.push(`${what} check must be built with check.string or check.number`);
    else {
      if (!d.check.description.trim()) issues.push(`${what} check has no description`);
      if (d.check.kind !== (type === "string" ? "string" : "number")) issues.push(`${what} check is for ${d.check.kind} values but the ${what} is ${type}`);
    }
  }
  if (d.default !== undefined && issues.length === 0) {
    const problem = typeof d.default === "string" || typeof d.default === "number" ? checkValue(d as unknown as ValueDecl, d.default) : "expected a string or number";
    if (problem) issues.push(`${what} default is invalid: ${problem}`);
    else {
      const checked = checkScalar(d as unknown as ValueDecl, d.default as string | number);
      if (!checked.ok) {
        issues.push(checked.defect ? `${what} default could not be checked: ${checked.defect.message}` : `${what} default does not satisfy its constraint`);
      }
    }
  }
  return issues;
}

/**
 * Accepted argument spellings. number: JSON number syntax (e.g. -1.5, 2e3).
 * integer: optional "-" and decimal digits, within the safe integer range.
 * Hexadecimal, binary, surrounding whitespace, "+" and "Infinity" are rejected.
 */
export const NUMBER_SYNTAX = {
  number: { name: "json-number", pattern: /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/ },
  integer: { name: "decimal-integer", pattern: /^-?\d+$/ },
} as const;

/** Converts an argument for a numeric declaration; undefined when its spelling is not accepted. */
export function parseNumber(type: "number" | "integer", raw: string): number | undefined {
  if (!NUMBER_SYNTAX[type].pattern.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  if (type === "integer" && !Number.isSafeInteger(value)) return undefined;
  return value;
}

/** Returns a reason when a converted value violates the declaration. */
export function checkValue(d: ValueDecl, value: string | number): string | undefined {
  const type = d.type ?? "string";
  if (type === "string") {
    if (typeof value !== "string") return "expected a string";
    if (d.values && !d.values.includes(value)) return `expected one of ${d.values.join(", ")}`;
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return `expected ${type === "integer" ? "an integer" : "a number"}`;
  if (type === "integer" && !Number.isSafeInteger(value)) return "expected a safe integer";
  if (d.min !== undefined && value < d.min) return `expected at least ${d.min}`;
  if (d.max !== undefined && value > d.max) return `expected at most ${d.max}`;
  return undefined;
}

export function describeValue(d: ValueDecl): string {
  if (d.values) return d.values.join("|");
  const type = d.type ?? "string";
  if (d.min !== undefined && d.max !== undefined) return `${type} ${d.min}..${d.max}`;
  if (d.min !== undefined) return `${type} >= ${d.min}`;
  if (d.max !== undefined) return `${type} <= ${d.max}`;
  return type;
}
