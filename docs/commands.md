# Declare and arrange commands

English · [Korean](ko/commands.md) · [README](../README.md)

A command defines accepted input, output and execution. Its name in the application
chooses the invocation path. This lets one definition appear at different paths
without rewriting its examples.

```ts
import { application, command, completed, group, output } from "cli-for-ai";

const count = command({
  summary: "Count items",
  input: { options: { limit: { summary: "Maximum items", type: "integer", min: 1, default: 20 } } },
  output: output<number>({ summary: "Number of items selected" }),
  examples: [{ summary: "Select at most five items", input: { limit: 5 } }],
  run: ({ limit }) => completed(limit),
});

const app = application({
  name: "sample",
  version: "1.0.0",
  summary: "Demonstrate command placement",
  commands: { count, items: group({ summary: "Item operations", commands: { count } }) },
});
```

This illustrative command returns its limit; a real query would use a service
through the [execution context](execution.md). Its two paths are `sample count`
and `sample items count`. The example is rendered with the mounted path, including
`sample items count --limit 5` in the nested command's help.

## Discovery follows the tree

An application or group invoked without a command shows the same help as `--help`.
A leaf executes when its input permits it. Groups do not execute a default child,
and unknown commands fail with a suggestion when a close name is available.
Suggestions are not executed automatically.

`--help` validates supplied arguments without requiring omitted execution inputs.
It does not read stdin, create a context or call a handler. Command help includes
input and output descriptions; root help describes common result states and exit
codes. Command help links back to root help with a runnable invocation.
[Results](results.md) explains those contracts.

## Keep declarations and examples together

Examples contain typed input values, not shell command strings. The application
constructs an invocation and checks that values survive parsing and declared
constraints. Examples do not supply stdin, and verification does not execute the
handler. A valid example invocation is not proof that its described workflow works.

Declarations are copied and frozen; changing the original object later does not
reconfigure the command. Invalid declarations raise `AuthoringError` during
construction. Shared inputs should preserve literal types as described in
[Inputs](inputs.md#share-a-stdin-declaration).

Put command declarations near their handlers and associated usage knowledge. The
framework currently generates help and example invocations, while authored task skills remain
application work; see [Scope](scope.md).

## Declare input names at runtime

Use `command` when input names are known to TypeScript. For declarations assembled
from configuration or plugin metadata, use `dynamicCommand`:

```ts
import { completed, dynamicCommand, output, type OptionDecl } from "cli-for-ai";

function buildInspector(options: Record<string, OptionDecl>) {
  return dynamicCommand({
    summary: "Inspect a configured label",
    input: { options },
    output: output<string>(),
    run: (input) => completed(typeof input.label === "string" ? input.label : "unlabelled"),
  });
}
```

Its handler receives `Readonly<Record<string, unknown>>`; narrow values before
using them. A broad `Record<string, OptionDecl>` cannot give a static handler
literal field names and belongs on this boundary. Context and output stay typed.
The same snapshot, declaration validation, parsing, help and example checks
apply. Stdin, constraints and payload output remain available; dynamic means
unknown static inputs, not unchecked execution.

Unknown declaration keys fail at construction. Getters are not executed, and
non-enumerable or symbol properties are rejected. Reuse plain declarations or
the [input helpers](inputs.md#preserve-types-when-sharing-declarations).
