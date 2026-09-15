// Lint rules — pure functions over the JSON applicationSchema() generates for
// a cli-for-ai application. Declarations already reject missing summaries and
// malformed names at authoring time; these rules also cover schemas produced
// elsewhere and flag weaker descriptions as warnings.

export interface SchemaValueShape {
  summary: string;
}

export interface SchemaCommandShape {
  kind: "command";
  summary: string;
  input?: { positionals?: (SchemaValueShape & { name: string })[]; options?: Record<string, SchemaValueShape>; forward?: { name: string; summary?: string } };
  output?: { summary?: string };
  payload?: { summary?: string };
}

export interface SchemaGroupShape {
  kind: "group";
  summary: string;
  commands: Record<string, SchemaCommandShape | SchemaGroupShape>;
}

export interface SchemaShape {
  name: string;
  version: string;
  summary: string;
  commands: Record<string, SchemaCommandShape | SchemaGroupShape>;
}

export interface Finding {
  level: "error" | "warn";
  rule: string;
  message: string;
}

const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function lintSchema(schema: SchemaShape): Finding[] {
  const findings: Finding[] = [];
  const add = (level: Finding["level"], rule: string, message: string) => findings.push({ level, rule, message });

  if (!schema.summary?.trim()) add("error", "summary-present", `application "${schema.name}" has no summary`);

  const visit = (path: readonly string[], nodes: SchemaShape["commands"]) => {
    for (const [name, node] of Object.entries(nodes)) {
      const here = [...path, name];
      const label = here.join(" ");
      if (!NAME_RE.test(name)) add("warn", "name-shape", `"${label}" is not lowercase kebab-case`);
      if (!node.summary?.trim()) add("error", "summary-present", `"${label}" has no summary`);
      if (node.kind === "group") {
        if (Object.keys(node.commands).length === 0) add("error", "group-not-empty", `group "${label}" has no commands`);
        visit(here, node.commands);
        continue;
      }
      for (const p of node.input?.positionals ?? []) {
        if (!p.summary?.trim()) add("error", "summary-present", `argument <${p.name}> of "${label}" has no summary`);
      }
      for (const [option, decl] of Object.entries(node.input?.options ?? {})) {
        if (!decl.summary?.trim()) add("error", "summary-present", `option --${option} of "${label}" has no summary`);
      }
      const forward = node.input?.forward;
      if (forward && !forward.summary?.trim()) add("error", "summary-present", `forwarded arguments <${forward.name}> of "${label}" have no summary`);
      if (!(node.payload ? node.payload.summary : node.output?.summary)?.trim()) {
        add("warn", "output-described", `"${label}" does not describe its ${node.payload ? "payload" : "output"}`);
      }
    }
  };
  visit([], schema.commands);
  return findings;
}

export function lintSummary(findings: Finding[]): { errors: number; warnings: number; ok: boolean } {
  const errors = findings.filter((f) => f.level === "error").length;
  const warnings = findings.filter((f) => f.level === "warn").length;
  return { errors, warnings, ok: errors === 0 };
}
