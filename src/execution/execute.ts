// Process-free execution orchestration. It is not pure: it calls the context
// factory, the stdin reader and command handlers supplied by the caller.
// executeTo writes through caller-supplied sinks and awaits every write;
// execute collects the same bytes into strings.
//
// Order: parse argv and argument constraints → help/version/invalid (no effects)
// → abort check → read declared stdin → stdin shape → construct context → run
// → ordinary: parse output → map status → present; payload: pull, check, encode
// and write one record at a time → finalize the source → dispose context.

import { diagnosticLine } from "../core/diagnostic.ts";
import type { AnyCommand, Handler, OutputDecl } from "../core/command.ts";
import { stdinSelected } from "../core/input.ts";
import { isPayload, isRecords, isStop, type PayloadDecl } from "../core/payload.ts";
import { parseInvocation, type Application, type Invocation } from "../core/parse.ts";
import { inspectOutcome, jsonCopy, projectFault, type Fault, type Outcome } from "../core/result.ts";
import { renderHelp } from "../discovery/help.ts";

export interface ExecuteOptions<C> {
  /**
   * Creates the context, at most once, only when a command that needs it is about
   * to run. It receives the execution signal. If it rejects after the signal
   * aborted, the execution is interrupted; it must clean up anything it acquired
   * before failing.
   */
  context: (signal: AbortSignal) => C | Promise<C>;
  /**
   * Releases a created context. Called exactly once for every created context,
   * after success, failure or interruption, before execute returns.
   */
  dispose?: (context: C) => void | Promise<void>;
  /**
   * Reads all of stdin. Called only for commands that declare stdin, and for a
   * conditional stdin only when its condition holds. It should
   * stop and reject when the signal aborts; the execution is then interrupted.
   */
  readStdin?: (signal: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  /**
   * Receives the original cause of an internal error. Causes can contain
   * secrets or raw service responses, so they are never written by default;
   * stderr only gets the fixed message. Failures of this callback are ignored.
   */
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

export interface Diagnostic {
  /** Fixed framework message, safe to print. */
  readonly message: string;
  /** The original error or value. Not sanitized. */
  readonly cause: unknown;
}

/**
 * internal: failed before the handler returned, so whether it had effects is unknown.
 * unreported: the handler returned completed or accepted, but the result or the
 * context cleanup could not be completed and reported.
 */
export type ExitKind = "success" | "failed" | "invalid" | "internal" | "unreported" | "interrupted";

export interface Rendered {
  readonly exitCode: number;
  readonly kind: ExitKind;
  /** Bytes for stdout. For a payload command, the payload written before the run ended. */
  readonly stdout: string;
  /** Bytes for stderr: framework diagnostics and failure reports. Successful result data is never written here. */
  readonly stderr: string;
  /** The reported outcome, absent for help, version and a successful payload. */
  readonly outcome?: Outcome<unknown>;
  /** Present for payload commands. */
  readonly payload?: PayloadFacts;
}

export interface PayloadFacts {
  /** Report-time lower bound of whole records acknowledged by the sink. Host callbacks or receiver bytes may advance further. Not proof of consumption or storage. */
  readonly recordsWritten: number;
  /** True only after source exhaustion, accepted writes and successful cleanup. An allowed early reader closure succeeds with false. */
  readonly complete: boolean;
}

/**
 * A byte destination. write resolves once the chunk is accepted; awaiting it is
 * the backpressure. A payload is pulled only as fast as writes resolve, so a sink
 * that always resolves without returning to the host's event loop lets a fast
 * source hold the thread; such a host should yield in write.
 */
export interface Sink {
  write(chunk: Uint8Array, signal?: AbortSignal): Promise<void>;
}

/** Rejected by a stdout sink when its reader has gone away, e.g. a closed pipe. */
export class OutputClosedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The output reader closed", options);
    this.name = "OutputClosedError";
  }
}

export interface ExecuteToOptions<C> extends ExecuteOptions<C> {
  stdout: Sink;
  stderr: Sink;
}

