// Pure routing and input parsing. One grammar for every mounted command,
// with no built-in commands. Groups never execute: a path ending at a group is help.

import { constraintsOf, type AnyCommand, type Group, type Tree } from "./command.ts";
import { checkConstraint, checkScalar, type Defect } from "./constraints.ts";
import { isPayload } from "./payload.ts";
import { checkValue, describeValue, NUMBER_SYNTAX, parseNumber, type InputDecl, type OptionDecl, type PositionalDecl } from "./input.ts";
import type { Fault } from "./result.ts";
import { suggest } from "./suggest.ts";

export interface ApplicationSpec<T extends Tree = Tree> {
  name: string;
  version: string;
  summary: string;
  description?: string;
  commands: T;
}

/** The data of an application, without its context requirement. Enough for routing, help and schema. */
export interface ApplicationView<T extends Tree = Tree> {
  readonly kind: "application";
  readonly spec: Readonly<ApplicationSpec<T>>;
  /** The mounted command tree: exactly the authored commands. */
  readonly commands: Tree;
}

declare const CONTEXT: unique symbol;

/**
 * An executable application. The context requirement is invariant: a typed
 * application cannot be widened to Application<unknown> and executed with a
 * context its commands do not accept. Use ApplicationView for discovery only.
 */
export interface Application<C, T extends Tree = Tree> extends ApplicationView<T> {
  /** Type-only marker; no such property exists at run time. */
  readonly [CONTEXT]: (context: C) => C;
}

export type Node = ApplicationView | Group | AnyCommand;

export type Invocation =
  | { readonly kind: "help"; readonly path: readonly string[]; readonly node: Node }
  | { readonly kind: "version" }
  | {
      readonly kind: "run";
      readonly path: readonly string[];
      readonly command: AnyCommand;
      /** Parsed argv with defaults applied. Declared stdin is not read yet. */
      readonly input: Readonly<Record<string, unknown>>;
      readonly human: boolean;
    }
  /** command is set when argv resolved to a command before the error, so the error can use that command's channel. */
  | { readonly kind: "invalid"; readonly path: readonly string[]; readonly fault: Fault; readonly command?: AnyCommand }
  /** A declared check, pattern or constraint is defective. message is safe to show; cause is for diagnostics only. */
  | { readonly kind: "internal"; readonly path: readonly string[]; readonly message: string; readonly cause: unknown; readonly command?: AnyCommand };

const GROUP_FLAGS = ["--help", "--human"];
const ROOT_FLAGS = ["--help", "--human", "--version"];

function childrenOf(node: ApplicationView | Group): Tree {
  return node.kind === "application" ? node.commands : node.spec.commands;
}

export function parseInvocation(app: ApplicationView, argv: readonly string[]): Invocation {
  const path: string[] = [];
  let node: Node = app;
  let help = false;
  let human = false;
  let version = false;
  let i = 0;

  while (node.kind !== "command") {
    const token = argv[i];
    if (token === undefined) {
      if (version) {
        return path.length === 0 && !help && !human
          ? { kind: "version" }
          : invalid(path, "--version cannot be combined with other arguments", { input: "--version" });
      }
      return { kind: "help", path, node };
    }
    i++;
    if (token.startsWith("-")) {
      if (token === "--help") help = true;
      else if (token === "--human") human = true;
      else if (token === "--version" && path.length === 0) version = true;
      else {
        const flags = path.length === 0 ? ROOT_FLAGS : GROUP_FLAGS;
        const name = token.split("=")[0]!;
        const close = suggest(name, flags);
        // Only the name is repeated: an inline value can be a credential.
        return invalid(path, `Unknown option: ${name}`, {
          input: name,
          allowed: flags,
          ...(close && close !== name ? { suggestion: close } : {}),
        });
      }
      continue;
    }
    if (version) return invalid(path, "--version cannot be combined with other arguments", { input: "--version" });
    const children: Tree = childrenOf(node);
    const next = Object.hasOwn(children, token) ? children[token] : undefined;
    if (next === undefined) {
      const names = Object.keys(children);
      const close = suggest(token, names);
      return {
        kind: "invalid",
        path,
        fault: {
          code: "UNKNOWN_COMMAND",
          message: `Unknown command: ${[app.spec.name, ...path, token].join(" ")}`,
          details: { input: token, allowed: names, ...(close ? { suggestion: close } : {}) },
        },
      };
    }
    path.push(token);
    node = next;
  }

  const command = node;
  const parsed = parseInput(command.spec.input, argv.slice(i), { human: !isPayload(command.spec.output) });
  if (!parsed.ok) {
    return parsed.defect ? { kind: "internal", path, command, ...parsed.defect } : { kind: "invalid", path, command, fault: parsed.fault };
  }
  help ||= parsed.help;
  human ||= parsed.human;
  // A payload's declared format is its only presentation; --human is refused wherever it appeared, as supplied input.
  if (human && isPayload(command.spec.output)) {
    return {
      kind: "invalid",
      path,
      command,
      fault: { code: "INVALID_INPUT", message: "--human is not supported: this command prints a declared payload", details: { input: "--human" } },
    };
  }
  // Help validates what was supplied: omitted required input is allowed, and a rule runs only when all its inputs were given.
  if (!help && parsed.missing) return { kind: "invalid", path, command, fault: parsed.missing };
  const ruled = applyConstraints(command.spec, parsed.values, parsed.supplied, help);
  if (!ruled.ok) return ruled.defect ? { kind: "internal", path, command, ...ruled.defect } : { kind: "invalid", path, command, fault: ruled.fault };
  if (help) return { kind: "help", path, node };
  return { kind: "run", path, command: node, input: parsed.values, human };
}

