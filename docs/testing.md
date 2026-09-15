# Verify declarations and real invocations

English · [Korean](ko/testing.md) · [README](../README.md)

Test a decision where its inputs are controlled, and test process behavior at the
process boundary. A temporary home is useful for a stateful CLI, but is not a
requirement for every test or every command.

## Inject services into execution

```ts
import assert from "node:assert/strict";
import { application, authoring, completed, execute, output } from "cli-for-ai";

type Context = { count: () => number };
const { command } = authoring<Context>();
const app = application({
  name: "counter",
  version: "1.0.0",
  summary: "Count stored items",
  commands: {
    count: command({
      summary: "Count items",
      output: output<number>(),
      run: (_input, ctx) => completed(ctx.count()),
    }),
  },
});

let created = 0;
const context = () => { created++; return { count: () => 3 }; };
const invalid = await execute(app, ["count", "extra"], { context });
assert.equal(invalid.exitCode, 2);
assert.equal(created, 0);
const result = await execute(app, ["count"], { context });
assert.deepEqual(JSON.parse(result.stdout), { status: "completed", data: 3 });
```

The first assertion checks more than an error message: invalid input did not reach
the application's service factory. Apply the same approach to wrong state names
that can be validated without locating a target, and to conflicting options.

## Check the boundary that owns the behavior

| Boundary | Useful evidence |
| --- | --- |
| Pure function | Fixed inputs give the expected decision |
| `execute` | Parsing, result content, channels and effect counts for bounded outputs |
| `executeTo` | First output before source completion; no next record while a sink is blocked |
| Actual process | Exit status, argv forwarding, open stdin, signal cleanup, output flushing |
| Built package | Exports and type inference work outside the source tree |

For conditional stdin, keep the input pipe open and prove that a nonselected call
exits without waiting for EOF. For streams, control source and sink progress with
handshakes rather than timing guesses. Check that a failure can leave a prefix and
that the exit status does not falsely report completion.

The notebook tests use isolated `NOTEBOOK_HOME` directories for persistence and
in-memory document stores for logic. A CLI with no owned storage can inject service
responses instead. See [example tests](../examples/local-cli/test/notebook.test.ts)
and [process tests](../examples/local-cli/test/process.test.ts).

The [network example](../examples/network-cli/src/repo.ts) injects a fetch function;
its [tests](../examples/network-cli/test/repo.test.ts) use fake responses rather than
relying on an external service.

## Verify descriptions as well as code

Generated help and validated example arguments reduce drift, but authored field
annotations and workflow descriptions still need review. Check the output fields
that downstream commands use, and run representative workflows. Schema lint can
find missing summaries; it cannot establish that an AI finds the right command.

Repository checks use Node 24 or later:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
```

Typecheck and test build `dist` first.

## Exercise reusable input declarations

Compile representative consumers against the built `.d.ts`, including extracted
helpers and declarations that may be absent. Assert both valid narrowing and
rejection of unsafe field access. At runtime, verify that extra pre-delimiter
arguments do not create context or launch a child, while forwarded tokens remain
unchanged. Test omission and an explicit value equal to the default separately
when a rule uses `provided`. Check help's dependency-skipping behavior too.
