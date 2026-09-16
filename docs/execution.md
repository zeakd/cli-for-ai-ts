# Connect execution to the environment

English · [Korean](ko/execution.md) · [README](../README.md)

Commands receive application services through a context. Put file access, network
clients and clocks there when a command needs them. A CLI that owns no persistent
state does not need a home directory.

## Choose the execution boundary

| API | Role |
| --- | --- |
| `execute(app, argv, options)` | Runs without process IO and collects stdout/stderr strings; useful for tests and bounded output |
| `executeTo(app, argv, options)` | Writes to injected byte sinks and awaits each write |
| `run(app, options)` from `cli-for-ai/node` | Connects argv, stdin, environment, signals and process output |

These are effectful orchestration APIs, not pure functions. Deterministic parsing
and declaration inspection do not require starting an execution.

`execute` and `executeTo` receive `context(signal)`. The Node runner instead passes
`context({ env, cwd, signal })`. With `authoring<Context>()`, command handlers share
a context type. See [Testing](testing.md) for a
complete injected-context example.

For `execute` and `executeTo`, provide `readStdin(signal)` when an invocation
selects stdin. It returns `Promise<string>` and should reject when cancelled. The
Node runner supplies its own reader. A custom host that omits the reader gets an
internal error if stdin is selected; an inactive condition needs no reader.
Tests can provide `readStdin: async () => '["Ada"]'` to supply a bounded fixture.
An optional `signal` on execution options lets the host request cancellation.

## Validate before creating resources

Execution parses argv and its constraints first. Help, version and rejected input
return before context construction. Selected stdin is read and checked next; an
inactive [stdin condition](inputs.md#select-when-stdin-is-read) does not touch it.
Only then does the context factory run, followed by the handler.

If a context was created, `dispose(context)` is awaited exactly once. A factory
that acquires resources and then rejects must release them itself. Payload source
finalization happens before context disposal so the source does not outlive the
resources it uses. Ordinary results are prepared before disposal and returned after
cleanup. Cleanup failure handling is described in [Results](results.md).

## Cancellation and output ownership

The first SIGINT or SIGTERM aborts the execution signal. Handlers and sources must
pass it to cancellable operations; a pending operation that ignores it can keep the
runner waiting. An ordinary handler's returned outcome is not automatically replaced
just because it observed a signal. To report an ordinary handler's cancellation,
return `failed({ code: "INTERRUPTED", message: "Execution was interrupted" })`
while its execution signal is aborted; that combination is classified as exit 130.
The same fault without an aborted signal is an application failure. An ordinary
handler must catch a cancellation rejection and return that fault itself; letting
an AbortError or other rejection escape is an internal error (exit 70), even when
the signal is aborted.
Payload production observes cancellation as
described in [Payloads](payloads.md#execution-and-ownership).

The Node runner waits for writes it started to settle before removing its error and
signal listeners. A stalled reader can therefore delay exit after cancellation.
A second termination signal forces exit 130 without guaranteeing flushed output.
Normal `run` resolves with the exit code and sets `process.exitCode`; remaining
application handles can still keep the process alive. Calls to `run` in one process
must be sequential.

Custom sinks implement `write(chunk: Uint8Array, signal?: AbortSignal)` and resolve
when the write is accepted. Failure reports may omit the signal so cancellation
does not suppress reporting. Sink backpressure, reader closure and diagnostics are
specified in [Payloads](payloads.md#execution-and-ownership).

`onDiagnostic` receives original causes, which may include sensitive application
data. It is opt-in; fixed public messages are used by default. A diagnostic callback
that throws does not replace the execution result.

The Node runner sets a provisional exit code of 70 when it starts an accepted run,
and replaces it when execution and owned writes finish. If an unresolved operation
has no active Node handles and the process exits without completing `run`, it therefore
does not silently exit 0. This guard does not keep the process alive, force an operation
to finish, or guarantee an error report. Always await `run`; on Node 24 the provisional
code can also suppress Node's unsettled top-level-await warning.

### Exporting authoring helpers

`authoring<C>()` returns the public `Authoring<C>` type; its `command` member has type `CommandFactory<C>`. You can export either the helper object or the bound command function from a module that emits declarations. These types can also be imported from `cli-for-ai` for explicit annotations.

When exported commands expose your own named output or context types, export those types from their defining modules too. TypeScript needs to name them when emitting declarations for an application assembled in another module.