type Rejected = { ok: false; fault: Fault; defect?: undefined } | { ok: false; defect: Defect; fault?: undefined };

/**
 * Runs a command's cross-input rules. supplied holds the inputs given on the command line;
 * for help, rules whose inputs were not all given are skipped.
 */
export function applyConstraints(spec: object, values: Readonly<Record<string, unknown>>, supplied: ReadonlySet<string>, help = false): { ok: true } | Rejected {
  for (const constraint of constraintsOf(spec)) {
    if (help && !constraint.inputs.every((name) => supplied.has(name))) continue;
    const checked = checkConstraint(constraint, values, supplied);
    if (checked.ok) continue;
    if (checked.defect) return { ok: false, defect: checked.defect };
    return {
      ok: false,
      fault: {
        code: "INVALID_INPUT",
        message: `Invalid input: ${checked.reason}`,
        details: { inputs: [...constraint.inputs], expected: constraint.description, reason: checked.reason },
      },
    };
  }
  return { ok: true };
}

type Parsed =
  | {
      ok: true;
      values: Record<string, unknown>;
      /** Inputs given in argv; repeated and variadic inputs count when at least one value was given, a forward input when `--` was given. */
      supplied: ReadonlySet<string>;
      /** The first omitted required input, reported unless the invocation is help. */
      missing?: Fault;
      help: boolean;
      human: boolean;
    }
  | Rejected;

/**
 * The one lexical exception for tokens starting with "-": a negative number in JSON
 * number syntax is a value, as is a lone "-". Every other such token is an option or the
 * `--` delimiter, never a value; its type is checked by the argument's value syntax later.
 */
