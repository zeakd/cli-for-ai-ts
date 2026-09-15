import { check, type Fault } from "cli-for-ai";

/** One rule for tags from --tag and from the stored default-tag: not empty, not only whitespace. Inner spaces are fine. */
export const TAG_RULE = "tags must not be empty or only whitespace";

export function isValidTag(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The same rule as a declaration constraint for --tag and config values. */
export const tagCheck = check.string(TAG_RULE, isValidTag);

/** A stored value that breaks the rule is a configuration problem, not a mistake in the current arguments. */
export function configurationFault(key: string): Fault {
  return {
    code: "INVALID_CONFIGURATION",
    message: `The stored ${key} is invalid (${TAG_RULE}); change it with: notebook config set ${key} <value>`,
    details: { key, expected: TAG_RULE },
  };
}

/** The settings document itself is malformed; it is left untouched for the user to inspect. */
export function settingsDocumentFault(): Fault {
  return {
    code: "INVALID_CONFIGURATION",
    message: "The settings file is not a JSON object; it was not changed. Fix or remove settings.json in the notebook home.",
    details: { document: "settings", expected: "JSON object" },
  };
}
