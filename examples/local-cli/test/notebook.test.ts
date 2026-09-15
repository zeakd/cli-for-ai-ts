import { resultJson } from "../../../test/support/result-json.ts";
import { applicationSchema, execute, type CommandSchema, type GroupSchema } from "cli-for-ai";
import { expect, test } from "vitest";
import { notebook } from "../src/app.ts";
import { createContext, memoryDocuments } from "../src/context.ts";

// In-process: the application with an in-memory store and a fixed clock.
function setup() {
  const documents = memoryDocuments();
  const ctx = createContext(documents, () => new Date("2026-09-13T00:00:00Z"));
  const contexts = { created: 0 };
  const call = async (argv: string[], stdin = "") => {
    const r = await execute(notebook, argv, {
      context: () => {
        contexts.created++;
        return ctx;
      },
      readStdin: async () => stdin,
    });
    return { ...r, json: r.exitCode !== 0 || r.stdout.startsWith("{") ? resultJson(r) : undefined };
  };
  return { documents, call, contexts };
}

test("add, list, show and remove across a mixed-depth tree", async () => {
  const { call, documents } = setup();
  expect((await call(["note", "add", "buy milk", "--tag", "home", "--tag", "errand"])).json).toEqual({
    status: "completed",
    data: { id: 1, text: "buy milk", tags: ["home", "errand"], createdAt: "2026-09-13T00:00:00.000Z" },
  });
  await call(["note", "add", "write report"]);
  expect((await call(["status"])).json).toEqual({ status: "completed", data: { notes: 2 } });
  expect((await call(["note", "list", "--tag", "home"])).json.data).toMatchObject({ returned: 1, total: 1 });
  expect((await call(["note", "list", "--limit", "1"])).json.data).toMatchObject({ notes: [{ id: 2 }], returned: 1, total: 2 });
  expect((await call(["note", "show", "2", "--human"])).stdout).toBe("#2  write report\n");
  expect((await call(["note", "remove", "1", "2"])).json).toEqual({ status: "completed", data: { removed: [1, 2] } });
  expect(documents.data.notes).toEqual([]);
});

test("domain failures are values with nonzero exit and no partial removal", async () => {
  const { call, documents } = setup();
  await call(["note", "add", "keep me"]);
  const missing = await call(["note", "show", "9"]);
  expect(missing.exitCode).toBe(1);
  expect(missing.json.error).toEqual({ code: "NOTE_NOT_FOUND", message: "No note with id 9", details: { id: 9 } });

  const partial = await call(["note", "remove", "1", "7"]);
  expect(partial.exitCode).toBe(1);
  expect(partial.json.error).toMatchObject({ code: "NOTE_NOT_FOUND", details: { missing: [7] } });
  expect((documents.data.notes as unknown[]).length).toBe(1);
});

test("config group and enum keys", async () => {
  const { call } = setup();
  expect((await call(["config", "get", "default-tag"])).json.data).toEqual({ key: "default-tag", value: null });
  await call(["config", "set", "default-tag", "work"]);
  expect((await call(["config", "get", "default-tag", "--human"])).stdout).toBe("default-tag = work\n");
  const bad = await call(["config", "get", "colour"]);
  expect(bad.exitCode).toBe(2);
  expect(bad.json.error.details).toMatchObject({ allowed: ["default-tag"] });
});

function countWrites(documents: ReturnType<typeof memoryDocuments>) {
  const writes: string[] = [];
  const original = documents.write;
  documents.write = async (name, value) => {
    writes.push(name);
    return original(name, value);
  };
  return writes;
}

test("default-tag applies only when no --tag is given; explicit tags replace it", async () => {
  const { call } = setup();
  expect((await call(["note", "add", "untagged"])).json.data.tags).toEqual([]);
  await call(["config", "set", "default-tag", "work items"]);
  expect((await call(["note", "add", "defaulted"])).json.data.tags).toEqual(["work items"]);
  expect((await call(["note", "add", "explicit", "--tag", "home", "--tag", "two words"])).json.data.tags).toEqual(["home", "two words"]);
});

test.each([
  [["note", "add", "x", "--tag", ""]],
  [["note", "add", "x", "--tag", "ok", "--tag", "   "]],
  [["config", "set", "default-tag", ""]],
  [["config", "set", "default-tag", " \t "]],
])("%j breaks the tag rule: exit 2 before any write", async (argv) => {
  const { call, documents } = setup();
  const writes = countWrites(documents);
  const r = await call(argv);
  expect(r.exitCode).toBe(2);
  expect(r.json.error).toMatchObject({ code: "INVALID_INPUT", details: { expected: "tags must not be empty or only whitespace" } });
  expect(writes).toEqual([]);
});

