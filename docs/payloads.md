# Export payloads

English · [Korean](ko/payloads.md) · [README](../README.md)

Use a payload command when its output is the data another program needs: JSONL
records to search, or file paths to pass as arguments. Put `payload.jsonl()` or
`payload.text()` in the command's `output` slot. Ordinary commands keep `output()`
and their JSON result envelope.

## JSONL records

```ts
import { authoring, payload, records } from "cli-for-ai";

type Block = { sessionId: string; text: string };
type Context = {
  blocks(scope: string, signal: AbortSignal): AsyncIterable<Block>;
};

const flat = authoring<Context>().command({
  summary: "Export session blocks as JSONL",
  input: {
    positionals: [{ name: "scope", summary: "Session scope", required: true }],
  },
  output: payload.jsonl<Block>({
    summary: "One session block per line",
    fields: [
      { path: "sessionId", summary: "Session containing the block" },
      { path: "text", summary: "Block text" },
    ],
  }),
  run: ({ scope }, ctx, { signal }) => records(ctx.blocks(scope, signal)),
});
```

Mount `flat` in an application and use `run` from `cli-for-ai/node` as usual. The
Node entry point pulls and writes records incrementally. It writes one plain JSON
object per line, without a surrounding result envelope. Arrays and primitive values
are not JSONL records in this API. String line breaks are JSON-escaped; output is
compact UTF-8, with non-ASCII text preserved.

The type parameter describes the source's record type. An optional `parse(record)`
checks and may normalize each record once before JSON projection and encoding.
Without it, TypeScript checks the declared type, and the executor still checks that
each runtime record is an object representable under the package's plain JSON rules.
`fields` is descriptive metadata and does not validate the record. Paths are relative
to each object: `sessionId`, `tags[]`, or `["a.b"]` for a key containing a dot.

## Text records and separators

```ts
import { authoring, payload, records } from "cli-for-ai";

type Context = {
  paths(signal: AbortSignal): AsyncIterable<string>;
};

const files = authoring<Context>().command({
  summary: "Print matching file paths",
  input: {
    options: {
      null: { summary: "Separate paths with NUL", type: "boolean" },
    },
  },
  output: payload.text({
    summary: "Matching paths",
    records: "file paths",
    framing: { default: "lf", nul: "null" },
  }),
  run: (_input, ctx, { signal }) => records(ctx.paths(signal)),
});
```

The framing declaration binds to the declared boolean option. Without `--null`,
each string ends with LF; with it, each ends with NUL. A fixed `framing: "lf"` or
`framing: "nul"` needs no option. Text is encoded as UTF-8 and is not escaped. A
record containing its separator cannot be emitted in that mode and fails before
that record is written. Use NUL framing with `xargs -0` for paths containing spaces,
quotes, or newlines. Path validity remains the application's responsibility.

Both formats accept `maxRecordBytes`, a positive integer defaulting to 8 MiB,
including the separator. An oversized record fails rather than being truncated.
This is an encoded-record acceptance limit, not a hard limit on JavaScript memory:
the source, parser, JSON projection, and serialization may allocate more.

## Failure and partial output

A handler can return `failed(fault)` before it has a source. During iteration,
yield `stop(fault)` to terminate with an application failure:

```ts
import { records, stop } from "cli-for-ai";

async function* blocks() {
  yield { sessionId: "session-1", text: "First block" };
  yield stop({ code: "SOURCE_UNAVAILABLE", message: "The next block could not be read" });
}

const source = records(blocks());
```

`records()` does not mean the export has completed. Success requires the declared reader-close policy to be satisfied and cleanup to finish.
With the default policy, the source must finish and all its writes must be accepted. `stop()` is a branded
control value; an ordinary record with similar properties is still a record.
Unexpected exceptions and invalid JSON records are internal failures.

All errors go to stderr, including unresolved command routing, invalid arguments
and unsupported `--human`. Argument rejection happens before stdin, context creation,
or the handler. Reading and validating selected stdin also precede context creation.

