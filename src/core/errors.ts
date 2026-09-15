/** Thrown for invalid declarations. It signals an author's mistake, never a caller's. */
export class AuthoringError extends Error {
  readonly issues: readonly string[];
  constructor(subject: string, issues: readonly string[]) {
    super(`${subject}: ${issues.join("; ")}`);
    this.name = "AuthoringError";
    this.issues = issues;
  }
}

