# Build your first CLI

English · [Korean](ko/getting-started.md) · [README](../README.md)

Use Node 24 or later. In your application directory, install the package and TypeScript tooling:

```sh
npm install cli-for-ai
npm install --save-dev typescript @types/node
```

## Declare and run a command

Create `cli.mts`:

```ts
import { application, command, completed, output } from "cli-for-ai";
import { run } from "cli-for-ai/node";

const greet = command({
  summary: "Greet someone",
  input: {
    positionals: [{ name: "name", summary: "Name to greet", required: true }],
  },
  output: output<string>({ summary: "Greeting text" }),
  examples: [{ summary: "Greet Ada", input: { name: "Ada" } }],
  run: ({ name }) => completed(`Hello, ${name}`),
  human: (greeting) => greeting,
});

const app = application({
  name: "hello",
  version: "1.0.0",
  summary: "A greeting CLI",
  commands: { greet },
});

await run(app, { context: () => ({}) });
```

The command declares inputs, output and execution together. The application gives it
an invocation path, and `run` connects it to Node's arguments, streams and signals.
This command needs no external services, so its context is empty.

Node runs this TypeScript file directly:

```sh
node cli.mts
node cli.mts greet --help
node cli.mts greet Ada
node cli.mts greet Ada --human
```

An empty invocation shows help. `greet --help` describes the required name and output.
`greet Ada` writes this successful result to stdout:

```json
{"status":"completed","data":"Hello, Ada"}
```

With `--human`, it prints `Hello, Ada`. The handler is the same in both modes.
`node cli.mts greet` reports the missing argument on stderr and exits 2 before
calling the handler. Check the exit status as well as the output.

## Check types

Node's TypeScript execution does not typecheck the program. Run the compiler separately:

```sh
npx tsc --noEmit --strict --module nodenext --target es2024 cli.mts
```

Use [output parsing](results.md#validate-and-describe-successful-data) when returned
data needs runtime validation. The `output<string>` declaration above supplies the
TypeScript contract; it does not validate an external service response.

## Extend the CLI

- [Commands](commands.md): assemble groups and reusable commands.
- [Inputs](inputs.md): validate options, select stdin and forward child arguments.
- [Results](results.md) and [payloads](payloads.md): return structured answers or stream data.
- [Execution](execution.md): inject services, handle cancellation and release resources.
- [Testing](testing.md): verify handlers and actual invocations.

The repository's [notebook example](notebook-example.md) demonstrates persistent
storage, configuration and JSONL export. To work on the framework itself, see
[Development](development.md).
