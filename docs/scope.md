# Implementation scope

English · [Korean](ko/scope.md) · [README](../README.md)

This document describes the implementation alongside its code. The
[guide](https://github.com/zeakd/cli-for-ai-guide) explains design principles, some
of which are not implemented here. The `main` branch
describes the current source; an installed package version may differ.

## Supported behavior

| Area | Available behavior |
| --- | --- |
| Discovery | Mixed-depth command trees; bare application/group equals help; generated example invocations and descriptions |
| Input | Unknown and extra inputs rejected; scalar/repeated values, defaults, value and cross-input checks with explicit-provision facts, forwarded arguments after `--` |
| Authoring | Inline declarations, literal-preserving helpers, runtime declarations through `dynamicCommand` |
| Stdin | Text/JSON, shape parsing before context, conditional reading by scalar equality |
| Ordinary results | JSON default, explicit human rendering, completed/accepted/failed, optional output parser and field annotations |
| Payloads | JSONL object and LF/NUL text records, backpressure, record limits, partial-failure reports, declared reader-close policy |
| Execution | Injected context, disposal, cooperative signals, owned-write flushing in the Node runner |
| Inspection | Programmatic application schema and schema lint |
| Adapters | Per-handler neverthrow and limited Effect support |
| Verification | Type checks, injected execution, actual processes and built-package consumers |

## Boundaries

Task skills, structured result actions and hints, artifact management, binary
payloads, and broader partial/unknown operation outcomes are not implemented.
Payload progress reporting does not implement those operation states. Machine-readable
read/mutation classification is not provided; command descriptions must explain effects.

Input uses the [documented grammar](inputs.md#argument-grammar). Shared flags and
configuration precedence are application concerns. Option relationships use
`constraints`; there are no dedicated exclusivity/dependency helpers. General
constraints cannot read framework presentation flags. Payloads default to `readerClose: "require-full"`; search-oriented commands can allow
early reader closure explicitly. See [Payloads](payloads.md#choose-a-reader-close-policy).

Selected stdin is buffered in full. `execute` also collects payload output; use
`executeTo` or the Node runner for incremental output. A record-byte limit does not
bound source, parser or serialization allocations. Cancellation requires cooperation.
These limits and partial-write behavior are detailed in [Payloads](payloads.md).

Schemas and field annotations describe output; they do not prove agreement with
parsers or emitted data. Workflow descriptions remain authored material. The
[testing approach](testing.md) covers what generated checks cannot establish.

Effect support requires provided services and the default runtime. Adapters do not
wrap payload handlers. See [Adapters](adapters.md) for the exact limits.

## Runtime and distribution

Use Node 24 or later and compiled `dist` exports. TypeScript consumers need Node
type declarations (or an environment providing the same platform types).
No particular home directory or result library is required.
See [Getting started](getting-started.md) for installation and your first command.
