// Optional declaration helpers. Each returns the same plain declaration object an author
// could write inline, with its literal types kept so it can be defined once and reused
// without `as const`. Commands validate helper results exactly like inline declarations.

import type { PatternDecl, ValueCheck } from "./constraints.ts";
import { AuthoringError } from "./errors.ts";
import type { StdinShape } from "./input.ts";

declare const DECLARATION: unique symbol;

/**
 * Copies a declaration's own data properties without running getters, then adds one key.
 * Accessors and non-plain values are rejected here; command() validates everything else.
 */
function withKey(declaration: object, helper: string, key?: string, value?: unknown): object {
  const proto = typeof declaration === "object" && declaration !== null ? Object.getPrototypeOf(declaration) : undefined;
  if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration) || (proto !== Object.prototype && proto !== null)) {
    throw new AuthoringError(helper, ["declaration must be a plain object"]);
  }
  const out: Record<string, unknown> = {};
  for (const name of Reflect.ownKeys(declaration)) {
    if (typeof name === "symbol") throw new AuthoringError(helper, ["declaration has a symbol key"]);
    const descriptor = Object.getOwnPropertyDescriptor(declaration, name)!;
    if (!("value" in descriptor)) throw new AuthoringError(helper, [`${name} is an accessor`]);
    if (!descriptor.enumerable) throw new AuthoringError(helper, [`${name} is not enumerable`]);
    out[name] = descriptor.value;
  }
  if (key !== undefined) out[key] = value;
  return out;
}

/** Rejects keys the declaration does not understand (generic inference skips excess-property checks). */
type NoExtraKeys<O, Allowed extends string> = [Exclude<keyof O, Allowed>] extends [never]
  ? unknown
  : { readonly [DECLARATION]: `unknown declaration key "${Exclude<keyof O, Allowed> & string}"` };

type Markers = { required?: true; repeat?: true; variadic?: true };
type StringKeys = "summary" | "values" | "default" | "required" | "repeat" | "variadic" | "pattern" | "check";
type NumberKeys = "summary" | "min" | "max" | "default" | "required" | "repeat" | "variadic" | "check";

/** A string value; values narrows it to an enum, and a default must be one of them. */
export function string<
  const V extends string = string,
  const O extends { summary: string; values?: readonly V[]; default?: NoInfer<V>; pattern?: PatternDecl; check?: ValueCheck<"string"> } & Markers = { summary: string },
>(declaration: O & { values?: readonly V[] } & NoExtraKeys<O, StringKeys>): O {
  return withKey(declaration, "string") as O;
}

type NumberDeclaration = { summary: string; min?: number; max?: number; default?: number; check?: ValueCheck<"number"> } & Markers;

/** An integer value in decimal syntax. */
export function integer<const O extends NumberDeclaration>(declaration: O & NoExtraKeys<O, NumberKeys>): { readonly type: "integer" } & O {
  return withKey(declaration, "integer", "type", "integer") as { readonly type: "integer" } & O;
}

/** A number value in JSON number syntax. */
export function number<const O extends NumberDeclaration>(declaration: O & NoExtraKeys<O, NumberKeys>): { readonly type: "number" } & O {
  return withKey(declaration, "number", "type", "number") as { readonly type: "number" } & O;
}

/** A boolean option: present or absent. */
export function flag<const O extends { summary: string }>(declaration: O & NoExtraKeys<O, "summary">): { readonly type: "boolean" } & O {
  return withKey(declaration, "flag", "type", "boolean") as { readonly type: "boolean" } & O;
}

/** Names a value declaration for input.positionals. */
export function positional<const N extends string, const D extends object>(name: N, declaration: D): { readonly name: N } & D {
  return withKey(declaration, "positional", "name", name) as { readonly name: N } & D;
}

type Condition = { readonly input: string; readonly equals: string | number | boolean };
type StdinKeys = "summary" | "when" | "shape";
type StdinHelperDeclaration = { summary: string; when?: Condition; shape?: StdinShape<unknown> };

/**
 * Text stdin. The whole declaration keeps its type, including a when condition or shape given
 * through a variable or a spread, so the handler's stdin is optional exactly when a condition may apply.
 */
export function stdinText<const S extends StdinHelperDeclaration>(declaration: S & NoExtraKeys<S, StdinKeys>): S & { readonly format: "text" } {
  return withKey(declaration, "stdinText", "format", "text") as S & { readonly format: "text" };
}

/** JSON stdin. A shape decides the handler's value type; without one the value is unknown. */
export function stdinJson<const S extends StdinHelperDeclaration>(declaration: S & NoExtraKeys<S, StdinKeys>): S & { readonly format: "json" } {
  return withKey(declaration, "stdinJson", "format", "json") as S & { readonly format: "json" };
}
