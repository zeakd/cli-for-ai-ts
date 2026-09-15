// Declarations are copied when they are declared, so later mutation of the
// author's objects cannot bypass validation. Plain objects and arrays are
// copied recursively and frozen; functions keep their identity. Getters are
// never executed.

export type SnapshotResult<T> = { ok: true; value: T } | { ok: false; issue: string };

export function snapshot<T>(value: T, path: string, keep: (value: object) => boolean = () => false): SnapshotResult<T> {
  const active = new Set<object>();
  const copy = (v: unknown, at: string): SnapshotResult<unknown> => {
    if (v === null || typeof v !== "object") {
      return typeof v === "symbol" || typeof v === "bigint" ? { ok: false, issue: `${at} cannot be a ${typeof v}` } : { ok: true, value: v };
    }
    if (keep(v)) return { ok: true, value: v };
    if (active.has(v)) return { ok: false, issue: `${at} is a circular reference` };
    const isArray = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    if (!isArray && proto !== Object.prototype && proto !== null) return { ok: false, issue: `${at} must be a plain object` };
    active.add(v);
    try {
      const out: Record<PropertyKey, unknown> = isArray ? [] : proto === null ? Object.create(null) : {};
      for (const key of Reflect.ownKeys(v)) {
        if (isArray && key === "length") continue;
        if (typeof key === "symbol") return { ok: false, issue: `${at} has a symbol key` };
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!("value" in descriptor)) return { ok: false, issue: `${at}.${key} is an accessor` };
        if (!descriptor.enumerable) return { ok: false, issue: `${at}.${key} is not enumerable` };
        const item = copy(descriptor.value, isArray ? `${at}[${key}]` : `${at}.${key}`);
        if (!item.ok) return item;
        Object.defineProperty(out, key, { value: item.value, enumerable: true, writable: false, configurable: false });
      }
      return { ok: true, value: Object.freeze(out) };
    } finally {
      active.delete(v);
    }
  };
  return copy(value, path) as SnapshotResult<T>;
}
