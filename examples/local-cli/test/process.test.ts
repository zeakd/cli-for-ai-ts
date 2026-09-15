import { resultJson } from "../../../test/support/result-json.ts";
// Real processes: the example binary with an isolated NOTEBOOK_HOME.
// Requires the built package (pnpm test builds first).

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const bin = resolve(import.meta.dirname, "../src/cli.ts");
let sandbox: string;
let home: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "notebook-"));
  home = join(sandbox, "home");
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function notebook(argv: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<Result> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [bin, ...argv], {
      cwd: sandbox,
      env: { PATH: process.env.PATH ?? "", HOME: sandbox, NOTEBOOK_HOME: home, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code, signal) => done({ code, signal, stdout, stderr }));
    child.stdin.end(opts.stdin ?? "");
  });
}

describe("discovery", () => {
  test("bare app equals --help; bare group equals group --help; exit 0, stdout only", async () => {
    const [bare, help, group, groupHelp] = await Promise.all([
      notebook([]),
      notebook(["--help"]),
      notebook(["note"]),
      notebook(["note", "--help"]),
    ]);
    expect(bare).toEqual(help);
    expect(group).toEqual(groupHelp);
    expect(bare).toMatchObject({ code: 0, stderr: "" });
    expect(bare.stdout).toContain("notebook 0.1.0 — Local notes stored as JSON files");
    expect(group.stdout).toContain("  add     Add a note");
    expect(existsSync(home)).toBe(false);
  });

  test("command help and version create no state; there is no schema command", async () => {
    const add = await notebook(["note", "add", "--help"]);
    expect(add).toMatchObject({ code: 0, stderr: "" });
    expect(add.stdout).toContain("notebook note add <text> [--tag <string>...]");
    const importHelp = await notebook(["note", "import", "--help"]);
    expect(importHelp.stdout).toContain("Stdin:");
    expect((await notebook(["config", "set", "--help"])).stdout).toContain("notebook config set <key> <value>");
    const schema = await notebook(["schema"]);
    expect(schema.code).toBe(2);
    expect(resultJson({ ...schema, exitCode: schema.code! }).error.code).toBe("UNKNOWN_COMMAND");
    expect((await notebook(["--version"])).stdout).toBe("notebook 0.1.0\n");
    expect(existsSync(home)).toBe(false);
  });
});

test("command help shows result fields in a real process and points to root help", async () => {
  const help = await notebook(["note", "list", "--help"]);
  expect(help).toMatchObject({ code: 0, stderr: "" });
  expect(help.stdout).toContain("  data.notes[].id         ID accepted by note show and note remove\n");
  expect(help.stdout).toContain("  For result states and exit codes, run `notebook --help`.\n");
  expect((await notebook(["--help"])).stdout).toContain("130  interrupted; work already done is not undone");
});

