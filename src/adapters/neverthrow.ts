// cli-for-ai/neverthrow — wraps one handler that returns a neverthrow Result
// or ResultAsync. Ok becomes completed; Err becomes failed. Nothing is inherited
// from groups or the application.
//
// A running ResultAsync is awaited, not raced against cancellation: neverthrow
// has no cancellation. Pass the execution signal to your own APIs if needed.

import type { Result, ResultAsync } from "neverthrow";
import type { Execution, Handler } from "../core/command.ts";
import { completed, failed, type Fault } from "../core/result.ts";

export type NeverthrowSource<I, C, A, E> = (input: I, context: C, execution: Execution) => Result<A, E> | ResultAsync<A, E>;

export interface NeverthrowOptions<E> {
  /** Converts a source error into a Fault. Required unless the error already is one. */
  error: (error: E) => Fault;
}

export function fromNeverthrow<I, C, A, E extends Fault>(handler: NeverthrowSource<I, C, A, E>): Handler<I, C, A>;
export function fromNeverthrow<I, C, A, E>(handler: NeverthrowSource<I, C, A, E>, options: NeverthrowOptions<E>): Handler<I, C, A>;
export function fromNeverthrow<I, C, A, E>(
  handler: NeverthrowSource<I, C, A, E>,
  options?: NeverthrowOptions<E>,
): Handler<I, C, A> {
  return async (input, context, execution) => {
    const result = await handler(input, context, execution);
    return result.match(
      (data) => completed(data),
      (error) => failed(options ? options.error(error) : (error as Fault)),
    );
  };
}
