# Adapt a handler's result type

English · [Korean](ko/adapters.md) · [README](../README.md)

The core accepts its own outcomes and does not require a result library. Use an
adapter when an existing service already returns neverthrow or Effect values.
Select it on the handler that needs it; adapters are not inherited from groups.

```ts
import { ok } from "neverthrow";
import { command, output } from "cli-for-ai";
import { fromNeverthrow } from "cli-for-ai/neverthrow";

const count = command({
  summary: "Count items",
  output: output<number>(),
  run: fromNeverthrow(() => ok(3)),
});
```

## neverthrow

`fromNeverthrow(handler, options?)` accepts `Result` and `ResultAsync`. Success
becomes completed; a typed error becomes failed. Supply `{ error: mapper }` unless
the error already has the core `Fault` shape. Exceptions from the source or mapper
remain internal errors. ResultAsync itself cannot be cancelled; pass the execution
signal to the service that performs the work. The adapter awaits its result.

## Effect

`fromEffect(handler, options?)` from `cli-for-ai/effect` follows the same success
and typed-failure mapping. The source must have all Effect services provided
(`R = never`), and runs on the default runtime. A plain Fail cause can become a
business failure. Defects, compound causes and finalizer failures become internal
errors; an interruption is recognized as cancellation when the execution signal
was aborted. Caller-owned runtimes are not supported.

Both adapters produce ordinary handlers. They do not adapt payload record sources.
Install the corresponding library when using its adapter. The root module imports
neither library, and the Node process edge is a separate subpath. See
[Reference](reference.md#package-entry-points) for exports and
[Scope](scope.md) for implementation limits.