describe("execution", () => {
  test("invalid input exits 2 with JSON on stderr and creates no state", async () => {
    for (const argv of [["note", "add"], ["note", "show", "abc"], ["note", "list", "--limit", "0"], ["nope"], ["note", "add", "x", "--colour", "red"]]) {
      const r = await notebook(argv);
      expect(r, argv.join(" ")).toMatchObject({ code: 2, stdout: "" });
      expect(resultJson({ ...r, exitCode: r.code! }).status).toBe("failed");
    }
    expect(existsSync(home)).toBe(false);
  });

  test("state persists between processes in the isolated home", async () => {
    const add = await notebook(["note", "add", "buy milk", "--tag", "home"]);
    expect(add).toMatchObject({ code: 0, stderr: "" });
    expect(resultJson({ ...add, exitCode: add.code! })).toMatchObject({ status: "completed", data: { id: 1, text: "buy milk" } });
    expect(JSON.parse(readFileSync(join(home, "notes.json"), "utf8"))).toHaveLength(1);
    const list = await notebook(["note", "list", "--human"]);
    expect(list.stdout).toBe("#1  buy milk  [home]\nReturned 1 of 1\n");
  });

  test("a default-tag stored by one process is applied by the next", async () => {
    expect((await notebook(["config", "set", "default-tag", "errands"])).code).toBe(0);
    const add = await notebook(["note", "add", "post a letter"]);
    expect(resultJson({ ...add, exitCode: add.code! }).data.tags).toEqual(["errands"]);
    const help = await notebook(["note", "add", "--help"]);
    expect(help.stdout).toContain("stored default-tag");
    expect(help.stdout).toContain("tags must not be empty or only whitespace");
  });

  test("domain failure: JSON on stderr, exit 1", async () => {
    const r = await notebook(["note", "show", "5"]);
    expect(r).toMatchObject({ code: 1, stdout: "" });
    expect(resultJson({ ...r, exitCode: r.code! }).error.code).toBe("NOTE_NOT_FOUND");
  });

  test("piped stdin is read for commands that declare it", async () => {
    const r = await notebook(["note", "import"], { stdin: '[{"text":"a"},{"text":"b"}]' });
    expect(r).toMatchObject({ code: 0, stderr: "" });
    expect(resultJson({ ...r, exitCode: r.code! }).data.added).toHaveLength(2);
    const bad = await notebook(["note", "import"], { stdin: "not json" });
    expect(bad.code).toBe(2);
  });

  test("an unusable store is an internal error with diagnostics on stderr", async () => {
    const r = await notebook(["status"], { env: { NOTEBOOK_HOME: "/dev/null/notebook" } });
    expect(r.code).toBe(70);
    expect(resultJson({ ...r, exitCode: r.code! }).error.code).toBe("INTERNAL_ERROR");
    expect(r.stderr).toContain('diagnostic INTERNAL_ERROR: "Creating the execution context failed"');
  });

  test("large output is flushed completely before exit", async () => {
    const notes = Array.from({ length: 100 }, (_, i) => ({ text: `note ${i} ${"x".repeat(2000)}` }));
    await notebook(["note", "import"], { stdin: JSON.stringify(notes) });
    const r = await notebook(["note", "list", "--limit", "100"]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(200_000);
    expect(resultJson({ ...r, exitCode: r.code! }).data.returned).toBe(100);
  });
});

describe("payload commands", () => {
  const shell = (script: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn("/bin/bash", ["-c", script], {
        cwd: sandbox,
        env: { PATH: process.env.PATH ?? "", HOME: sandbox, NOTEBOOK_HOME: home, NODE: process.execPath, BIN: bin },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
      child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
      child.on("close", (code) => done({ code, stdout, stderr }));
    });

  test("note export is JSON Lines a pipeline can consume record by record", async () => {
    await notebook(["note", "add", "buy milk", "--tag", "home"]);
    await notebook(["note", "add", "two\nlines"]);
    const consumer = `const lines = require("fs").readFileSync(0, "utf8").split("\\n").filter(Boolean); console.log(JSON.stringify(lines.map((l) => JSON.parse(l).text)))`;
    const r = await shell(`set -o pipefail; "$NODE" "$BIN" note export | "$NODE" -e '${consumer}'`);
    expect(r).toMatchObject({ code: 0, stderr: "" });
    expect(resultJson({ ...r, exitCode: r.code! })).toEqual(["buy milk", "two\nlines"]);
    const raw = await notebook(["note", "export"]);
    expect(raw.stdout.split("\n")).toHaveLength(3);
    expect(raw).toMatchObject({ code: 0, stderr: "" });
  });

  test("note texts: LF stops at a text containing LF; --null carries it to xargs -0", async () => {
    await notebook(["note", "add", "plain"]);
    await notebook(["note", "add", "two\nlines"]);
    const lf = await notebook(["note", "texts"]);
    expect(lf.code).toBe(1);
    expect(lf.stdout).toBe("plain\n");
    expect(JSON.parse(lf.stderr.trimEnd().split("\n").at(-1)!).error.code).toBe("RECORD_NOT_REPRESENTABLE");
    const nul = await shell(`set -o pipefail; "$NODE" "$BIN" note texts --null | xargs -0 -n1 printf '<%s>'`);
    expect(nul).toMatchObject({ code: 0, stderr: "" });
    expect(nul.stdout).toBe("<plain><two\nlines>");
  });

  test("invalid input and --human go to stderr with empty stdout and create no state", async () => {
    for (const argv of [["note", "export", "--human"], ["note", "export", "--tag"], ["--human", "note", "texts"]]) {
      const r = await notebook(argv);
      expect(r, argv.join(" ")).toMatchObject({ code: 2, stdout: "" });
      expect(JSON.parse(r.stderr.trimEnd().split("\n").at(-1)!)).toMatchObject({ status: "failed", payload: { recordsWritten: 0, complete: false } });
    }
    expect(existsSync(home)).toBe(false);
  });
});
