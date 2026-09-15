// cli-for-ai/node — the process edge. Reads argv, environment and stdin,
// creates the context lazily, relays cancellation signals, flushes stdout and
// stderr and sets the exit status.

import { diagnosticLine } from "../core/diagnostic.ts";
import type { Application } from "../core/parse.ts";
import { EXIT_CODES, executeTo, OutputClosedError, type Completion, type ExecuteOptions, type Sink } from "../execution/execute.ts";

export interface Host {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** Aborted on the first SIGINT or SIGTERM, and for payload commands also when writing a record to stdout fails. */
  readonly signal: AbortSignal;
}

export interface RunOptions<C> {
  /**
   * Builds the context after argv has been parsed and only when a command needs
   * it. Rejecting after the signal aborted reports an interruption; the factory
   * must release anything it acquired before rejecting.
   */
  context: (host: Host) => C | Promise<C>;
  /** Releases a created context exactly once, after success, failure or interruption. */
  dispose?: (context: C) => void | Promise<void>;
  /** Defaults to process.argv.slice(2). */
  argv?: readonly string[];
  /** Receives original causes of internal errors and output write failures. Nothing but fixed messages is written without it. */
  onDiagnostic?: ExecuteOptions<C>["onDiagnostic"];
}

let running = false;

/**
 * Executes with exitCode 70 while active, then sets the final code once both
 * output streams have been flushed. Resolves with the exit code; does not call
 * process.exit, so handles the context still owns keep the process alive.
 *
 * run uses process-wide signals, streams and exitCode, so calls must be
 * sequential: calling it while another run is in progress rejects before any
 * effect. The first SIGINT or SIGTERM aborts the execution signal, which
 * commands observe cooperatively. A second one exits immediately with 130:
 * output is not flushed and no JSON result is guaranteed.
 */
