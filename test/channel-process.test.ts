import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

function childRun(file: string, args: string[], env: NodeJS.ProcessEnv = process.env, closeReader = false) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 5000);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (closeReader) child.stdout.destroy(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Process did not terminate before the safety deadline"));
      else resolveRun({ code, signal, stdout, stderr });
    });
  });
}

describe("Node completion guard", () => {
  test.each(["handler", "dispose", "source"])("abandoned %s cannot exit success with no live handles", async (mode) => {
    for (const entry of ["await", "void"]) {
      const r = await childRun(resolve(import.meta.dirname, "fixtures/abandoned-run.mjs"), [mode, entry]);
      expect(r).toEqual({ code: 70, signal: null, stdout: "", stderr: "" });
    }
  });
  test("orderly sequential runs replace the pessimistic code", async () => {
    const r = await childRun(resolve(import.meta.dirname, "fixtures/abandoned-run.mjs"), ["sequence"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe("completed");
    expect(JSON.parse(r.stderr).status).toBe("failed");
  });
});

test("a real early reader departure may stop an allow stream after cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reader-allow-"));
  const report = join(dir, "report.jsonl");
  try {
    const r = await childRun(resolve(import.meta.dirname, "fixtures/payload.mjs"), ["endless"], { ...process.env, READER_CLOSE: "allow", FIXTURE_REPORT: report }, true);
    expect(r.code).toBe(0); expect(r.signal).toBe(null); expect(r.stderr).toBe("");
    const facts = readFileSync(report, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(facts[0]).toMatchObject({ aborted: true });
    expect(facts.slice(1)).toEqual([{ disposed: true }, { returned: 0 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