const NEGATIVE_NUMBER = /^-(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Whether a token is read as an option (or the delimiter) rather than a value. */
export function isOptionShaped(token: string): boolean {
  return token.startsWith("-") && token !== "-" && !NEGATIVE_NUMBER.test(token);
}

/**
 * Parses tokens after the command path in one pass: conversion, declared value
 * constraints and defaults. Custom checks run once per supplied value.
 */
export function parseInput(decl: InputDecl | undefined, tokens: readonly string[], opts: { human?: boolean } = {}): Parsed {
  const humanFlag = opts.human ?? true;
  const options = decl?.options ?? {};
  const positionals = decl?.positionals ?? [];
  // Own properties only: declared names such as "constructor" must never read inherited values.
  const values: Record<string, unknown> = {};
  const has = (name: string) => Object.hasOwn(values, name);
  const set = (name: string, value: unknown) =>
    Object.defineProperty(values, name, { value, enumerable: true, writable: true, configurable: true });
  const rest: string[] = [];
  const supplied = new Set<string>();
  const forward = decl?.forward;
  let forwarded: string[] | undefined;
  let missingFault: Fault | undefined;
  let help = false;
  let human = false;
  let literal = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (literal) {
      rest.push(token);
      continue;
    }
    if (token === "--") {
      if (forward) {
        // Everything after the first delimiter belongs to the forward input, unparsed.
        forwarded = tokens.slice(i + 1);
        break;
      }
      literal = true;
      continue;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = token.slice(2, eq === -1 ? undefined : eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      if (name === "help" || name === "human") {
        if (inline !== undefined) return fail(`--${name} does not take a value`, { input: token });
        if (name === "help") help = true;
        else human = true;
        continue;
      }
      const option: OptionDecl | undefined = Object.hasOwn(options, name) ? options[name] : undefined;
      if (option === undefined) return unknownOption(`--${name}`, options, humanFlag);
      if (option.type === "boolean") {
        if (inline !== undefined) return fail(`--${name} does not take a value`, { input: token });
        if (has(name)) return fail(`--${name} was given more than once`, { input: `--${name}` });
        set(name, true);
        supplied.add(name);
        continue;
      }
      let raw = inline;
      if (raw === undefined) {
        raw = tokens[i + 1];
        if (raw === undefined) {
          return fail(`Missing value: --${name}`, { input: `--${name}`, expected: describeValue(option) });
        }
        // A value never starts like an option: the next token is not echoed (it may be a secret).
        if (isOptionShaped(raw)) {
          return fail(`Missing value: --${name}. To give a value that starts with "-", write --${name}=<value>`, {
            input: `--${name}`,
            expected: describeValue(option),
            hint: `--${name}=<value>`,
          });
        }
        i++;
      }
      const converted = convert(option, raw, `--${name}`);
      if (!converted.ok) return converted;
      supplied.add(name);
      if (option.repeat) {
        set(name, [...(has(name) ? (values[name] as unknown[]) : []), converted.value]);
      } else {
        if (has(name)) return fail(`--${name} was given more than once`, { input: `--${name}` });
        set(name, converted.value);
      }
      continue;
    }
    if (isOptionShaped(token)) {
      return unknownOption(token.split("=")[0]!, options, humanFlag);
    }
    rest.push(token);
  }

  let cursor = 0;
  for (const p of positionals) {
    if (p.variadic) {
      const taken = rest.slice(cursor);
      cursor = rest.length;
      const converted: unknown[] = [];
      for (const raw of taken) {
        const c = convert(p, raw, p.name);
        if (!c.ok) return c;
        converted.push(c.value);
      }
      if (converted.length > 0) supplied.add(p.name);
      else if (p.required) missingFault ??= missing(p);
      set(p.name, converted);
      continue;
    }
    const raw = rest[cursor];
    if (raw === undefined) {
      if (p.required) missingFault ??= missing(p);
      set(p.name, p.default);
      continue;
    }
    cursor++;
    const c = convert(p, raw, p.name);
    if (!c.ok) return c;
    supplied.add(p.name);
    set(p.name, c.value);
  }
  if (cursor < rest.length) {
    return fail(`Unexpected argument: ${rest[cursor]}`, {
      input: rest[cursor],
      expected: positionals.length === 0 ? "no positional arguments" : `at most ${positionals.length} positional arguments`,
      ...(forward ? { hint: `arguments for <${forward.name}> go after --` } : {}),
    });
  }
  if (forward) {
    if (forwarded !== undefined) supplied.add(forward.name);
    set(forward.name, [...(forwarded ?? [])]);
  }

  for (const [name, option] of Object.entries(options)) {
    if (has(name)) continue;
    if (option.type === "boolean") set(name, false);
    else if (option.repeat) {
      if (option.required) missingFault ??= missingOption(name, option);
      set(name, []);
    } else {
      if (option.required) missingFault ??= missingOption(name, option);
      set(name, option.default);
    }
  }

  return { ok: true, values, supplied, ...(missingFault ? { missing: missingFault } : {}), help, human };
}

function convert(d: PositionalDecl | OptionDecl, raw: string, input: string): { ok: true; value: string | number } | Rejected {
  if (d.type === "boolean") return { ok: true, value: raw };
  let value: string | number = raw;
  if (d.type === "number" || d.type === "integer") {
    const parsed = parseNumber(d.type, raw);
    if (parsed === undefined) {
      return fail(`Invalid value: ${input} ${raw}`, {
        input,
        received: raw,
        expected: describeValue(d),
        syntax: NUMBER_SYNTAX[d.type].name,
      });
    }
    value = parsed;
  }
  const problem = checkValue(d, value);
  if (problem !== undefined) {
    return fail(`Invalid value: ${input} ${raw}`, {
      input,
      received: raw,
      expected: describeValue(d),
      ...(d.values ? { allowed: d.values } : {}),
    });
  }
  const checked = checkScalar(d, value);
  if (checked.ok) return { ok: true, value };
  if (checked.defect) return { ok: false, defect: checked.defect };
  // The received value is not repeated: arguments that fail a constraint can be credentials.
  const rule = checked.rule === "pattern" ? { rule: "pattern", expected: d.pattern!.description } : { rule: "check", expected: d.check!.description };
  return fail(`Invalid value: ${input}`, { input, ...rule });
}

/** Reports an unknown option by name only; an inline value after = is never repeated because it can be a credential. */
function unknownOption(name: string, options: Readonly<Record<string, OptionDecl>>, human: boolean): Rejected {
  const allowed = [...Object.keys(options).map((o) => `--${o}`), "--help", ...(human ? ["--human"] : [])];
  const close = suggest(name, allowed);
  return fail(`Unknown option: ${name}`, { input: name, allowed, ...(close ? { suggestion: close } : {}) });
}

function missing(p: PositionalDecl): Fault {
  return { code: "INVALID_INPUT", message: `Missing argument: <${p.name}>`, details: { input: p.name, expected: describeValue(p) } };
}

function missingOption(name: string, option: OptionDecl): Fault {
  return {
    code: "INVALID_INPUT",
    message: `Missing option: --${name}`,
    details: { input: `--${name}`, expected: option.type === "boolean" ? "boolean" : describeValue(option) },
  };
}

function fail(message: string, details: Record<string, unknown>): { ok: false; fault: Fault } {
  return { ok: false, fault: { code: "INVALID_INPUT", message, details } };
}

function invalid(path: readonly string[], message: string, details: Record<string, unknown>): Invocation {
  return { kind: "invalid", path, fault: { code: "INVALID_INPUT", message, details } };
}