export async function run<C>(app: Application<C>, options: RunOptions<NoInfer<C>>): Promise<number> {
  if (running) throw new Error("cli-for-ai/node: run() is already in progress in this process; call it sequentially");
  running = true;
  // An abandoned promise with no live handles must not look like an empty successful run.
  process.exitCode = EXIT_CODES.internal;

  const controller = new AbortController();
  let signals = 0;
  const onSignal = () => {
    signals++;
    if (signals === 1) controller.abort();
    else process.exit(EXIT_CODES.interrupted);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const output = new OutputMonitor();
  // Causes executeTo already passed to onDiagnostic, so late handling reports only new ones.
  const reported = new WeakSet<object>();
  const onDiagnostic: ExecuteOptions<C>["onDiagnostic"] = (diagnostic) => {
    if (typeof diagnostic.cause === "object" && diagnostic.cause !== null) reported.add(diagnostic.cause);
    safeDiagnostic(options.onDiagnostic, diagnostic.message, diagnostic.cause);
  };

  try {
    let completion: Completion;
    try {
      // Every write is awaited: a payload is produced only as fast as stdout accepts it.
      completion = await executeTo(app, options.argv ?? process.argv.slice(2), {
        context: (signal) => options.context({ env: process.env, cwd: process.cwd(), signal }),
        ...(options.dispose ? { dispose: options.dispose } : {}),
        readStdin: readProcessStdin,
        signal: controller.signal,
        onDiagnostic,
        stdout: output.sink(process.stdout),
        stderr: output.sink(process.stderr),
      });
    } catch (cause) {
      // The command and its output channel are unknown here, so nothing is written to stdout.
      const message = "Unexpected failure in the execution boundary";
      onDiagnostic({ message, cause });
      await output.write(process.stderr, diagnosticLine("INTERNAL_ERROR", message));
      completion = { exitCode: EXIT_CODES.internal, kind: "internal" };
    }
    // Writes abandoned by a cancelled execution are still Node's to finish. Listeners and
    // signal handlers stay until they do: a blocked reader can hold the process here until it
    // reads or closes, and a second signal forces exit 130 without flushing.
    await output.drain();
    await output.settle();

    // The first failure of each stream reaches onDiagnostic once unless executeTo already reported it, whatever the result.
    for (const { name, cause } of output.failures) {
      if (typeof cause === "object" && cause !== null && reported.has(cause)) continue;
      safeDiagnostic(options.onDiagnostic, `Writing command output to ${name} failed`, cause);
    }
    const failure = output.failure;
    // A late host diagnostic may follow a core failure report; report position is not a protocol.
    if (failure && (completion.payload === undefined || completion.kind === "success")) {
      const message = `Writing command output to ${failure.name} failed`;
      // One fixed line, only on a stderr that is still usable; its own failure is not reported again.
      if (failure.name !== "stderr" && output.usable(process.stderr)) {
        await output.write(process.stderr, diagnosticLine("OUTPUT_DELIVERY_FAILED", message), false);
        await output.drain();
        await output.settle();
      }
    }
    // Output that could not be delivered makes a successful run fail; failures and interruptions keep their class.
    const exitCode = failure && completion.kind === "success" ? EXIT_CODES.internal : completion.exitCode;
    process.exitCode = exitCode;
    return exitCode;
  } finally {
    output.stop();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    running = false;
  }
}

function safeDiagnostic(onDiagnostic: RunOptions<unknown>["onDiagnostic"], message: string, cause: unknown): void {
  try {
    onDiagnostic?.({ message, cause });
  } catch {
    // A failing diagnostic sink must not turn one failure into a crash.
  }
}

// Streams whose reader has left (EPIPE). Writes to them afterwards fail with
// ERR_STREAM_DESTROYED, which is the same departure rather than a new failure.
// Weakly held; no listeners are retained.
const readerLeft = new WeakSet<NodeJS.WriteStream>();

/**
 * The reader of this stream went away. EPIPE on either stream; ENOTCONN on stdout
 * only, observed on macOS where a child's stdio is a socket pair and a reader
 * closing mid-write can surface as ENOTCONN. On stderr ENOTCONN stays a failure.
 */
function departure(stream: NodeJS.WriteStream, error: NodeJS.ErrnoException): boolean {
  return error?.code === "EPIPE" || (error?.code === "ENOTCONN" && stream === process.stdout);
}

/**
 * Observes stdout and stderr errors for one run only: during execution, while
 * the result is written, and until errors from those writes have been emitted.
 * Listeners are added at the start and removed at the end, so other listeners
 * and later errors keep Node's normal behavior.
 */
class OutputMonitor {
  /** The first write failure of each stream, in the order observed; the same error seen twice counts once. */
  readonly failures: { name: "stdout" | "stderr"; cause: unknown }[] = [];
  private readonly seen = new WeakSet<object>();
  /** Every stream.write this run started whose callback has not run yet, however its Sink promise ended. */
  private readonly owned = new Set<Promise<void>>();
  private readonly listeners: [NodeJS.WriteStream, (error: NodeJS.ErrnoException) => void][] = [];

  constructor() {
    for (const stream of [process.stdout, process.stderr]) {
      const listener = (error: NodeJS.ErrnoException) => this.observe(stream, error, true);
      stream.on("error", listener);
      this.listeners.push([stream, listener]);
    }
  }

  get failure(): { name: "stdout" | "stderr"; cause: unknown } | undefined {
    return this.failures[0];
  }

  /**
   * Starts a write and owns it until its callback runs. A write that throws
   * synchronously ends at once. The returned promise never rejects.
   */
  private start(stream: NodeJS.WriteStream, chunk: Uint8Array | string, done: (error: NodeJS.ErrnoException | null | undefined) => void): void {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    this.owned.add(pending);
    const end = (error: NodeJS.ErrnoException | null | undefined) => {
      this.owned.delete(pending);
      finish();
      done(error);
    };
    try {
      stream.write(chunk, (error?: NodeJS.ErrnoException | null) => end(error));
    } catch (error) {
      end(error as NodeJS.ErrnoException);
    }
  }

  /** Waits until every write this run started has finished, including writes whose Sink promise was abandoned on abort. */
  async drain(): Promise<void> {
    while (this.owned.size > 0) await Promise.all(this.owned);
  }

  /**
   * A sink over a process stream. write resolves after Node has handed the chunk
   * to the stream's destination (the write callback) and the event loop has had a
   * turn, so a slow reader slows the producer. That turn keeps fast asynchronous
   * writes from starving signals; a write Node performs synchronously (files, TTYs
   * on POSIX, and pipes on Windows) still cannot be interrupted. write rejects with
   * OutputClosedError when the reader has gone away, with the stream's error on
   * other failures, and with the signal's reason when aborted while pending; the
   * chunk then stays queued and owned by this monitor until Node finishes it.
   */
  sink(stream: NodeJS.WriteStream): Sink {
    return {
      write: (chunk, signal) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          let settled = false;
          const settle = (error?: unknown) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            if (error === undefined) resolve();
            else reject(error);
          };
          const onAbort = () => settle(signal!.reason);
          signal?.addEventListener("abort", onAbort, { once: true });
          const failed = (error: NodeJS.ErrnoException) => {
            this.observe(stream, error, true);
            settle(this.readerGone(stream, error) ? new OutputClosedError({ cause: error }) : error);
          };
          // Node can complete a write without returning to the event loop. Settling in the
          // check phase lets signals and stream events run between records.
          this.start(stream, chunk, (error) => setImmediate(() => (error ? failed(error) : settle())));
        }),
    };
  }

  private readerGone(stream: NodeJS.WriteStream, error: NodeJS.ErrnoException): boolean {
    return departure(stream, error) || (error?.code === "ERR_STREAM_DESTROYED" && readerLeft.has(stream));
  }

  write(stream: NodeJS.WriteStream, text: string, record = true): Promise<void> {
    if (text === "") return Promise.resolve();
    return new Promise((resolve) => {
      this.start(stream, text, (error) => {
        if (error) this.observe(stream, error, record);
        resolve();
      });
    });
  }

  /**
   * Observed on Node 24 with real stdout failures (EBADF on a read-only fd, ECONNRESET
   * on a socket): Node emits 'error' before the write callback's promise continues, so
   * the listener sees it within the run, and process stdio is not destroyed by it.
   * Only a stream that really was destroyed and has not closed yet can still emit, so
   * that case waits for 'close' rather than for time.
   */
  async settle(): Promise<void> {
    await Promise.all(
      [process.stdout, process.stderr].map((stream) =>
        stream.destroyed && !stream.closed ? new Promise<void>((resolve) => stream.once("close", () => resolve())) : undefined,
      ),
    );
  }

  usable(stream: NodeJS.WriteStream): boolean {
    return !stream.destroyed && !stream.writableEnded && !stream.errored;
  }

  stop(): void {
    for (const [stream, listener] of this.listeners) stream.off("error", listener);
    this.listeners.length = 0;
  }

  private observe(stream: NodeJS.WriteStream, error: NodeJS.ErrnoException, record: boolean): void {
    // The same error can arrive through a write callback and the 'error' event.
    if (typeof error === "object" && error !== null) {
      if (this.seen.has(error)) return;
      this.seen.add(error);
    }
    const code = error?.code;
    if (departure(stream, error)) {
      readerLeft.add(stream);
      return;
    }
    if (code === "ERR_STREAM_DESTROYED" && readerLeft.has(stream)) return;
    // The first failure per stream is kept; later failures of the same stream repeat what is already known.
    const name = stream === process.stdout ? "stdout" : "stderr";
    if (record && !this.failures.some((f) => f.name === name)) this.failures.push({ name, cause: error });
  }
}

/**
 * Reads stdin to the end, or rejects as soon as the signal aborts. A stdin that
 * already ended (for example read by an earlier run) has no remaining input; a
 * stdin destroyed or errored without a clean end cannot be read.
 */
function readProcessStdin(signal: AbortSignal): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    if (stdin.readableEnded) return resolve("");
    if (stdin.destroyed || stdin.errored) return reject(new Error("stdin was closed before its end was read"));
    const chunks: Buffer[] = [];
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      stdin.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer | string) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("stdin closed before its end was read"));
    };
    const onAbort = () => {
      cleanup();
      // Release the handle so an open pipe does not keep the process alive.
      stdin.destroy();
      reject(signal.reason);
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    stdin.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
