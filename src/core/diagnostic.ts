/** A framework-owned diagnostic, distinct from JSON reports and confined to one physical line. */
export function diagnosticLine(code: string, message: string): string {
  const escaped = JSON.stringify(message).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return `diagnostic ${code}: ${escaped}\n`;
}
