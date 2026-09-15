# cli-for-ai

English · [Korean](README.ko.md)

Build CLIs that AI agents can discover, call and feed results into the next command.
Declare inputs, execution and output together so help and validation stay aligned
as commands change. The same declarations are intended to be readable and maintainable
by the agents building the tool.

Ordinary results use JSON by default; payload commands can stream records directly
to other programs. Services arrive through an injected context, so a command can
be tested without starting a process or creating a home directory. The design
rationale lives in [cli-for-ai-guide](https://github.com/zeakd/cli-for-ai-guide).

## Declare a command and see its behavior

```ts
import { application, command, completed, output } from "cli-for-ai";
import { run } from "cli-for-ai/node";

const greet = command({
  summary: "Greet someone",
  input: {
    positionals: [{ name: "name", summary: "Name to greet", required: true }],
  },
  output: output({
    summary: "A greeting",
    fields: [{ path: "data", summary: "Greeting text" }],
    parse(value: unknown) {
      if (typeof value !== "string") throw new TypeError("Expected a greeting");
      return value;
    },
  }),
  examples: [{ summary: "Greet Ada", input: { name: "Ada" } }],
  run: ({ name }) => completed(`Hello, ${name}`),
  human: (greeting) => greeting,
});

const app = application({
  name: "hello",
  version: "1.0.0",
  summary: "A small greeting CLI",
  commands: { greet },
});

await run(app, { context: () => ({}) });
```

An ordinary call returns a JSON result:

```json
{"status":"completed","data":"Hello, Ada"}
```

`hello greet Ada --human` prints `Hello, Ada`. Both forms execute the same handler.
`hello` and `hello --help` show the same top-level help. `hello greet` reports the
missing argument without running the handler.

The opening of the generated root help comes from the same declaration:

```text
hello 1.0.0 — A small greeting CLI

Usage:
  hello <command> [options]

Commands:
  greet  Greet someone
```

## Install

Use Node 24 or later:

```sh
npm install cli-for-ai
```

For TypeScript, install `typescript` and `@types/node` as development dependencies.
Follow [Build your first CLI](docs/getting-started.md) to create and run `cli.mts`.
Framework development and repository examples are covered in [Development](docs/development.md).

## Documentation

| Task | Read |
| --- | --- |
| Arrange commands and their help | [Commands](docs/commands.md) |
| Validate arguments, forward child arguments and select stdin | [Inputs](docs/inputs.md) |
| Report states, errors and human output | [Results](docs/results.md) |
| Stream JSONL or text to a pipe | [Payloads](docs/payloads.md) |
| Inject services, cancel and clean up | [Execution](docs/execution.md) |
| Test handlers and real invocations | [Testing](docs/testing.md) |
| Use neverthrow or Effect | [Adapters](docs/adapters.md) |
| Look up APIs and defaults | [Reference](docs/reference.md) |

See [Implementation scope](docs/scope.md) for supported behavior and limits.
[Local](examples/local-cli) and [network](examples/network-cli) examples contain
executable commands and tests. Development checks are in [Testing](docs/testing.md).

License: [MIT](LICENSE).
