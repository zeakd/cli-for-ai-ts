# API reference

English · [Korean](ko/reference.md) · [README](../README.md)

This page locates public APIs and records defaults. Topic pages explain their use;
linked source declarations contain the complete generic signatures and types.

## Package entry points

| Import | Exports and purpose |
| --- | --- |
| `cli-for-ai` | Declarations, results, discovery and process-free execution; [root exports](../src/index.ts) |
| `cli-for-ai/node` | `run`, `Host`, `RunOptions`; [Node runner](../src/node/index.ts) |
| `cli-for-ai/neverthrow` | `fromNeverthrow` and its source/options types; [adapter](../src/adapters/neverthrow.ts) |
| `cli-for-ai/effect` | `fromEffect`, its source/options types and `EffectCauseError`; [adapter](../src/adapters/effect.ts) |
| `cli-for-ai/lint` | `lintSchema`, `lintSummary` and schema/finding types; [lint](../src/lint/index.ts) |
| `cli-for-ai/upgrade` | `DEV_SENTINEL`, `isNewer`, `updaterEnabled`; [update primitives](../src/upgrade/index.ts) |

Upgrade helpers only gate a tool-owned binary updater and compare numeric version
parts. They neither download nor replace a binary, ignore prerelease suffixes, and
are not a complete SemVer policy or package-manager integration.

## Declarations and defaults

| Surface | Contract | Details |
| --- | --- | --- |
| `command(spec)` | Required summary, output and handler; optional input, description, examples, constraints; ordinary commands also allow result and human | [Commands](commands.md), [source](../src/core/command.ts) |
| `dynamicCommand(spec)` | Runtime input names; handler values are unknown, context/output remain typed | [Commands](commands.md#declare-input-names-at-runtime) |
| `string`, `number`, `integer`, `flag`, `positional`, `stdinText`, `stdinJson` | Optional literal-preserving declaration helpers | [Inputs](inputs.md#preserve-types-when-sharing-declarations) |
| `input.forward` | Verbatim child arguments after the first `--`; empty array by default | [Forwarding](inputs.md#forward-arguments-to-another-program) |
| `ConstraintFacts.provided` | Explicit provision, restricted to a rule's dependencies | [Constraints](inputs.md#distinguish-a-default-from-an-explicit-value) |
| `authoring<C>()` | Binds a context type for command declarations | [Execution](execution.md) |
| `group(spec)`, `application(spec)` | Arrange declarations in a tree; bare groups show help | [Commands](commands.md) |
| Positionals and value options | Default type string; optional unless required or defaulted; arrays only when variadic/repeat is declared | [Inputs](inputs.md), [types](../src/core/input.ts) |
| Boolean options | False when absent, true when supplied; no explicit value token | [Input grammar](inputs.md#argument-grammar) |
| `check.string`, `check.number`, `constraints` | Synchronous declared validation before execution effects | [Inputs](inputs.md) |
| `stdin` | Reads all input when declared; optional `when` selects by parsed scalar equality | [Conditional stdin](inputs.md#select-when-stdin-is-read) |
| `output` | Ordinary JSON output; optional parse, summary, schema and fields | [Results](results.md) |
| `payload.jsonl`, `payload.text` | Object JSONL or LF/NUL text; default record limit 8 MiB including separator; `readerClose` defaults to `"require-full"`, optionally `"allow"` | [Payloads](payloads.md) |
| `completed`, `accepted`, `failed` | Ordinary outcomes; `Fault` contains code, message and optional details | [Results](results.md) |
| `records`, `stop` | Start a payload source or report a typed failure during production | [Payloads](payloads.md) |

`DEFAULT_MAX_RECORD_BYTES` exports the payload default limit. `EXIT_CODES` exports
the classification-to-code mapping documented in [Results](results.md#channels-and-exit-codes).

## Execution and discovery

`execute(app, argv, options)` returns `Rendered`; `executeTo(app, argv, options)`
returns `Completion` and writes to supplied sinks. `Rendered` collects strings,
while `Completion` reports status and any payload progress or text delivery failure.
See [execution types](../src/execution/execute.ts) and the
[exit-code table](results.md#channels-and-exit-codes).

`parseInvocation(app, argv)` returns `help`, `version`, `run`, `invalid` or
`internal`. It parses argv but neither reads stdin nor creates context. A run
invocation includes the selected command and parsed inputs; execution evaluates
conditional stdin afterward.

`applicationSchema(app)` describes the tree. Commands have either `output` or
`payload`, so consumers narrow that union before inspecting fields. Global option
entries have scope: `all`, `ordinary-commands` or `root`.
`renderHelp(app, path, node)` accepts a resolved application, group or command;
`usage(app, path, node)` accepts a group or command;
see [discovery source](../src/discovery/help.ts).

The exact options, types and declaration errors are exposed through the
[root exports](../src/index.ts). Keep literal input information with
`as const satisfies InputDecl` when sharing declarations; broad annotations can
lose the information needed for compile-time checks. See
[shared declarations](inputs.md#share-a-stdin-declaration).
