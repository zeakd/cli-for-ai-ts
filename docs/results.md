# Report ordinary results

English · [Korean](ko/results.md) · [README](../README.md)

Use ordinary results when a caller needs a structured answer about an operation.
Use [payloads](payloads.md) when stdout itself is data for another program, such as
JSONL records or a NUL-separated path list.

## Return the state you know

An ordinary handler returns `completed(data)`, `accepted(data)` or `failed(fault)`,
directly or through a Promise. Accepted work has been submitted but is not complete.
A failure reports an error; it does not establish that no work happened.

```ts
import { command, completed, output } from "cli-for-ai";

const status = command({
  summary: "Report readiness",
  output: output({
    summary: "Whether the tool is ready",
    fields: [{ path: "data.ready", summary: "True when ready" }],
    parse(value: unknown) {
      if (typeof value !== "object" || value === null || !("ready" in value) || typeof value.ready !== "boolean") {
        throw new TypeError("Expected a readiness result");
      }
      return { ready: value.ready };
    },
  }),
  run: () => completed({ ready: true }),
  human: (value) => value.ready ? "Ready" : "Not ready",
});
```

Successful ordinary execution writes one JSON result on stdout:

```json
{"status":"completed","data":{"ready":true}}
```

`--human` uses the declared renderer, or readable JSON if none exists. It executes
the same handler. Diagnostics go to stderr in both modes. Ordinary failures under `--human` use
`Error [CODE]: message` on stderr, and accepted results include a line stating that
the work is not complete. Ordinary argv rejections and internal errors from argument checks still use
JSON, even with `--human`, because presentation flags may not have been parsed.

## Validate and describe successful data

`output.parse` runs once for successful data, including directly returned accepted
results. It can validate and normalize the value. Without it, the output type is
only a TypeScript declaration. An optional `result(data, input)` callback can map a
completed result to `{ status: "completed" }` or `{ status: "accepted" }` after
parsing; it cannot replace data. Direct accepted results skip that mapping.

Successful data is projected to plain JSON before presentation. Non-JSON values,
such as BigInt, class instances or cycles, are rejected. Undefined object properties
are omitted; undefined array elements are rejected. Human rendering receives a
separate copy of the projected data, so it does not mutate the reported outcome.

`output.fields` explains useful paths in help; it neither verifies that they exist nor derives their shape from a parser.
Use `data` for the whole result, `data[]` for array items, and `data.notes[].id` for
a nested field. Quoted keys such as `data["a.b"]`, `data[""]` and `data[" "]` handle
punctuation, empty keys and whitespace. Escaped control characters are allowed in
quoted keys. This is display notation, not an executable query language.

`output.schema` is separate descriptive metadata exposed by `applicationSchema`.
It is not the parser and does not prove agreement between the parser, field
annotations and handler. Test that agreement for values callers depend on.

## Channels and exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Completed or accepted ordinary result; a payload satisfied its declared reader-close policy and cleanup succeeded |
| 1 | Application failure; for payloads, also an unrepresentable record |
| 2 | Invalid input, including `--human` on a payload command |
| 70 | Internal, reporting, cleanup or output-delivery failure |
| 130 | Recognized interruption |

Existing failure classifications can be preserved when a later cleanup or delivery
failure occurs. Payload reader closure follows the command’s declared policy; see
[Payload failure and partial output](payloads.md#failure-and-partial-output).

Successful ordinary results and payload data go to stdout. All framework failure
reports go to stderr, including unknown commands and invalid arguments. Help and
version are successful text discovery responses, not ordinary result envelopes.

In JSON mode, a failure report is one compact JSON line. Framework diagnostics are
separate physical lines: `diagnostic CODE: <JSON-string>`. The JSON string escapes
embedded line breaks. Diagnostics can occur before or after the report; never assume
that the last stderr line is the report. `--human` failure reports are text instead.

Check the producer’s exit status first. When collecting JSON failure details, use
separate stdout/stderr capture and require exactly one valid failure report among
the diagnostic lines. If it is missing, malformed or ambiguous, retain the nonzero
status and treat the details as unavailable. A failed write or forced exit may leave
no report. Do not infer success from EOF or from an absent error object.

This framing assumes the framework owns both streams. Handlers should return data
and use `onDiagnostic` for an explicitly configured diagnostic destination, rather
than write directly to process streams. Arbitrary application or library output can
impersonate a report; the framing does not authenticate it. Merging stderr into
stdout also removes channel separation.

## Reporting failure is not rollback

If the handler returned success but output parsing, status mapping, serialization
or rendering fails, `RESULT_NOT_REPORTED` preserves the known returned status.
`CONTEXT_CLEANUP_FAILED` can similarly preserve a successful handler's status.
A handler exception cannot establish whether external state changed. Check state
before retrying; an output error or interruption does not undo work.

A `Fault` publishes `code`, `message` and optional plain-JSON `details`. Internal
causes are available only through an explicit `onDiagnostic` callback; the framework
does not print their stacks or raw service responses by default. See
[Execution](execution.md) for cleanup, cancellation and process output ownership.
