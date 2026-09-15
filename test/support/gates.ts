// Deterministic coordination for streaming tests: no sleeps, only explicit gates.

/** A promise that the test opens explicitly. */
export class Gate {
  private release!: () => void;
  readonly opened: Promise<void>;
  isOpen = false;

  constructor() {
    this.opened = new Promise<void>((resolve) => {
      this.release = () => {
        this.isOpen = true;
        resolve();
      };
    });
  }

  open(): void {
    this.release();
  }
}

/** Resolves once a condition observed through notify() holds. */
export class Watch<T> {
  private readonly waiters: { test: (value: T) => boolean; resolve: () => void }[] = [];
  constructor(private value: T) {}

  set(value: T): void {
    this.value = value;
    for (const waiter of this.waiters.slice()) {
      if (waiter.test(value)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  get current(): T {
    return this.value;
  }

  until(test: (value: T) => boolean): Promise<void> {
    if (test(this.value)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ test, resolve }));
  }
}

/**
 * A source that yields one record per opened gate and records how far it got,
 * including whether its finally block ran.
 */
export function gatedSource<R>(records: readonly R[]) {
  const gates = records.map(() => new Gate());
  const progress = new Watch({ requested: 0, yielded: 0, finalized: false });
  async function* source(): AsyncGenerator<R> {
    try {
      for (const [i, record] of records.entries()) {
        progress.set({ ...progress.current, requested: i + 1 });
        await gates[i]!.opened;
        yield record;
        progress.set({ ...progress.current, yielded: i + 1 });
      }
    } finally {
      progress.set({ ...progress.current, finalized: true });
    }
  }
  return { source, gates, progress };
}

/** An async source over an in-memory list. */
export async function* fromList<R>(items: Iterable<R>): AsyncGenerator<R> {
  yield* items;
}
