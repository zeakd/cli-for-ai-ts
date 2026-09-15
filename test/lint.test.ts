import { expect, test } from "vitest";
import { application, applicationSchema, command, group, output } from "../src/index.ts";
import { lintSchema, lintSummary, type SchemaShape } from "../src/lint/index.ts";
import { completed } from "../src/core/result.ts";

const ok = () => completed(null);

test("a schema generated from declarations has no errors", () => {
  const app = application({
    name: "demo",
    version: "0.1.0",
    summary: "Demo",
    commands: {
      status: command({ summary: "Status", output: output({ summary: "state" }), run: ok }),
      note: group({ summary: "Notes", commands: { add: command({ summary: "Add", output: output(), run: ok }) } }),
    },
  });
  const findings = lintSchema(applicationSchema(app));
  expect(lintSummary(findings).ok).toBe(true);
  expect(findings).toContainEqual({ level: "warn", rule: "output-described", message: '"note add" does not describe its output' });
});

test("schemas produced elsewhere are checked for summaries and names", () => {
  const schema: SchemaShape = {
    name: "demo",
    version: "0.1.0",
    summary: "",
    commands: {
      Bad_Name: { kind: "command", summary: "x", output: { summary: "y" } },
      empty: { kind: "group", summary: "", commands: {} },
      list: { kind: "command", summary: "List", input: { options: { tag: { summary: " " } } }, output: { summary: "z" } },
    },
  };
  const findings = lintSchema(schema);
  expect(findings.map((f) => f.rule).sort()).toEqual(
    ["group-not-empty", "name-shape", "summary-present", "summary-present", "summary-present"].sort(),
  );
  expect(lintSummary(findings)).toEqual({ errors: 4, warnings: 1, ok: false });
});