export interface Completion {
  readonly exitCode: number;
  readonly kind: ExitKind;
  readonly outcome?: Outcome<unknown>;
  readonly payload?: PayloadFacts;
  /**
   * A failed write of framework text: an ordinary result, help, or a payload
   * failure report. It was passed to onDiagnostic and a successful ordinary run
   * becomes internal (70) — except when an ordinary write rejected with
   * OutputClosedError, which is neither diagnosed nor reclassified here.
   * Payload record writes that fail are part of kind and payload instead.
   */
  readonly outputError?: { readonly stream: "stdout" | "stderr"; readonly cause: unknown };
}

export const EXIT_CODES: Readonly<Record<ExitKind, number>> = {
  success: 0,
  failed: 1,
  invalid: 2,
  internal: 70,
  unreported: 70,
  interrupted: 130,
};

type SuccessStatus = "completed" | "accepted";
type ReportStage = "output-parse" | "result-mapping" | "serialization" | "presentation";

/**
 * Executes and collects stdout and stderr into strings. For payload commands the
 * whole payload is kept in memory; use executeTo to stream it.
 */
export async function execute<C>(app: Application<C>, argv: readonly string[], options: ExecuteOptions<NoInfer<C>>): Promise<Rendered> {
  const out = collector();
  const err = collector();
  const completion = await executeTo(app, argv, { ...options, stdout: out.sink, stderr: err.sink } as ExecuteToOptions<NoInfer<C>>);
  return {
    exitCode: completion.exitCode,
    kind: completion.kind,
    stdout: out.text(),
    stderr: err.text(),
    ...(completion.outcome ? { outcome: completion.outcome } : {}),
    ...(completion.payload ? { payload: completion.payload } : {}),
  };
}

/**
 * Executes and writes through the given sinks, awaiting each write. An ordinary
 * command writes its result once; a payload command writes each record as it is
 * produced and reports failures on stderr.
 */
export async function executeTo<C>(app: Application<C>, argv: readonly string[], options: ExecuteToOptions<NoInfer<C>>): Promise<Completion> {
  const invocation = parseInvocation(app, argv);
  const target = targetOf(invocation);
  const declared = target && isPayload(target.spec.output) ? (target.spec.output as PayloadDecl) : undefined;
  let rendered: RunResult;
  switch (invocation.kind) {
    case "help":
      rendered = { exitCode: 0, kind: "success", stdout: renderHelp(app, invocation.path, invocation.node), stderr: "" };
      break;
    case "version":
      rendered = { exitCode: 0, kind: "success", stdout: `${app.spec.name} ${app.spec.version}\n`, stderr: "" };
      break;
    case "invalid":
      // Presentation flags may be unparsed here, so invalid ordinary invocations always use JSON.
      rendered = declared ? payloadFailure(invocation.fault, "invalid", []) : presentFailure(invocation.fault, "invalid", false);
      break;
    case "internal":
      report(options.onDiagnostic, invocation.message, invocation.cause);
      rendered = declared
        ? payloadFailure({ code: "INTERNAL_ERROR", message: invocation.message }, "internal", [diagnosticLine("INTERNAL_ERROR", invocation.message)])
        : prependDiagnostic(presentFailure({ code: "INTERNAL_ERROR", message: invocation.message }, "internal", false), diagnosticLine("INTERNAL_ERROR", invocation.message));
      break;
    case "run": {
      const run = new Run(invocation.command, invocation.input, invocation.human, options as unknown as ExecuteToOptions<unknown>, declared);
      rendered = await run.execute();
      if (declared) return finishPayload(rendered, run.recordsWritten, options as unknown as ExecuteToOptions<unknown>);
      break;
    }
  }
  if (declared) return finishPayload(rendered, 0, options as unknown as ExecuteToOptions<unknown>);
  let outputError: Completion["outputError"];
  const write = async (stream: "stdout" | "stderr", text: string) => {
    if (text === "") return;
    try {
      await writeText(options[stream], text);
    } catch (cause) {
      outputError ??= { stream, cause };
    }
  };
  await Promise.all([write("stdout", rendered.stdout), write("stderr", rendered.stderr)]);
  // A result that could not be delivered is not a success. A closed reader is left to the host,
  // which may treat it as the caller choosing to stop reading.
  let { exitCode, kind } = rendered;
  if (outputError && !(outputError.cause instanceof OutputClosedError)) {
    report(options.onDiagnostic, `Writing command output to ${outputError.stream} failed`, outputError.cause);
    if (kind === "success") {
      exitCode = EXIT_CODES.internal;
      kind = "internal";
    }
  }
  return {
    exitCode,
    kind,
    ...(rendered.outcome ? { outcome: rendered.outcome } : {}),
    ...(outputError ? { outputError } : {}),
  };
}

