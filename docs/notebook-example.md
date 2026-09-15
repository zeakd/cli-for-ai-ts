# Explore the notebook example

English · [Korean](ko/notebook-example.md) · [README](../README.md)

A command declares the input it accepts and returns an outcome. The application
places commands at invocation paths, and the Node entry point connects them to
argv, stdin and process output. Keeping these parts separate lets the same command
run against an in-memory store in tests and a file-backed store in the executable.

The local example is a notebook. It provides note commands under one group and a
status command at the root. The command definitions do not include those paths;
`app.ts` chooses where they appear.

```text
notebook
├── status
├── note
│   ├── add
│   ├── list
│   ├── show
│   ├── remove
│   ├── import
│   ├── export
│   └── texts
└── config
    ├── get
    └── set
```

## Explore the example

Build the package before running example source. The examples import its compiled
distribution through workspace dependencies, just as a consumer imports an installed
package. Use Node 24 or later.

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/local-cli/src/cli.ts
node examples/local-cli/src/cli.ts note
node examples/local-cli/src/cli.ts note add --help
```

An empty invocation and `--help` show the same top-level help. The `note` group
shows its commands without changing the store. A leaf command can run without
arguments when its input contract permits it; `note add` instead reports the
missing text. Discovery does not construct the store context.

## Use an isolated store

The executable chooses its storage directory. Set NOTEBOOK_HOME to an empty
directory to keep the example separate from your normal notes. This convention
belongs to the notebook example; the framework does not require applications to
have a home directory.

```sh
export NOTEBOOK_HOME="$(mktemp -d)"
node examples/local-cli/src/cli.ts note add "Buy milk" --tag home
node examples/local-cli/src/cli.ts note list
node examples/local-cli/src/cli.ts note list --human
```

Ordinary results use JSON whether stdout is a terminal or a pipe. `--human` selects
a command's renderer, or readable JSON when a renderer is absent. It does not
change which notes are read or written. The list result includes the returned and
total counts so the caller can distinguish the selected page from all matching
notes.

## Read the result description

`note list --help` describes the result fields alongside the input options. For
example, `data.notes[].id` is the identifier accepted by `note show` and `note remove`;
`data.returned` and `data.total` describe how much of the matching set was returned.
These paths describe JSON output, while `--human` may use a different presentation.

The descriptions come from `output.fields` in the command declaration. Keep them
aligned with the handler's result and output parser; the framework does not verify
that every described field exists. Common result states and exit codes are explained
in the root help, reached by invoking the tool without a command or with `--help`.

## Export the data directly

`note export` writes note objects as JSONL. `note texts` writes note content with
LF separators; `note texts --null` uses NUL so content can contain line breaks.

```sh
node examples/local-cli/src/cli.ts note export --help
node examples/local-cli/src/cli.ts note export --tag home
node examples/local-cli/src/cli.ts note texts --null
```

These commands emit payload without a result envelope and send errors to stderr.
A failure can leave earlier output in place. The note store still loads its whole
JSON document, so this example demonstrates the output contract rather than
incremental storage reads. [Export payloads](payloads.md) explains lazy sources and
completion checks.

## Apply configuration and import a batch

The notebook's `default-tag` applies when `note add` has no explicit `--tag`.
An explicit tag takes precedence. The configuration is application behavior, not a
framework-wide precedence rule.

```sh
node examples/local-cli/src/cli.ts config set default-tag work
node examples/local-cli/src/cli.ts note add "Review the release"
node examples/local-cli/src/cli.ts note add "Book a table" --tag personal
printf '%s\n' '[{"text":"Read the proposal","tags":["work"]}]' | node examples/local-cli/src/cli.ts note import
```

Import checks every item before creating the store context. An invalid JSON value,
note shape or tag exits 2 and writes nothing. A valid batch is persisted in one
document update; this is not a guarantee against filesystem write failures.

Explore the input descriptions with `note import --help`.
[Input constraints](inputs.md) explains how descriptions, predicates and stdin shape
parsers are declared together.

## Keep dependencies explicit

The example context supplies the note store and settings store. Its implementation
accepts document storage and a clock; tests supply in-memory documents and a fixed
clock. Neither the command's placement nor its presentation determines the storage
implementation.

A context makes effectful code replaceable, but does not make it pure. Rules that
only inspect values can be ordinary functions; reading documents and persisting
changes stay in the surrounding execution code.

## Choose a handler style

The core accepts its own outcome values, synchronously or through a Promise. A
service that uses neverthrow can be connected with `fromNeverthrow` on that handler.
Importing the root module does not select an adapter for other commands.

A compatible typed failure can pass through the adapter. For a domain fault with a
different shape, provide an error mapper. This mapping describes the failure to the
caller; unexpected exceptions remain internal errors.

## Verify at both boundaries

In-memory tests exercise command behavior without writing files. Actual-process
tests exercise argument routing, output channels, exit status and persistence in an
isolated directory. Both are useful: a correct handler does not establish that the
executable routes inputs correctly or flushes its output before exiting.

```sh
pnpm typecheck
pnpm test
```

Continue with [Commands](commands.md), [Execution](execution.md),
[Adapters](adapters.md) or [Testing](testing.md) for the corresponding declarations
and boundaries.
