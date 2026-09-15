// Examples are written as input values. Their argv is generated from the input
// declaration, then parsed back to prove the invocation means what was written.

import type { InputDecl, OptionDecl, PositionalDecl } from "./input.ts";
import { applyConstraints, isOptionShaped, parseInput } from "./parse.ts";

export type ExampleArgv = { ok: true; argv: string[]; values: Record<string, unknown> } | { ok: false; reason: string };

/** spec is the command declaration; its argument constraints apply to examples as to any invocation. */
export function exampleArgv(spec: { readonly input?: InputDecl }, input: unknown): ExampleArgv {
  const decl = spec.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, reason: "input must be an object" };
  const given = input as Record<string, unknown>;
  const valueOf = (key: string) => (Object.hasOwn(given, key) ? given[key] : undefined);
  const positionals: readonly PositionalDecl[] = decl?.positionals ?? [];
  const options = (decl?.options ?? {}) as Readonly<Record<string, OptionDecl>>;
  const forward = decl?.forward;

  for (const key of Reflect.ownKeys(given)) {
    if (typeof key !== "string") return { ok: false, reason: "input has a symbol key" };
    if (key === "stdin") return { ok: false, reason: "stdin cannot be given as an argument" };
    if (!positionals.some((p) => p.name === key) && !Object.hasOwn(options, key) && forward?.name !== key) return { ok: false, reason: `unknown input "${key}"` };
  }

  const optionTokens: string[] = [];
  for (const [name, option] of Object.entries(options)) {
    const value = valueOf(name);
    if (value === undefined) continue;
    if (option.type === "boolean") {
      if (typeof value !== "boolean") return { ok: false, reason: `--${name} must be a boolean` };
      if (value) optionTokens.push(`--${name}`);
      continue;
    }
    const items = option.repeat ? value : [value];
    if (!Array.isArray(items)) return { ok: false, reason: `--${name} must be an array` };
    for (const item of items) {
      if (typeof item !== "string" && typeof item !== "number") return { ok: false, reason: `--${name} must be a string or number` };
      // A value that starts like an option is only unambiguous in inline form.
      const token = String(item);
      if (isOptionShaped(token)) optionTokens.push(`--${name}=${token}`);
      else optionTokens.push(`--${name}`, token);
    }
  }

  const positionalTokens: string[] = [];
  let omitted: string | undefined;
  for (const p of positionals) {
    const value = valueOf(p.name);
    if (value === undefined) {
      omitted ??= p.name;
      continue;
    }
    if (omitted !== undefined) return { ok: false, reason: `<${p.name}> is given after omitted <${omitted}>` };
    const items = p.variadic ? value : [value];
    if (!Array.isArray(items)) return { ok: false, reason: `<${p.name}> must be an array` };
    for (const item of items) {
      if (typeof item !== "string" && typeof item !== "number") return { ok: false, reason: `<${p.name}> must be a string or number` };
      positionalTokens.push(String(item));
    }
  }

  const forwardTokens: string[] = [];
  if (forward) {
    const tail = valueOf(forward.name);
    if (tail !== undefined) {
      if (!Array.isArray(tail) || tail.some((t) => typeof t !== "string")) return { ok: false, reason: `<${forward.name}> must be an array of strings` };
      forwardTokens.push("--", ...(tail as string[]));
    }
  }

  // Positional values that look like options must follow the -- boundary, which a forward input owns.
  const literal = positionalTokens.some(isOptionShaped);
  if (literal && forward) return { ok: false, reason: `a positional value starting with "-" cannot be written before <${forward.name}>` };
  const argv = literal ? [...optionTokens, "--", ...positionalTokens] : [...positionalTokens, ...optionTokens, ...forwardTokens];

  const parsed = parseInput(decl, argv);
  if (!parsed.ok) return { ok: false, reason: parsed.defect ? parsed.defect.message : parsed.fault.message };
  if (parsed.missing) return { ok: false, reason: parsed.missing.message };
  const ruled = applyConstraints(spec, parsed.values, parsed.supplied);
  if (!ruled.ok) return { ok: false, reason: ruled.defect ? ruled.defect.message : ruled.fault.message };
  for (const [key, value] of Object.entries(given)) {
    if (!Object.hasOwn(parsed.values, key) || JSON.stringify(parsed.values[key]) !== JSON.stringify(value)) {
      return { ok: false, reason: `"${key}" does not survive parsing: generated ${JSON.stringify(parsed.values[key])}` };
    }
  }
  return { ok: true, argv, values: parsed.values };
}
