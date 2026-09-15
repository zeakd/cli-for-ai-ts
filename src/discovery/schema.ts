// Structured description of the mounted tree, derived from declarations.

import { constraintsOf, type AnyCommand, type Group, type OutputDecl, type Tree } from "../core/command.ts";
import { isPayload, type PayloadDecl } from "../core/payload.ts";
import { NUMBER_SYNTAX, type OptionDecl, type PositionalDecl } from "../core/input.ts";
import type { ApplicationView } from "../core/parse.ts";
import { exampleInvocation, usage } from "./help.ts";

export interface ValueSchema {
  type: "string" | "number" | "integer" | "boolean";
  summary: string;
  required: boolean;
  values?: readonly string[];
  min?: number;
  max?: number;
  default?: string | number;
  variadic?: boolean;
  repeat?: boolean;
  /** Accepted spelling of numeric arguments: "json-number" or "decimal-integer". */
  syntax?: string;
  /** A JavaScript regular expression (u flag) that must match the whole value. Not a JSON Schema pattern. */
  pattern?: { regex: string; flags: "u"; match: "whole-value"; description: string };
  /** A custom check: only its description is machine-readable. */
  check?: { description: string; custom: true };
}

export interface ConstraintSchema {
  /** Inputs the rule reads. On help it runs only when all of them are given. */
  inputs: string[];
  description: string;
  custom: true;
}

/** A command's schema: exactly one of output (an ordinary JSON result) or payload. Narrow with "payload" in schema. */
export type CommandSchema = OrdinaryCommandSchema | PayloadCommandSchema;

interface CommandSchemaBase {
  kind: "command";
  summary: string;
  description?: string;
  usage: string;
  input: {
    positionals: (ValueSchema & { name: string })[];
    options: Record<string, ValueSchema>;
    /** Arguments after `--`, passed through unchanged as a string array. */
    forward?: { name: string; summary: string };
    /** when: stdin is read only when that argument strictly equals the value; absent means every run. */
    stdin?: { format: "text" | "json"; summary: string; shape?: { description: string; custom: true }; when?: { input: string; equals: string | number | boolean } };
    constraints: ConstraintSchema[];
  };
  examples: { summary: string; invocation: string }[];
}

export interface OrdinaryCommandSchema extends CommandSchemaBase {
  /** The ordinary JSON result. */
  output: { summary?: string; schema?: Readonly<Record<string, unknown>>; fields?: { path: string; summary: string }[] };
  payload?: never;
}

export interface PayloadCommandSchema extends CommandSchemaBase {
  /** The declared payload. Field descriptions are metadata, not checked against records. */
  payload: PayloadSchema;
  output?: never;
}

export interface PayloadSchema {
  readerClose: "require-full" | "allow";
  format: "jsonl" | "text";
  encoding: "utf-8";
  summary?: string;
  /** jsonl: record-relative field descriptions. */
  fields?: { path: string; summary: string }[];
  /** text: what one record is. */
  records?: string;
  /** text: "lf", "nul", or LF by default and NUL when the named boolean option is given. */
  framing?: "lf" | "nul" | { default: "lf"; nul: string };
  /** Largest accepted encoded record in bytes, separator included. */
  maxRecordBytes: number;
}

export interface GroupSchema {
  kind: "group";
  summary: string;
  description?: string;
  commands: Record<string, CommandSchema | GroupSchema>;
}

export interface ApplicationSchema {
  name: string;
  version: string;
  summary: string;
  description?: string;
  /** Options provided by the framework; scope says where each one is accepted. */
  globalOptions: Record<string, GlobalOptionSchema>;
  commands: Record<string, CommandSchema | GroupSchema>;
}

/**
 * Where a framework option is accepted: "all" (application, groups, commands),
 * "ordinary-commands" (commands with a JSON result; payload commands reject it)
 * or "root" (the application only).
 */
export type OptionScope = "all" | "ordinary-commands" | "root";

export interface GlobalOptionSchema {
  summary: string;
  scope: OptionScope;
}

export const GLOBAL_OPTIONS = {
  help: { summary: "Show help for the application, a group or a command", scope: "all" },
  human: { summary: "Present an ordinary JSON result for people; payload commands reject it", scope: "ordinary-commands" },
  version: { summary: "Print the application name and version (application root only)", scope: "root" },
} as const satisfies Record<string, GlobalOptionSchema>;