const encoder = new TextEncoder();

// Collecting sinks for execute(): framework text (results, help, reports) is kept as the
// exact string; payload bytes are decoded as UTF-8 without removing a leading BOM.
const textCaptures = new WeakMap<Sink, (text: string) => void>();

function collector(): { sink: Sink; text: () => string } {
  const parts: (string | Uint8Array)[] = [];
  const sink: Sink = { write: async (chunk) => void parts.push(chunk.slice()) };
  textCaptures.set(sink, (text) => parts.push(text));
  return {
    sink,
    text: () => {
      let out = "";
      let run: Uint8Array[] = [];
      const flush = () => {
        if (run.length === 0) return;
        const bytes = new Uint8Array(run.reduce((size, chunk) => size + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of run) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        out += new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
        run = [];
      };
      for (const part of parts) {
        if (typeof part === "string") {
          flush();
          out += part;
        } else run.push(part);
      }
      flush();
      return out;
    },
  };
}

/** Writes framework text: exactly to a collecting sink, as UTF-8 to any other. */
function writeText(sink: Sink, text: string): Promise<void> {
  const capture = textCaptures.get(sink);
  if (capture) {
    capture(text);
    return Promise.resolve();
  }
  return sink.write(encoder.encode(text));
}

function targetOf(invocation: Invocation): AnyCommand | undefined {
  if (invocation.kind === "run") return invocation.command;
  if (invocation.kind === "invalid" || invocation.kind === "internal") return invocation.command;
  return undefined;
}

/** Writes one payload failure report with core diagnostics. Host diagnostics may also follow it. */
async function finishPayload(rendered: RunResult, recordsWritten: number, options: ExecuteToOptions<unknown>): Promise<Completion> {
  const complete = rendered.kind === "success" && rendered.payloadComplete !== false;
  const payload: PayloadFacts = { recordsWritten, complete };
  if (rendered.kind === "success") return { exitCode: 0, kind: "success", payload };
  const fault = rendered.payloadFault!;
  const text = `${(rendered.failureLines ?? []).join("")}${JSON.stringify({ status: "failed", error: fault, payload })}\n`;
  let outputError: Completion["outputError"];
  try {
    // One attempt and no signal: an aborted execution signal must not suppress its own report.
    await writeText(options.stderr, text);
  } catch (cause) {
    outputError = { stream: "stderr", cause };
    // Reported once through the diagnostic callback, never retried on stderr; the failure class stays.
    report(options.onDiagnostic, "Writing the payload failure report to stderr failed", cause);
  }
  return { exitCode: rendered.exitCode, kind: rendered.kind, outcome: { status: "failed", error: fault }, payload, ...(outputError ? { outputError } : {}) };
}

interface RunResult extends Rendered {
  /** False for a policy-permitted early stop, even though its exit status is success. */
  readonly payloadComplete?: false;
  /** Payload mode: the fault to report on stderr and the fixed lines before it. */
  readonly payloadFault?: Fault;
  readonly failureLines?: string[];
}

type Abort = "external" | "output";

class Run {
  private readonly signal: AbortSignal;
  private readonly spec: AnyCommand["spec"];
  private readonly input: Record<string, unknown>;
  /** Payload mode: aborted by the caller's signal or by a failed record write. */
  private readonly control = new AbortController();
  /** Whichever stopped the payload first; later aborts do not relabel it. */
  private firstAbort: Abort | undefined;
  recordsWritten = 0;

  constructor(
    private readonly command: AnyCommand,
    parsed: Readonly<Record<string, unknown>>,
    private readonly human: boolean,
    private readonly options: ExecuteToOptions<unknown>,
    private readonly declared: PayloadDecl | undefined,
  ) {
    const outer = options.signal ?? new AbortController().signal;
    this.spec = command.spec;
    this.input = { ...parsed };
    this.signal = declared ? this.control.signal : outer;
    this.outer = outer;
  }

  private readonly outer: AbortSignal;

  /** Facts known once the handler returned success; kept for every later report. */
  private known: { handlerReturned: SuccessStatus; reportedStatus?: SuccessStatus } | undefined;

  async execute(): Promise<RunResult> {
    if (!this.declared) return this.run();
    // The caller's abort reaches the payload through control; the listener lives only for this run.
    const onAbort = () => {
      this.firstAbort ??= "external";
      this.control.abort(this.outer.reason);
    };
    if (this.outer.aborted) onAbort();
    else this.outer.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.run();
    } finally {
      this.outer.removeEventListener("abort", onAbort);
    }
  }

  private async run(): Promise<RunResult> {
    let early: RunResult | undefined;
    try {
      early = await this.prepare();
    } catch (cause) {
      return this.internal("Unexpected failure while preparing the command", cause);
    }
    if (early) return early;

    let context: unknown;
    try {
      context = await this.options.context(this.signal);
    } catch (cause) {
      if (this.signal.aborted) return this.interrupted();
      return this.internal("Creating the execution context failed", cause);
    }

    let rendered: RunResult;
    try {
      // A context that finished creation after abort is still disposed below.
      if (this.signal.aborted) rendered = this.interrupted();
      else rendered = this.declared ? await this.stream(context, this.declared) : await this.perform(context);
    } catch (cause) {
      rendered = this.unexpected(cause);
    }
    return this.dispose(context, rendered);
  }

  /** Cancellation check and stdin: everything before a context exists. Argument constraints already ran while parsing. */
  private async prepare(): Promise<RunResult | undefined> {
    if (this.signal.aborted) return this.interrupted();

    const stdin = this.spec.input?.stdin;
    // A conditional stdin that is not selected is neither read nor checked, and needs no reader.
    if (!stdin || !stdinSelected(stdin, this.input)) return undefined;
    if (!this.options.readStdin) return this.internal("stdin is declared but no stdin reader was provided", undefined);
    let text: string;
    try {
      text = await this.options.readStdin(this.signal);
    } catch (cause) {
      if (this.signal.aborted) return this.interrupted();
      return this.internal("Reading stdin failed", cause);
    }
    if (stdin.format === "json") {
      try {
        this.input.stdin = JSON.parse(text);
      } catch {
        // The engine's parse message quotes fragments of stdin, which can contain credentials.
        return this.fail(
          {
            code: "INVALID_INPUT",
            message: "Invalid value: stdin is not valid JSON",
            details: { input: "stdin", expected: "json" },
          },
          "invalid",
        );
      }
    } else {
      this.input.stdin = text;
    }

    if (stdin.shape) {
      let result: unknown;
      try {
        result = (stdin.shape.parse as (value: unknown) => unknown)(this.input.stdin);
      } catch (cause) {
        return this.internal("The stdin shape check threw", cause);
      }
      const shaped = shapeResult(result);
      if (shaped === undefined) return this.internal("The stdin shape check returned neither {ok: true, value} nor {ok: false, reason}", { returned: result });
      if (!shaped.ok) {
        return this.fail(
          {
            code: "INVALID_INPUT",
            message: `Invalid value: stdin: ${shaped.reason}`,
            details: { input: "stdin", expected: stdin.shape.description, reason: shaped.reason },
          },
          "invalid",
        );
      }
      this.input.stdin = shaped.value;
    }
    return this.signal.aborted ? this.interrupted() : undefined;
  }

  private async perform(context: unknown): Promise<RunResult> {
    const { spec, input, signal } = this;
    let returned: unknown;
    try {
      returned = await (spec.run as Handler<unknown, unknown, unknown>)(input, context, { signal });
    } catch (cause) {
      return this.internal("The command handler threw; whether it changed anything is unknown, so check state before retrying", cause);
    }
    const inspected = inspectOutcome(returned);
    if (inspected.kind === "unrecognized") return this.internal("The command handler did not return an Outcome", returned);

    if (inspected.kind === "failed") {
      const projected = projectFault(inspected.error);
      if (!projected.ok) {
        return this.internal("The command failure cannot be reported as code, message and JSON details", {
          reason: projected.reason,
          failure: inspected.error,
        });
      }
      const interrupted = projected.value.code === "INTERRUPTED" && signal.aborted;
      return presentFailure(projected.value, interrupted ? "interrupted" : "failed", this.human);
    }

    const handlerReturned: SuccessStatus = inspected.status;
    this.known = { handlerReturned };
    if (!inspected.data.ok) return this.unreported("serialization", undefined, { reason: inspected.data.reason });
    let data = inspected.data.value;

    // Successful data is checked exactly once, before anything else sees it.
    const declaredOutput = spec.output as OutputDecl<unknown>;
    if (declaredOutput.parse) {
      try {
        data = (declaredOutput.parse as (data: unknown) => unknown)(data);
      } catch (cause) {
        return this.unreported("output-parse", undefined, cause);
      }
    }

    let status: SuccessStatus = handlerReturned;
    if (handlerReturned === "completed" && spec.result) {
      let mapping: unknown;
      try {
        mapping = (spec.result as (data: unknown, input: unknown) => unknown)(data, input);
      } catch (cause) {
        return this.unreported("result-mapping", undefined, cause);
      }
      const mapped = resultMappingStatus(mapping);
      if (mapped === undefined) return this.unreported("result-mapping", undefined, { returned: mapping });
      status = mapped;
    }
    this.known = { handlerReturned, ...(status !== handlerReturned ? { reportedStatus: status } : {}) };

    // The same projection decides reportability in JSON and --human, before any renderer runs.
    const copied = jsonCopy(data === undefined ? null : data, "data");
    if (!copied.ok) return this.unreported("serialization", status, { reason: copied.reason });
    const outcome: Outcome<unknown> = { status, data: copied.value };

    const renderer = spec.human as ((data: unknown, input: unknown) => unknown) | undefined;
    if (this.human && renderer) {
      // The renderer gets its own copy, so it cannot change the reported outcome.
      const isolated = jsonCopy(copied.value, "data");
      let body: unknown;
      try {
        body = renderer(isolated.ok ? isolated.value : null, input);
      } catch (cause) {
        return this.unreported("presentation", status, cause);
      }
      if (typeof body !== "string") return this.unreported("presentation", status, { returned: body });
      return { exitCode: 0, kind: "success", stdout: acceptedPrefix(status) + withNewline(body), stderr: "", outcome };
    }

    const stdout = this.human
      ? `${acceptedPrefix(status)}${JSON.stringify(copied.value, null, 2)}\n`
      : `${JSON.stringify({ status, data: copied.value })}\n`;
    return { exitCode: 0, kind: "success", stdout, stderr: "", outcome };
  }

  private async dispose(context: unknown, rendered: RunResult): Promise<RunResult> {
    if (!this.options.dispose) return rendered;
    try {
      await this.options.dispose(context);
      return rendered;
    } catch (cause) {
      const message = "Cleaning up the execution context failed";
      report(this.options.onDiagnostic, message, cause);
      const line = diagnosticLine("CONTEXT_CLEANUP_FAILED", message);
      if (this.declared) {
        // An earlier failure keeps its class; both exhausted and policy-stopped successes require cleanup.
        if (rendered.kind !== "success") return { ...rendered, failureLines: [...(rendered.failureLines ?? []), line] };
        return payloadFailure(
          {
            code: "CONTEXT_CLEANUP_FAILED",
            message: "Payload production stopped, but cleaning up the context failed. Check state before retrying.",
          },
          "unreported",
          [line],
        );
      }
      // Failures, interruptions and reporting failures keep their classification.
      if (rendered.kind !== "success" || !this.known) return { ...rendered, stderr: rendered.stderr + line };
      const { handlerReturned, reportedStatus } = this.known;
      const fault: Fault = {
        code: "CONTEXT_CLEANUP_FAILED",
        message: `The command returned ${handlerReturned}, but cleaning up its context failed. Check state before retrying; nothing was rolled back.`,
        details: { handlerReturned, ...(reportedStatus ? { reportedStatus } : {}) },
      };
      return prependDiagnostic(presentFailure(fault, "unreported", this.human), line);
    }
  }

  /** Every failure is reported on stderr; payloads add their progress facts at the boundary. */
  private fail(fault: Fault, kind: Exclude<ExitKind, "success">, line?: string): RunResult {
    if (this.declared) return payloadFailure(fault, kind, line ? [line] : []);
    const rendered = presentFailure(fault, kind, this.human);
    return line ? prependDiagnostic(rendered, line) : rendered;
  }

  // ── payload streaming ──────────────────────────────────────────────────────

  private async stream(context: unknown, declared: PayloadDecl): Promise<RunResult> {
    const { input, signal } = this;
    let returned: unknown;
    try {
      returned = await (this.spec.run as Handler<unknown, unknown, unknown>)(input, context, { signal });
    } catch (cause) {
      if (this.firstAbort === "external") return this.interrupted(true);
      return this.internal("The command handler threw; whether it changed anything is unknown, so check state before retrying", cause);
    }

    if (!isRecords(returned)) {
      const inspected = inspectOutcome(returned);
      if (inspected.kind !== "failed") return this.internal("A payload command must return records(source) or failed(fault)", returned);
      const projected = projectFault(inspected.error);
      if (!projected.ok) return this.internal("The command failure cannot be reported as code, message and JSON details", { reason: projected.reason, failure: inspected.error });
      return this.fail(projected.value, projected.value.code === "INTERRUPTED" && this.outer.aborted ? "interrupted" : "failed");
    }

    let iterator: AsyncIterator<unknown>;
    try {
      iterator = (returned.source as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    } catch (cause) {
      return this.internal("The payload source could not be iterated", cause);
    }

    let result: RunResult | undefined;
    let finished = false;
    // From here until finalization the iterator is owned: any unexpected throw still finalizes it before dispose.
    try {
      const separator = declared.format === "text" ? this.separator(declared) : "\n";
      for (;;) {
        if (signal.aborted) {
          result = this.interrupted(true);
          break;
        }
        let step: IteratorResult<unknown>;
        try {
          step = await iterator.next();
        } catch (cause) {
          result = this.firstAbort === "external" ? this.interrupted(true) : this.internal("The payload source threw", cause);
          break;
        }
        // A cancellation observed while the source was pending wins over what it returned:
        // a cooperative source that ends or stops because of the abort did not complete the payload.
        if (this.abortedExternally()) {
          result = this.interrupted(true);
          finished = settledDone(step);
          break;
        }
        let done: unknown;
        let value: unknown;
        try {
          done = step.done;
          value = step.value;
        } catch (cause) {
          result = this.internal("The payload source returned an unreadable step", cause);
          break;
        }
        if (done) {
          finished = true;
          break;
        }
        if (isStop(value)) {
          result = value.fault
            ? this.fail(value.fault, value.fault.code === "INTERRUPTED" && this.outer.aborted ? "interrupted" : "failed")
            : this.internal("The payload source stopped with a fault that cannot be reported as code, message and JSON details", undefined);
          break;
        }
        // No record is requested or written after cancellation.
        if (signal.aborted) {
          result = this.interrupted(true);
          break;
        }
        let encoded: ReturnType<Run["encode"]>;
        try {
          encoded = this.encode(declared, value, separator);
        } catch (cause) {
          // e.g. a record whose serialization exceeds the engine's string limits.
          result = this.internal("A payload record could not be encoded", cause, { record: this.recordsWritten });
          break;
        }
        if (!encoded.ok) {
          result = encoded.result;
          break;
        }
        try {
          await this.options.stdout.write(encoded.bytes, signal);
        } catch (cause) {
          if (this.firstAbort === "external") {
            result = this.interrupted(true);
            break;
          }
          this.firstAbort ??= "output";
          this.control.abort(cause);
          result = cause instanceof OutputClosedError && declared.readerClose === "allow"
            ? { exitCode: 0, kind: "success", stdout: "", stderr: "", payloadComplete: false }
            : this.outputFailure(cause);
          break;
        }
        this.recordsWritten++;
      }
    } catch (cause) {
      result ??= this.internal("Unexpected failure while streaming the payload", cause, { record: this.recordsWritten });
    }

    if (!finished) {
      // Finalize the source before the context is disposed; a failure here does not hide the first one.
      try {
        await iterator.return?.();
      } catch (cause) {
        const message = "Finalizing the payload source failed";
        report(this.options.onDiagnostic, message, cause);
        if (result?.kind === "success") {
          result = payloadFailure({ code: "INTERNAL_ERROR", message }, "internal", [diagnosticLine("INTERNAL_ERROR", message)]);
        } else if (result) result = { ...result, failureLines: [...(result.failureLines ?? []), diagnosticLine("INTERNAL_ERROR", message)] };
      }
    }
    return result ?? { exitCode: 0, kind: "success", stdout: "", stderr: "" };
  }

  /** Read through a method: the caller's abort can change firstAbort while an await is pending. */
  private abortedExternally(): boolean {
    return this.firstAbort === "external";
  }

  private separator(declared: Extract<PayloadDecl, { format: "text" }>): "\n" | "\0" {
    const framing = declared.framing;
    if (framing === "lf") return "\n";
    if (framing === "nul") return "\0";
    return this.input[framing.nul] === true ? "\0" : "\n";
  }

  private encode(declared: PayloadDecl, value: unknown, separator: string): { ok: true; bytes: Uint8Array } | { ok: false; result: RunResult } {
    const index = this.recordsWritten;
    let line: string;
    if (declared.format === "jsonl") {
      let record = value;
      if (declared.parse) {
        try {
          record = declared.parse(value);
        } catch (cause) {
          return { ok: false, result: this.internal("A payload record does not match its declaration", cause, { record: index }) };
        }
      }
      const copied = jsonCopy(record, "record");
      if (!copied.ok) return { ok: false, result: this.internal("A payload record is not plain JSON data", { reason: copied.reason }, { record: index }) };
      if (typeof copied.value !== "object" || copied.value === null || Array.isArray(copied.value)) {
        return { ok: false, result: this.internal("A JSONL payload record is not a JSON object", undefined, { record: index }) };
      }
      line = `${JSON.stringify(copied.value)}\n`;
    } else {
      if (typeof value !== "string") return { ok: false, result: this.internal("A text payload record is not a string", undefined, { record: index }) };
      if (!value.isWellFormed()) return { ok: false, result: this.internal("A text payload record is not well-formed Unicode", undefined, { record: index }) };
      if (value.includes(separator)) {
        return { ok: false, result: this.notRepresentable(index, `it contains the ${separator === "\0" ? "NUL" : "LF"} separator`) };
      }
      line = `${value}${separator}`;
    }
    const bytes = encoder.encode(line);
    if (bytes.byteLength > declared.maxRecordBytes) {
      return { ok: false, result: this.notRepresentable(index, `its encoding is larger than ${declared.maxRecordBytes} bytes`) };
    }
    return { ok: true, bytes };
  }

  private notRepresentable(index: number, reason: string): RunResult {
    return this.fail(
      {
        code: "RECORD_NOT_REPRESENTABLE",
        message: `Record ${index} cannot be written in the declared format: ${reason}. Nothing of it was written.`,
        details: { record: index, reason },
      },
      "failed",
    );
  }

  private outputFailure(cause: unknown): RunResult {
    if (cause instanceof OutputClosedError) {
      return this.fail(
        { code: "OUTPUT_CLOSED", message: "The output reader closed before the payload was complete" },
        "internal",
      );
    }
    const message = "Writing the payload to stdout failed";
    report(this.options.onDiagnostic, message, cause);
    return this.fail({ code: "OUTPUT_FAILED", message }, "internal", diagnosticLine("OUTPUT_FAILED", message));
  }

  private internal(message: string, cause: unknown, details?: Record<string, number>): RunResult {
    report(this.options.onDiagnostic, message, cause);
    return this.fail({ code: "INTERNAL_ERROR", message, ...(details ? { details } : {}) }, "internal", diagnosticLine("INTERNAL_ERROR", message));
  }

  private unreported(stage: ReportStage, reportedStatus: SuccessStatus | undefined, cause: unknown): RunResult {
    const handlerReturned = this.known!.handlerReturned;
    const message = STAGE_MESSAGES[stage];
    report(this.options.onDiagnostic, message, cause);
    const fault: Fault = {
      code: "RESULT_NOT_REPORTED",
      message: `The command returned ${handlerReturned}, but its result could not be reported: ${message}. Check state before retrying; nothing was rolled back.`,
      details: {
        stage,
        // What the handler returned, not an independent check of external state.
        handlerReturned,
        ...(reportedStatus !== undefined && reportedStatus !== handlerReturned ? { reportedStatus } : {}),
      },
    };
    return prependDiagnostic(presentFailure(fault, "unreported", this.human), diagnosticLine("RESULT_NOT_REPORTED", message));
  }

  /** A framework bug after a point. Success facts are kept only if the handler already returned success. */
  private unexpected(cause: unknown): RunResult {
    if (this.known) return this.unreported("presentation", this.known.reportedStatus, cause);
    return this.internal("Unexpected failure while executing the command", cause);
  }

  private interrupted(streaming = false): RunResult {
    return this.fail(
      { code: "INTERRUPTED", message: streaming ? "Execution was interrupted; the payload is incomplete" : "Execution was interrupted before the command ran" },
      "interrupted",
    );
  }
}

const STAGE_MESSAGES: Readonly<Record<ReportStage, string>> = {
  "output-parse": "the result does not match its output declaration",
  "result-mapping": "the result mapping failed or did not return {status}",
  serialization: "the result is not plain JSON data",
  presentation: "the human presentation failed",
};

function resultMappingStatus(value: unknown): SuccessStatus | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== "status") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, "status");
    if (!descriptor || !("value" in descriptor)) return undefined;
    return descriptor.value === "completed" || descriptor.value === "accepted" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a settled step already ended the source, so it needs no return(). */
