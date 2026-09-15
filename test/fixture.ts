import { application, authoring, completed, failed, group, output } from "../src/index.ts";

export interface Ctx {
  greeting: string;
  calls: string[];
}

const { command } = authoring<Ctx>();

export const echo = command({
  summary: "Echo input",
  input: {
    positionals: [
      { name: "first", summary: "First word", required: true },
      { name: "rest", summary: "Other words", variadic: true },
    ],
    options: {
      count: { summary: "Repeat count", type: "integer", min: 1, max: 3, default: 1 },
      ratio: { summary: "A ratio", type: "number" },
      format: { summary: "Output format", values: ["json", "csv"] },
      tag: { summary: "Tag", repeat: true },
      title: { summary: "Title" },
      loud: { summary: "Uppercase", type: "boolean" },
    },
  },
  output: output<{ words: string[]; count: number; greeting: string; input: Record<string, unknown> }>({ summary: "Echoed words" }),
  examples: [
    { summary: "Echo twice", input: { first: "hi", count: 2 } },
    { summary: "Words that look like options", input: { first: "-x", rest: ["two words"], tag: ["a", "b"], loud: true } },
  ],
  run: (input, ctx) => {
    ctx.calls.push("echo");
    return completed({ words: [input.first, ...input.rest], count: input.count, greeting: ctx.greeting, input });
  },
  human: (data) => data.words.join(" "),
});

export const submit = command({
  summary: "Submit a job",
  input: { positionals: [{ name: "job", summary: "Job name", required: true }] },
  output: output<{ id: string }>(),
  run: (input) => completed({ id: `job-${input.job}` }),
  result: () => ({ status: "accepted" }),
});

export const fail = command({
  summary: "Always fails",
  output: output<never>(),
  run: async () => failed({ code: "NOPE", message: "It failed", details: { reason: "test" } }),
});

export const read = command({
  summary: "Read JSON from stdin",
  input: { stdin: { format: "json", summary: "Any JSON" } },
  output: output<{ received: unknown }>(),
  run: (input, ctx) => {
    ctx.calls.push("read");
    return completed({ received: input.stdin });
  },
});

export const app = application({
  name: "tool",
  version: "1.2.3",
  summary: "A test tool",
  commands: {
    echo,
    jobs: group({ summary: "Jobs", commands: { submit, deep: group({ summary: "Deeper", commands: { fail } }) } }),
    read,
  },
});
