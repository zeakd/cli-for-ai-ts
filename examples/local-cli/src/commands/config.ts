import { completed, failed, group, output } from "cli-for-ai";
import { command } from "../authoring.ts";
import { SETTING_KEYS } from "../context.ts";
import { configurationFault, isValidTag, settingsDocumentFault, tagCheck, TAG_RULE } from "../tags.ts";
import { setting } from "../validate.ts";

const key = { name: "key", summary: "Setting name. default-tag is attached by note add when no --tag is given", values: SETTING_KEYS, required: true } as const;

export const config = group({
  summary: "Read and change settings",
  commands: {
    get: command({
      summary: "Read a setting",
      input: { positionals: [key] },
      output: output({
        summary: "The value, or null when unset",
        fields: [
          { path: "data.key", summary: "Setting name" },
          { path: "data.value", summary: "Stored value, or null when unset" },
        ],
        parse: setting(true),
      }),
      run: async ({ key }, ctx) => {
        const stored = await ctx.settings.get(key);
        if (!stored.valid) return failed(settingsDocumentFault());
        if (stored.value !== null && !isValidTag(stored.value)) return failed(configurationFault(key));
        return completed({ key, value: stored.value });
      },
      human: ({ key, value }) => `${key} = ${value ?? "(unset)"}`,
    }),
    set: command({
      summary: "Change a setting",
      description: `default-tag values follow the tag rule: ${TAG_RULE}.`,
      input: { positionals: [key, { name: "value", summary: "New value", required: true, check: tagCheck }] },
      output: output({
        summary: "The stored value",
        fields: [
          { path: "data.key", summary: "Setting name" },
          { path: "data.value", summary: "Stored value" },
        ],
        parse: setting(false),
      }),
      examples: [{ summary: "Tag new notes with work", input: { key: "default-tag", value: "work" } }],
      run: async ({ key, value }, ctx) => {
        if (!(await ctx.settings.set(key, value))) return failed(settingsDocumentFault());
        return completed({ key, value });
      },
    }),
  },
});
