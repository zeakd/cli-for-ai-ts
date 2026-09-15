// Constraints owned by input declarations: per-value patterns and checks, and
// cross-input rules with explicit dependencies. They run while argv is parsed,
// so help, parseInvocation and execute agree. They are deterministic,
// synchronous and receive immutable values. Only patterns are published as
// regular expressions; checks and rules publish their descriptions.

/** A per-value check built with check.string or check.number. */
export interface ValueCheck<K extends "string" | "number"> {
  readonly kind: K;
  readonly description: string;
  readonly test: (value: K extends "string" ? string : number) => boolean;
}

const valueChecks = new WeakSet<object>();

function valueCheck<K extends "string" | "number">(kind: K, description: string, test: ValueCheck<K>["test"]): ValueCheck<K> {
  const built = Object.freeze({ kind, description, test });
  valueChecks.add(built);
  return built;
}

/** Custom per-value checks. The test must be synchronous and return a boolean. */
export const check = {
  string: (description: string, test: (value: string) => boolean): ValueCheck<"string"> => valueCheck("string", description, test),
  number: (description: string, test: (value: number) => boolean): ValueCheck<"number"> => valueCheck("number", description, test),
};

export function isValueCheck(value: unknown): value is ValueCheck<"string" | "number"> {
  return typeof value === "object" && value !== null && valueChecks.has(value);
}

/** A string pattern: JavaScript RegExp syntax with the u flag, matched against the whole value. */
export interface PatternDecl {
  readonly regex: string;
  readonly description: string;
}

const compiled = new Map<string, RegExp | Error>();

export function compilePattern(regex: string): RegExp | Error {
  let entry = compiled.get(regex);
  if (entry === undefined) {
    try {
      // The source must be a complete expression on its own: otherwise text such as "a)|(b"
      // would close the wrapper's group and match only a prefix.
      new RegExp(regex, "u");
      // JavaScript's $ without the m flag matches only at the end of input, so the anchors
      // require the whole value, including across alternation and before a final newline.
      entry = new RegExp(`^(?:${regex})$`, "u");
    } catch (error) {
      entry = error instanceof Error ? error : new Error(String(error));
    }
    compiled.set(regex, entry);
  }
  return entry;
}

type DeepReadonly<T> = T extends (infer E)[] ? readonly DeepReadonly<E>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

declare const CONSTRAINT: unique symbol;

/**
 * A cross-input rule for inputs Args. Build it with the factory passed to a
 * command's constraints; rules from anywhere else, including another command's
 * factory, are rejected when the command is declared.
 */
export interface Constraint<Args = unknown> {
  readonly inputs: readonly string[];
  readonly description: string;
  readonly check: (values: never) => unknown;
  /** Type-only brand binding the rule to its command's inputs. */
  readonly [CONSTRAINT]: (args: Args) => Args;
}

/** What a rule may ask about the invocation besides values. */
export interface ConstraintFacts<K extends string> {
  /**
   * Whether the input was given on the command line, as opposed to a default or its
   * absence. A value equal to the default still counts as provided. A forward input is
   * provided when the `--` delimiter was given, even with nothing after it. Only inputs
   * the rule names can be asked about.
   */
  provided(name: K): boolean;
}

/**
 * Builds a rule over the named inputs. check returns a public reason string when
 * the rule is broken, or undefined. It receives only the named inputs, frozen, and
 * facts about how they were given; a check that reads only values can ignore facts.
 */
export type ConstraintFactory<Args> = <const K extends keyof Args & string>(
  inputs: readonly [K, ...K[]],
  description: string,
  check: (values: DeepReadonly<Pick<Args, K>>, facts: ConstraintFacts<K>) => string | undefined,
) => Constraint<Args>;

// Each factory is a scope; a rule belongs to the scope that built it.
const ruleScopes = new WeakMap<object, object>();

/** A fresh factory for one command declaration, and the scope its rules belong to. */
export function constraintScope(): { factory: ConstraintFactory<Record<string, unknown>>; owns: (rule: unknown) => boolean } {
  const scope = {};
  const factory = ((inputs: readonly string[], description: string, check: (values: never) => unknown) => {
    const rule = Object.freeze({ inputs: Object.freeze([...inputs]), description, check });
    ruleScopes.set(rule, scope);
    return rule;
  }) as unknown as ConstraintFactory<Record<string, unknown>>;
  return { factory, owns: (rule) => typeof rule === "object" && rule !== null && ruleScopes.get(rule) === scope };
}

export type Defect = { readonly message: string; readonly cause: unknown };

export type Checked = { ok: true } | { ok: false; rule?: "pattern" | "check"; reason?: string; defect?: Defect };

/** Runs a pattern or check on one parsed scalar. */
export function checkScalar(decl: { pattern?: PatternDecl; check?: ValueCheck<"string" | "number"> }, value: string | number): Checked {
  if (decl.pattern && typeof value === "string") {
    const re = compilePattern(decl.pattern.regex);
    if (re instanceof Error) return { ok: false, defect: { message: "An input pattern could not be compiled", cause: re } };
    if (!re.test(value)) return { ok: false, rule: "pattern" };
  }
  if (decl.check) {
    let result: unknown;
    try {
      result = (decl.check.test as (value: unknown) => unknown)(value);
    } catch (cause) {
      return { ok: false, defect: { message: "An input check threw", cause } };
    }
    if (typeof result !== "boolean") return { ok: false, defect: { message: "An input check did not return a boolean", cause: { returned: result } } };
    if (!result) return { ok: false, rule: "check" };
  }
  return { ok: true };
}

function freezeCopy(value: unknown): unknown {
  return Array.isArray(value) ? Object.freeze([...value]) : value;
}

/** Runs one rule on frozen copies of its inputs, with the set of inputs given on the command line. */
export function checkConstraint(constraint: Constraint, values: Readonly<Record<string, unknown>>, supplied: ReadonlySet<string>): Checked {
  const picked: Record<string, unknown> = {};
  for (const name of constraint.inputs) {
    Object.defineProperty(picked, name, { value: freezeCopy(values[name]), enumerable: true });
  }
  let undeclared: string | undefined;
  const facts = Object.freeze({
    provided: (name: string): boolean => {
      if (!constraint.inputs.includes(name)) {
        undeclared ??= String(name);
        return false;
      }
      return supplied.has(name);
    },
  });
  let result: unknown;
  try {
    result = (constraint.check as unknown as (values: unknown, facts: unknown) => unknown)(Object.freeze(picked), facts);
  } catch (cause) {
    return { ok: false, defect: { message: "An input constraint threw", cause } };
  }
  if (undeclared !== undefined) {
    return { ok: false, defect: { message: "An input constraint asked provided() about an input it does not name", cause: { input: undeclared, inputs: [...constraint.inputs] } } };
  }
  if (result === undefined) return { ok: true };
  if (typeof result !== "string") return { ok: false, defect: { message: "An input constraint returned neither a string nor undefined", cause: { returned: result } } };
  return { ok: false, reason: result };
}