A payload failure report is one compact JSON line containing `payload.recordsWritten`
and `payload.complete: false`. Framework diagnostic lines may precede or follow it;
see [the channel contract](results.md#channels-and-exit-codes). `recordsWritten` is a
lower bound at report time: only writes acknowledged to the executor are counted.
A cancelled or failed current write may have delivered part or all of a record, and
an owned write can finish after the report. Neither the count nor write acknowledgement
proves receiver consumption or storage. Earlier bytes remain on stdout; no failure
or completion envelope is appended.

### Choose a reader-close policy

Both `payload.jsonl` and `payload.text` accept `readerClose`:

- `"require-full"` (default): an observed closed reader is `OUTPUT_CLOSED`, exit 70.
  Exit 0 requires natural source completion, acknowledged writes and successful cleanup.
- `"allow"`: an observed closed reader stops production and requests source cancellation.
  The iterator is finalized before context disposal. If cleanup succeeds and no earlier
  failure or caller interruption won, the command exits 0. Its API completion has
  `payload.complete: false`; it does not claim a full export. No success report is emitted.

Use the default for full exports. A search-oriented command intended for `head` or
`rg -m` can declare `readerClose: "allow"`. This is the command author's policy, not
proof that the receiver intentionally stopped: a crashed receiver can look identical.
Iterator finalization and context disposal failures still prevent exit 0.

```ts
const paths = payload.text({
  records: "file paths",
  framing: "nul",
  readerClose: "allow",
});
```

Separator collisions and record-size rejections remain application failures (exit 1).
EOF alone does not establish completeness, and producer success does not establish
receiver success. Check producer and receiver status according to the operation's
requirements, using the shell's pipeline status or `pipefail` when appropriate.
`payload.complete: true` requires natural exhaustion, acknowledged writes and successful
cleanup; a cleanup failure can make it false even after all source bytes were written.

Payload commands do not accept `human` or `result` declarations. They reject `--human`
instead of treating it as an export switch. Help shows the payload format, framing,
record descriptions, byte limit, and failure contract.

## Inspect declarations programmatically

`applicationSchema(app)` returns a command with either `output` for an ordinary
result or `payload` for a payload declaration. Code traversing a mixed command tree
must narrow that choice before reading output fields. Payload field paths are
record-relative; ordinary output paths still start with `data`.

Framework options include `scope`: `all`, `ordinary-commands`, or `root`. In
particular, the presence of `human` in `globalOptions` does not mean a payload
command supports it. `lintSchema` accepts a payload summary as its output description.

## Execution and ownership

`run` from `cli-for-ai/node` uses `executeTo(app, argv, options)`. A custom host can
use that API with `stdout` and `stderr` sinks, each providing
`write(chunk: Uint8Array, signal?: AbortSignal): Promise<void>`. Resolve only when the
sink accepts the write; reject on failure and observe a supplied cancellation signal.
Final error reporting omits the signal so cancellation does not suppress its report.
A sink that always resolves immediately should yield to its host event loop so a fast
source does not starve cancellation or I/O events. The Node sink does this. The executor
awaits each write before requesting another record. A custom sink reports a closed
reader with `OutputClosedError`. For ordinary commands, `executeTo` leaves the
closed-reader exit policy to the host and includes the failure in `outputError`;
other delivery errors make an otherwise successful completion nonzero. The Node
host treats a departed reader (`EPIPE`, or `ENOTCONN` on stdout) as success for
otherwise successful ordinary commands. Payloads use their declared `readerClose` policy.

The Node runner reports the first write failure on each stream through
`onDiagnostic`, avoiding duplicate reports for an error already reported by the
executor. Repeated failures on a broken stream do not produce a diagnostic per write.

`execute(app, argv, options)` collects output into strings. It is useful for tests
and small results; it is not the streaming entry point for large exports. Ordinary
JSON commands still produce their complete result before presentation.

A source should read incrementally too. Wrapping a fully loaded array in an async
generator does not make the underlying storage streaming. The notebook example
loads its JSON document before yielding notes; it demonstrates the output contract,
not a streaming database reader.

Cancellation is cooperative. An abort observed before source completion is an
interruption, even if the source responds by ending normally. Once the source and
its writes have completed, an abort during context disposal does not relabel that
result; disposal must still succeed for exit 0. Pass the supplied signal to source operations. Cleanup
waits for pending source work to settle and for iterator finalization before disposing
the context. A source that ignores cancellation can keep the first signal waiting;
a second process signal forces exit without guaranteeing flushed output or cleanup.

The Node runner also owns writes already queued to stdout or stderr. Cancelling the
execution does not retract those bytes. It keeps its signal and error handlers until
all owned writes settle, even after source cleanup and the interruption report. A
stalled reader can therefore keep the first cancellation waiting until it reads or
closes; the second signal is the force-exit path. A cancelled current record may be
partly or fully delivered without being counted in `recordsWritten`.

The Node sink yields to the event loop after write callbacks. This gives signals a
chance to run between records, but cannot interrupt a synchronous OS write. Node's
stdio behavior depends on the destination and platform: file writes are synchronous,
pipe writes are asynchronous on POSIX but synchronous on Windows, and TTY writes
are synchronous on POSIX. See
[Node's process I/O contract](https://nodejs.org/docs/latest-v24.x/api/process.html#process_a_note_on_process_io).

See [the guide's output contracts](https://github.com/zeakd/cli-for-ai-guide/blob/main/guide/en/04-results-and-presentation.md)
for the rationale and receiver-side completion requirements.

For the general context lifecycle and host choice, see [Execution](execution.md).
