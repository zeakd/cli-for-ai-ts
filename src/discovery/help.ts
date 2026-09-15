// Help text, derived from declarations. Usage lines are runnable invocations
// that carry the application name.

import { constraintsOf, type AnyCommand, type Group, type OutputDecl } from "../core/command.ts";
import { isPayload, type PayloadDecl } from "../core/payload.ts";
import { GLOBAL_OPTIONS } from "./schema.ts";
import { exampleArgv } from "../core/examples.ts";
import { describeValue, NUMBER_SYNTAX, type InputDecl, type StdinDecl, type OptionDecl, type PositionalDecl } from "../core/input.ts";
import type { ApplicationView, Node } from "../core/parse.ts";

export function renderHelp(app: ApplicationView, path: readonly string[], node: Node): string {
  const invocation = [app.spec.name, ...path].join(" ");
  if (node.kind === "command") return commandHelp(app, path, node);

  const spec = node.spec;
  const lines: string[] = [];
  lines.push(node.kind === "application" ? `${app.spec.name} ${app.spec.version} — ${spec.summary}` : `${invocation} — ${spec.summary}`);
  if (spec.description) lines.push("", spec.description);
  lines.push("", "Usage:", `  ${invocation} <command> [options]`);
  lines.push("", "Commands:");
  const children = node.kind === "application" ? node.commands : node.spec.commands;
  const rows = Object.entries(children).map(([name, child]) => [
    child.kind === "group" ? `${name} <command>` : name,
    child.spec.summary,
  ] as const);
  lines.push(...table(rows));
  lines.push("", "Options:");
  const options: [string, string][] = [
    ["--help", "Show this help (also accepted after any command)"],
    ["--human", GLOBAL_OPTIONS.human.summary],
  ];
  if (node.kind === "application") options.push(["--version", "Print the name and version"]);
  lines.push(...table(options));
  if (node.kind === "application") {
    lines.push(
      "",
      "Results:",
      "  By default, successful results go to stdout; failures and diagnostics go to stderr:",
      ...table([
        ['{"status":"completed","data":...}', "stdout: the work is done"],
        ['{"status":"accepted","data":...}', "stdout: the work was submitted and is not complete yet"],
        ['{"status":"failed","error":{"code","message","details"?}}', "stderr: an error was reported; work may already have happened"],
      ]).map((line) => `  ${line}`),
      "  Commands that declare a payload print only that payload on stdout and report errors on stderr.",
      "  Exit codes:",
      ...table([
        ["0", "completed or accepted; payload completion follows its declared reader-close policy"],
        ["1", "failed"],
        ["2", "invalid input"],
        ["70", "internal error, a result that could not be reported, or failed output delivery"],
        ["130", "interrupted; work already done is not undone"],
      ]).map((line) => `  ${line}`),
      "  Check state before retrying; an error does not undo work.",
    );
  }
  lines.push("", `Run \`${invocation} <command> --help\` for a command's input and output.`);
  if (node.kind !== "application") lines.push(rootReference(app));
  return lines.join("\n") + "\n";
}

function commandHelp(app: ApplicationView, path: readonly string[], node: AnyCommand): string {
  const spec = node.spec;
  const invocation = [app.spec.name, ...path].join(" ");
  const lines: string[] = [`${invocation} — ${spec.summary}`];
  if (spec.description) lines.push("", spec.description);
  lines.push("", "Usage:", `  ${usage(app, path, node)}`);

  const positionals: readonly PositionalDecl[] = spec.input?.positionals ?? [];
  const forward = spec.input?.forward;
  if (positionals.length > 0 || forward) {
    lines.push("", "Arguments:");
    lines.push(
      ...table([
        ...positionals.map((p) => [positionalToken(p), `${p.summary} (${valueNotes(p)})`] as const),
        ...(forward ? ([[forwardToken(forward), `${forward.summary} (every argument after -- is passed through unchanged)`]] as const) : []),
      ]),
    );
    if (forward && positionals.length > 0) {
      lines.push(`  Arguments before -- cannot start with "-" (except "-" and negative numbers).`);
    }
  }

  const options = Object.entries((spec.input?.options ?? {}) as Record<string, OptionDecl>);
  lines.push("", "Options:");
  lines.push(
    ...table([
      ...options.map(([name, o]) => [optionToken(name, o), o.type === "boolean" ? o.summary : `${o.summary} (${valueNotes(o)})`] as const),
      ...(payloadOf(spec) ? [] : ([["--human", "Present the result for people instead of JSON"]] as const)),
      ["--help", "Show this help"],
    ]),
  );

  const rules = constraintsOf(spec);
  if (rules.length > 0) {
    lines.push("", "Constraints:");
    for (const rule of rules) lines.push(`  ${rule.description} (reads ${rule.inputs.join(", ")}; checked on --help only when all are given)`);
  }

  if (spec.input?.stdin) {
    lines.push("", "Stdin:", `  ${spec.input.stdin.format}, ${stdinWhen(spec.input.stdin, spec.input)} — ${spec.input.stdin.summary}`);
    if (spec.input.stdin.shape) lines.push(`  must be: ${spec.input.stdin.shape.description} (custom check, not checked by --help)`);
  }

  const declared = payloadOf(spec);
  if (declared) lines.push("", "Payload:", ...payloadLines(declared), `  ${rootReference(app)}`);
  else {
    const output = spec.output as OutputDecl<unknown>;
    lines.push("", "Output:");
    if (output.summary) lines.push(`  ${output.summary}`);
    if (output.fields?.length) lines.push(...table(output.fields.map((f) => [f.path, f.summary] as const)));
    lines.push("  Successful JSON on stdout; failures on stderr. Use --human for readable output.", `  ${rootReference(app)}`);
  }

  if (spec.examples?.length) {
    lines.push("", "Examples:");
    for (const e of spec.examples) lines.push(`  # ${e.summary}`, `  ${exampleInvocation(invocation, spec, e.input)}`);
  }
  return lines.join("\n") + "\n";
}