export function applicationSchema(app: ApplicationView): ApplicationSchema {
  return {
    name: app.spec.name,
    version: app.spec.version,
    summary: app.spec.summary,
    ...(app.spec.description ? { description: app.spec.description } : {}),
    globalOptions: { ...GLOBAL_OPTIONS },
    commands: treeSchema(app, [], app.commands),
  };
}

function treeSchema(app: ApplicationView, path: readonly string[], tree: Tree): Record<string, CommandSchema | GroupSchema> {
  const out: Record<string, CommandSchema | GroupSchema> = {};
  for (const [name, node] of Object.entries(tree)) {
    out[name] = nodeSchema(app, [...path, name], node);
  }
  return out;
}

export function nodeSchema(app: ApplicationView, path: readonly string[], node: AnyCommand | Group): CommandSchema | GroupSchema {
  if (node.kind === "group") {
    return {
      kind: "group",
      summary: node.spec.summary,
      ...(node.spec.description ? { description: node.spec.description } : {}),
      commands: treeSchema(app, path, node.spec.commands),
    };
  }
  const spec = node.spec;
  const invocation = [app.spec.name, ...path].join(" ");
  return {
    kind: "command",
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    usage: usage(app, path, node),
    input: {
      positionals: (spec.input?.positionals ?? []).map((p: PositionalDecl) => ({ name: p.name, ...valueSchema(p) })),
      options: Object.fromEntries(
        Object.entries((spec.input?.options ?? {}) as Record<string, OptionDecl>).map(([k, o]) => [k, valueSchema(o)]),
      ),
      ...(spec.input?.forward ? { forward: { name: spec.input.forward.name, summary: spec.input.forward.summary } } : {}),
      ...(spec.input?.stdin
        ? {
            stdin: {
              format: spec.input.stdin.format,
              summary: spec.input.stdin.summary,
              ...(spec.input.stdin.shape ? { shape: { description: spec.input.stdin.shape.description, custom: true as const } } : {}),
              ...(spec.input.stdin.when ? { when: { input: spec.input.stdin.when.input, equals: spec.input.stdin.when.equals } } : {}),
            },
          }
        : {}),
      constraints: constraintsOf(spec).map((c) => ({ inputs: [...c.inputs], description: c.description, custom: true as const })),
    },
    ...outputSchema(spec.output),
    examples: (spec.examples ?? []).map((e) => ({ summary: e.summary, invocation: exampleInvocation(invocation, spec, e.input) })),
  };
}

function outputSchema(declared: OutputDecl<unknown> | PayloadDecl): Pick<OrdinaryCommandSchema, "output"> | Pick<PayloadCommandSchema, "payload"> {
  if (isPayload(declared)) {
    return {
      payload: {
        format: declared.format,
        readerClose: declared.readerClose,
        encoding: "utf-8",
        ...(declared.summary ? { summary: declared.summary } : {}),
        ...(declared.format === "jsonl" && declared.fields?.length ? { fields: declared.fields.map((f) => ({ path: f.path, summary: f.summary })) } : {}),
        ...(declared.format === "text"
          ? { records: declared.records, framing: typeof declared.framing === "string" ? declared.framing : { default: "lf" as const, nul: declared.framing.nul } }
          : {}),
        maxRecordBytes: declared.maxRecordBytes,
      },
    };
  }
  const output = declared as OutputDecl<unknown>;
  return {
    output: {
      ...(output.summary ? { summary: output.summary } : {}),
      ...(output.schema ? { schema: output.schema } : {}),
      ...(output.fields?.length ? { fields: output.fields.map((f) => ({ path: f.path, summary: f.summary })) } : {}),
    },
  };
}

function valueSchema(d: PositionalDecl | OptionDecl): ValueSchema {
  if (d.type === "boolean") return { type: "boolean", summary: d.summary, required: false };
  return {
    type: d.type ?? "string",
    summary: d.summary,
    required: d.required === true,
    ...(d.values ? { values: d.values } : {}),
    ...(d.min !== undefined ? { min: d.min } : {}),
    ...(d.max !== undefined ? { max: d.max } : {}),
    ...(d.default !== undefined ? { default: d.default } : {}),
    ...(d.type === "number" || d.type === "integer" ? { syntax: NUMBER_SYNTAX[d.type].name } : {}),
    ...("variadic" in d && d.variadic ? { variadic: true } : {}),
    ...("repeat" in d && d.repeat ? { repeat: true } : {}),
    ...(d.pattern ? { pattern: { regex: d.pattern.regex, flags: "u" as const, match: "whole-value" as const, description: d.pattern.description } } : {}),
    ...(d.check ? { check: { description: d.check.description, custom: true as const } } : {}),
  };
}
