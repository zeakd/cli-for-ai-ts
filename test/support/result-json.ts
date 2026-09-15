import { expect } from "vitest";

// Only for ordinary JSON executions. Payload prefixes and human reports need their own assertions.
export function resultJson(result: { exitCode: number; stdout: string; stderr: string }): ReturnType<typeof JSON.parse> {
  if (result.exitCode === 0) return JSON.parse(result.stdout);
  expect(result.stdout).toBe("");
  const lines = result.stderr.trimEnd().split("\n");
  const reports = lines.filter((line) => !line.startsWith("diagnostic "));
  expect(reports).toHaveLength(1);
  const report = JSON.parse(reports[0]!);
  expect(report.status).toBe("failed");
  return report;
}
