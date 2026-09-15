import { okAsync, errAsync, ResultAsync } from "neverthrow";

export interface Note {
  id: number;
  text: string;
  tags: string[];
  createdAt: string;
}

export interface NoteNotFound {
  code: "NOTE_NOT_FOUND";
  message: string;
  details: { id: number };
}

export const SETTING_KEYS = ["default-tag"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

// Everything effectful arrives through Context, so commands can be tested with
// an in-memory implementation and the file-backed one lives at the edge.
export interface Context {
  notes: NoteStore;
  settings: SettingsStore;
}

export interface NoteStore {
  add(text: string, tags: readonly string[]): ResultAsync<Note, never>;
  /** Adds all notes with one document write. A failed write may still leave the file partially replaced on some filesystems. */
  addAll(items: readonly { text: string; tags: readonly string[] }[]): ResultAsync<Note[], never>;
  list(): ResultAsync<Note[], never>;
  get(id: number): ResultAsync<Note, NoteNotFound>;
  remove(ids: readonly number[]): ResultAsync<number[], { missing: number[] }>;
}

/** A settings document that is not a JSON object cannot be read or safely updated. */
export type StoredSetting = { valid: true; value: unknown } | { valid: false };

export interface SettingsStore {
  /** The stored value as found (null when unset), or invalid when the settings document is malformed. Callers validate the value. */
  get(key: SettingKey): Promise<StoredSetting>;
  /** Returns false without writing when the existing settings document is malformed. */
  set(key: SettingKey, value: string): Promise<boolean>;
}

/** Persistence as whole JSON documents. File and memory backends implement it. */
export interface Documents {
  read(name: string): Promise<unknown>;
  write(name: string, value: unknown): Promise<void>;
}

export function createContext(documents: Documents, now: () => Date): Context {
  const load = () => ResultAsync.fromSafePromise(documents.read("notes")).map((v) => (v ?? []) as Note[]);
  const save = (notes: Note[]) => ResultAsync.fromSafePromise(documents.write("notes", notes));
  const notFound = (id: number): NoteNotFound => ({ code: "NOTE_NOT_FOUND", message: `No note with id ${id}`, details: { id } });

  const addAll = (items: readonly { text: string; tags: readonly string[] }[]) =>
    load().andThen((notes) => {
      const first = Math.max(0, ...notes.map((n) => n.id)) + 1;
      const createdAt = now().toISOString();
      const added = items.map((item, i): Note => ({ id: first + i, text: item.text, tags: [...item.tags], createdAt }));
      return save([...notes, ...added]).map(() => added);
    });

  return {
    notes: {
      add: (text, tags) => addAll([{ text, tags }]).map(([note]) => note!),
      addAll,
      list: () => load(),
      get: (id) => load().andThen((notes) => {
        const note = notes.find((n) => n.id === id);
        return note ? okAsync(note) : errAsync(notFound(id));
      }),
      remove: (ids) =>
        load().andThen((notes) => {
          const missing = ids.filter((id) => !notes.some((n) => n.id === id));
          if (missing.length > 0) return errAsync({ missing });
          return save(notes.filter((n) => !ids.includes(n.id))).map(() => [...ids]);
        }),
    },
    settings: {
      get: async (key) => {
        const all = settingsDocument(await documents.read("settings"));
        if (all === undefined) return { valid: false };
        return { valid: true, value: Object.hasOwn(all, key) ? all[key] : null };
      },
      set: async (key, value) => {
        const all = settingsDocument(await documents.read("settings"));
        if (all === undefined) return false;
        await documents.write("settings", { ...all, [key]: value });
        return true;
      },
    },
  };
}

/** An absent document is empty; anything but a plain JSON object is malformed. */
function settingsDocument(value: unknown): Record<string, unknown> | undefined {
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function memoryDocuments(initial: Record<string, unknown> = {}): Documents & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = structuredClone(initial);
  return {
    data,
    read: async (name) => (Object.hasOwn(data, name) ? structuredClone(data[name]) : null),
    write: async (name, value) => {
      data[name] = structuredClone(value);
    },
  };
}
