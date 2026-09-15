// cli-for-ai/effect — wraps one handler that returns an Effect whose
// requirements are already provided. It runs on the default Effect runtime.
//
// Limits of this adapter: caller-owned runtimes are not supported; only a plain
// Fail cause becomes a business failure; interruption is reported as
// INTERRUPTED only when the execution signal was aborted; every other cause
// (defects, compound causes, finalizer failures) is rethrown and surfaces as an
// internal error. Interruption does not undo external work.

import { Cause, Effect, Exit } from "effect";
import type { Execution, Handler } from "../core/command.ts";
import { completed, failed, type Fault } from "../core/result.ts";

export type EffectSource<I, C, A, E> = (input: I, context: C, execution: Execution) => Effect.Effect<A, E, never>;

export interface EffectOptions<E> {
  /** Converts a typed failure into a Fault. Required unless the failure already is one. */
  error: (error: E) => Fault;
}

export function fromEffect<I, C, A, E extends Fault>(handler: EffectSource<I, C, A, E>): Handler<I, C, A>;
export function fromEffect<I, C, A, E>(handler: EffectSource<I, C, A, E>, options: EffectOptions<E>): Handler<I, C, A>;
export function fromEffect<I, C, A, E>(handler: EffectSource<I, C, A, E>, options?: EffectOptions<E>): Handler<I, C, A> {
  return async (input, context, execution) => {
    const exit = await Effect.runPromiseExit(handler(input, context, execution), { signal: execution.signal });
    if (Exit.isSuccess(exit)) return completed(exit.value);
    const cause = exit.cause;
    if (Cause.isInterruptedOnly(cause) && execution.signal.aborted) {
      return failed({ code: "INTERRUPTED", message: "Execution was interrupted; work already performed is not rolled back" });
    }
    if (cause._tag === "Fail") return failed(options ? options.error(cause.error) : (cause.error as Fault));
    throw new EffectCauseError(cause);
  };
}

/** Carries an Effect cause that is not a plain typed failure to the internal-error boundary. */
export class EffectCauseError extends Error {
  readonly effectCause: Cause.Cause<unknown>;
  constructor(cause: Cause.Cause<unknown>) {
    super(`Effect did not succeed: ${Cause.pretty(cause)}`, { cause: Cause.squash(cause) });
    this.name = "EffectCauseError";
    this.effectCause = cause;
  }
}
