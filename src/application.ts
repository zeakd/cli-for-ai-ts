// Composition: bind independent commands and groups into one application tree.

import { AuthoringError, isDeclared, treeIssues, type ContextOf, type Tree } from "./core/command.ts";
import { exampleArgv } from "./core/examples.ts";
import { isValidName } from "./core/input.ts";
import { snapshot } from "./core/snapshot.ts";
import type { Application, ApplicationSpec } from "./core/parse.ts";

declare const CONTEXT_CONFLICT: unique symbol;

type ConflictingKeys<C> = { [K in keyof C]-?: [C[K]] extends [never] ? K : never }[keyof C];

/** Rejects, at compile time, trees whose commands need contexts no value can satisfy. */
export type ContextCheck<T extends Tree> = [ContextOf<T>] extends [never]
  ? { readonly [CONTEXT_CONFLICT]: "mounted commands require incompatible contexts" }
  : [ConflictingKeys<ContextOf<T>>] extends [never]
    ? unknown
    : { readonly [CONTEXT_CONFLICT]: `mounted commands require incompatible types for context.${ConflictingKeys<ContextOf<T>> & string}` };

export function application<const T extends Tree>(spec: ApplicationSpec<T> & ContextCheck<T>): Application<ContextOf<T>, T> {
  const copied = snapshot(spec, "application", isDeclared);
  if (!copied.ok) throw new AuthoringError("application", [copied.issue]);
  const s = copied.value as ApplicationSpec<T> & Record<string, unknown>;
  const issues: string[] = [];
  for (const key of Reflect.ownKeys(s)) if (typeof key !== "string" || !["name", "version", "summary", "description", "commands"].includes(key)) issues.push(`unknown key "${String(key)}"`);
  if (typeof s.name !== "string" || !isValidName(s.name)) issues.push("name must be lowercase kebab-case");
  if (typeof s.version !== "string" || !s.version.trim()) issues.push("version is required");
  if (typeof s.summary !== "string" || !s.summary.trim()) issues.push("summary is required");
  if (s.description !== undefined && typeof s.description !== "string") issues.push("description must be a string");
  issues.push(...treeIssues(s.commands));
  if (issues.length === 0) issues.push(...exampleIssues([], s.commands));
  if (issues.length > 0) throw new AuthoringError(`application "${typeof s.name === "string" ? s.name : "(no name)"}"`, issues);

  return Object.freeze({ kind: "application", spec: s, commands: s.commands }) as unknown as Application<ContextOf<T>, T>;
}

function exampleIssues(path: readonly string[], tree: Tree): string[] {
  const issues: string[] = [];
  for (const [name, node] of Object.entries(tree)) {
    const here = [...path, name];
    if (node.kind === "group") {
      issues.push(...exampleIssues(here, node.spec.commands));
      continue;
    }
    for (const example of node.spec.examples ?? []) {
      const label = `example "${example.summary}" of "${here.join(" ")}"`;
      const generated = exampleArgv(node.spec, example.input);
      if (!generated.ok) issues.push(`${label} is invalid: ${generated.reason}`);
    }
  }
  return issues;
}