test("an invalid stored default-tag is a configuration failure, not an argument error", async () => {
  const { call, documents } = setup();
  documents.data.settings = { "default-tag": "  " };
  const writes = countWrites(documents);
  const add = await call(["note", "add", "x"]);
  expect(add.exitCode).toBe(1);
  expect(add.json.error).toMatchObject({ code: "INVALID_CONFIGURATION", details: { key: "default-tag" } });
  expect(writes).toEqual([]);
  expect((await call(["note", "add", "x", "--tag", "fine"])).exitCode).toBe(0);
  expect((await call(["config", "get", "default-tag"])).json.error.code).toBe("INVALID_CONFIGURATION");
});

test("import validates stdin before adding anything", async () => {
  const { call, documents, contexts } = setup();
  const bad = await call(["note", "import"], '[{"text":"fine"},{"text": 1}]');
  expect(bad.exitCode).toBe(2);
  expect(bad.json.error).toMatchObject({ code: "INVALID_INPUT", details: { input: "stdin", reason: "item 1 needs a string text" } });
  expect(documents.data.notes).toBeUndefined();
  expect(contexts.created).toBe(0);
  const writes: string[] = [];
  const original = documents.write;
  documents.write = async (name, value) => {
    writes.push(name);
    return original(name, value);
  };
  const good = await call(["note", "import"], '[{"text":"a"},{"text":"b","tags":["x"]},{"text":"c"}]');
  expect(good.json.data.added.map((n: { id: number }) => n.id)).toEqual([1, 2, 3]);
  expect(writes).toEqual(["notes"]);
});

test("import applies the tag rule to every item before any write (re-review J)", async () => {
  const { call, documents, contexts } = setup();
  const writes = countWrites(documents);
  const r = await call(["note", "import"], '[{"text":"a","tags":["ok"]},{"text":"b","tags":["  "]}]');
  expect(r.exitCode).toBe(2);
  expect(r.json.error).toMatchObject({ code: "INVALID_INPUT", details: { input: "stdin", expected: expect.stringContaining("tags must not be empty or only whitespace") } });
  expect(r.stdout).not.toContain('"  "');
  expect(writes).toEqual([]);
  expect(contexts.created).toBe(0);
  expect(documents.data.notes).toBeUndefined();
  expect((await call(["note", "import"], '[{"text":"a","tags":["two words"]}]')).exitCode).toBe(0);
});

test.each([["a string", "x"], ["an array", ["work"]], ["a number", 3]])(
  "a settings document that is %s is invalid configuration and is never overwritten (re-review K)",
  async (_name, stored) => {
    const { call, documents } = setup();
    documents.data.settings = stored;
    const writes = countWrites(documents);
    for (const argv of [["config", "get", "default-tag"], ["config", "set", "default-tag", "work"], ["note", "add", "x"]]) {
      const r = await call(argv);
      expect(r.exitCode, argv.join(" ")).toBe(1);
      expect(r.json.error).toMatchObject({ code: "INVALID_CONFIGURATION", details: { document: "settings" } });
    }
    expect(writes).toEqual([]);
    expect(documents.data.settings).toEqual(stored);
  },
);

test("the tag rule is checked on --help for supplied tags and published in schema", async () => {
  const { call, contexts } = setup();
  expect((await call(["note", "add", "x", "--tag", "  ", "--help"])).exitCode).toBe(2);
  expect((await call(["config", "set", "default-tag", " ", "--help"])).exitCode).toBe(2);
  const note = applicationSchema(notebook).commands.note as GroupSchema;
  expect((note.commands.add as CommandSchema).input.options.tag!.check).toEqual({ description: "tags must not be empty or only whitespace", custom: true });
  expect(contexts.created).toBe(0);
});

test("note export streams stored notes as JSONL and describes itself as a payload", async () => {
  const { call, contexts } = setup();
  await call(["note", "add", "a", "--tag", "home"]);
  await call(["note", "add", "b\nc"]);
  const all = await execute(notebook, ["note", "export"], { context: () => createContext(memoryDocuments(), () => new Date(0)) });
  expect(all).toMatchObject({ exitCode: 0, stdout: "", payload: { recordsWritten: 0, complete: true } });
  const exported = await call(["note", "export", "--tag", "home"]);
  expect(exported.exitCode).toBe(0);
  expect(exported.stdout.trimEnd().split("\n").map((l) => JSON.parse(l).text)).toEqual(["a"]);
  const note = applicationSchema(notebook).commands.note as GroupSchema;
  expect((note.commands.export as CommandSchema).payload).toMatchObject({ format: "jsonl", fields: [{ path: "id", summary: "ID accepted by note show and note remove" }, { path: "text" }, { path: "tags[]" }, { path: "createdAt" }] });
  expect(contexts.created).toBeGreaterThan(0);
});
