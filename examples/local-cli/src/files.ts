import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Documents } from "./context.ts";

/** JSON documents under one directory. Creating it is the first effect of a run. */
export async function fileDocuments(home: string): Promise<Documents> {
  await mkdir(home, { recursive: true });
  return {
    read: async (name) => {
      try {
        return JSON.parse(await readFile(join(home, `${name}.json`), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error(`Cannot read ${name}.json in ${home}`, { cause: error });
      }
    },
    write: async (name, value) => {
      const target = join(home, `${name}.json`);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
      await rename(temporary, target);
    },
  };
}