function settledDone(step: IteratorResult<unknown>): boolean {
  try {
    return step.done === true;
  } catch {
    return false;
  }
}

function payloadFailure(fault: Fault, kind: Exclude<ExitKind, "success">, lines: string[]): RunResult {
  return { exitCode: EXIT_CODES[kind], kind, stdout: "", stderr: "", outcome: { status: "failed", error: fault }, payloadFault: fault, failureLines: lines };
}

/** Failures are framework-built or already projected to plain JSON, so they always serialize. */
function presentFailure(fault: Fault, kind: Exclude<ExitKind, "success">, human: boolean): Rendered {
  let stderr: string;
  if (human) {
    const lines = [`Error [${fault.code}]: ${fault.message}`];
    if (fault.details !== undefined) lines.push(JSON.stringify(fault.details, null, 2));
    stderr = `${lines.join("\n")}\n`;
  } else {
    stderr = `${JSON.stringify({ status: "failed", error: fault })}\n`;
  }
  return { exitCode: EXIT_CODES[kind], kind, stdout: "", stderr, outcome: { status: "failed", error: fault } };
}

function shapeResult(value: unknown): { ok: true; value: unknown } | { ok: false; reason: string } | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const ok = Object.getOwnPropertyDescriptor(value, "ok");
    if (!ok || !("value" in ok)) return undefined;
    if (ok.value === true) {
      const data = Object.getOwnPropertyDescriptor(value, "value");
      return data && "value" in data ? { ok: true, value: data.value } : undefined;
    }
    if (ok.value === false) {
      const reason = Object.getOwnPropertyDescriptor(value, "reason");
      return reason && "value" in reason && typeof reason.value === "string" ? { ok: false, reason: reason.value } : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function report(onDiagnostic: ExecuteOptions<unknown>["onDiagnostic"], message: string, cause: unknown): void {
  if (!onDiagnostic) return;
  try {
    onDiagnostic({ message, cause });
  } catch {
    // A failing diagnostic sink must not turn one internal error into a crash.
  }
}

function acceptedPrefix(status: SuccessStatus): string {
  return status === "accepted" ? "Accepted; the work is not complete yet.\n" : "";
}

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function prependDiagnostic<T extends Rendered>(rendered: T, line: string): T {
  return { ...rendered, stderr: line + rendered.stderr };
}