export function usage(app: ApplicationView, path: readonly string[], node: AnyCommand | Group): string {
  const parts = [app.spec.name, ...path];
  if (node.kind === "group") return [...parts, "<command>"].join(" ");
  const input = node.spec.input;
  for (const p of (input?.positionals ?? []) as readonly PositionalDecl[]) parts.push(positionalToken(p));
  for (const [name, o] of Object.entries((input?.options ?? {}) as Record<string, OptionDecl>)) {
    const token = optionToken(name, o);
    parts.push(o.type !== "boolean" && o.required ? token : `[${token}]`);
  }
  if (input?.forward) parts.push(`[${forwardToken(input.forward)}]`);
  return parts.join(" ");
}

function forwardToken(forward: { readonly name: string }): string {
  return `-- <${forward.name}>...`;
}

function positionalToken(p: PositionalDecl): string {
  const inner = `${p.name}${p.variadic ? "..." : ""}`;
  return p.required ? `<${inner}>` : `[${inner}]`;
}

function optionToken(name: string, o: OptionDecl): string {
  if (o.type === "boolean") return `--${name}`;
  return `--${name} <${describeValue(o)}>${o.repeat ? "..." : ""}`;
}

function valueNotes(d: PositionalDecl | Exclude<OptionDecl, { type: "boolean" }>): string {
  const notes = [describeValue(d), d.required ? "required" : "optional"];
  if (d.type === "number" || d.type === "integer") notes.push(NUMBER_SYNTAX[d.type].name);
  if (d.default !== undefined) notes.push(`default ${d.default}`);
  if ("repeat" in d && d.repeat) notes.push("repeatable");
  if ("variadic" in d && d.variadic) notes.push("variadic");
  if (d.pattern) notes.push(`must match /${d.pattern.regex}/u as a whole: ${d.pattern.description}`);
  if (d.check) notes.push(`must be: ${d.check.description}`);
  return notes.join(", ");
}

/** When stdin is read, naming the argument as it is written on the command line and the value in JSON. */
function stdinWhen(stdin: StdinDecl, input: InputDecl): string {
  const when = stdin.when;
  if (!when) return "read on every run";
  const option = (input.options ?? {})[when.input];
  if (option && Object.hasOwn(input.options ?? {}, when.input)) {
    if (option.type === "boolean") return `read only when --${when.input} is ${when.equals ? "given" : "not given"}`;
    return `read only when --${when.input} is ${JSON.stringify(when.equals)}`;
  }
  const positional = (input.positionals ?? []).find((p) => p.name === when.input);
  return `read only when ${positional ? positionalToken(positional) : `<${when.input}>`} is ${JSON.stringify(when.equals)}`;
}

function payloadOf(spec: AnyCommand["spec"]): PayloadDecl | undefined {
  return isPayload(spec.output) ? spec.output : undefined;
}

function payloadLines(declared: PayloadDecl): string[] {
  const lines: string[] = [];
  if (declared.summary) lines.push(`  ${declared.summary}`);
  if (declared.format === "jsonl") {
    lines.push("  UTF-8 JSON Lines: one JSON object per line; line breaks inside values are escaped.");
    if (declared.fields?.length) lines.push("  Record fields:", ...table(declared.fields.map((f) => [f.path, f.summary] as const)).map((l) => `  ${l}`));
  } else {
    const framing = declared.framing;
    const separator =
      framing === "lf" ? "a line feed (LF)" : framing === "nul" ? "a NUL byte" : `a line feed (LF), or a NUL byte with --${framing.nul}`;
    lines.push(`  UTF-8 text: ${declared.records}, each followed by ${separator}. Records are not escaped.`);
  }
  lines.push(
    `  Largest record: ${declared.maxRecordBytes} bytes including its separator; a larger record stops the payload.`,
    "  stdout contains only the payload. Errors go to stderr as one JSON report; diagnostic-prefixed lines may precede or follow it.",
    "  A failed run can leave a partial payload, possibly ending inside a record.",
    ...(declared.readerClose === "allow" ? [
      "  Reader close: allow. Exit 0 may mean an early stop after cleanup, not complete output.",
      "  Reader intent and consumption are unknown; check the receiver's exit status too.",
    ] : [
      "  Reader close: require-full. Exit 0 means all selected records were written and cleanup succeeded.",
      "  If the reader closes early (for example a pipe into head), the command stops and exits 70.",
    ]),
  );
  return lines;
}

/** Points to the root help, which holds result states and exit codes; valid at any mount depth. */
function rootReference(app: ApplicationView): string {
  return `For result states and exit codes, run \`${app.spec.name} --help\`.`;
}

function table(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

/** Quotes an argument for a POSIX shell when needed. */
export function quote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The invocation for an example at a mounted path. Examples are validated when the application is built. */
export function exampleInvocation(invocation: string, spec: { readonly input?: InputDecl }, values: unknown): string {
  const generated = exampleArgv(spec, values);
  if (!generated.ok) throw new Error(`invalid example: ${generated.reason}`);
  return [invocation, ...generated.argv.map(quote)].join(" ");
}
