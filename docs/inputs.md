# Declare inputs and constraints

English · [Korean](ko/inputs.md) · [README](../README.md)

A command's input declaration determines how argv is parsed and what its help
describes. Unknown options, missing required values and rejected inputs stop
execution before the context is created. Commands that read stdin validate argv
first, then read and check stdin, then create the context.

## Argument grammar

Unknown commands and options, missing required values, duplicate non-repeat options
and extra positionals fail before the handler runs. Only a declared variadic
positional consumes multiple remaining values. `read a b` does not silently discard
`b` when the command declares one positional.

Long options accept `--name value` or `--name=value`. If the next token looks
like an option, parsing fails with a missing-value error. Use `--name=--cwd` to
pass `--cwd` as text. This prevents a missing value from consuming the next option.
A lone `-` and negative JSON-number tokens such as `-3` and `-1e3` remain values.
Tokens such as `-draft`, `-01` and `-3abc` need inline option syntax, or `--`
before them when used as ordinary positionals. Integer validation still accepts
signed decimal digits: `--count=-01` passes the value `-01` to that validation.
`--` ends option parsing unless the command declares a forwarded argument list. Short options and bundles are not supported. JSON is the ordinary
default; `--human` selects presentation, and there is no built-in `--json` flag.

Use `values` for an enum, `pattern` or a described `check` for domain syntax. A
locally known state-name rule belongs here, before context construction and target
lookup. Rules requiring remote facts belong in execution. Numeric values use JSON
number syntax; integers use signed decimal digits and must be safe integers.

## Check individual values

Use the built-in type, enum and range declarations for ordinary constraints. For a
string format, `pattern` publishes a regular expression and a description. Patterns
use JavaScript Unicode regular expressions and must match the whole value; their
semantics differ from JSON Schema's unanchored `pattern` keyword.

A custom predicate can express a rule that is clearer in code:

```ts
import { check, command, completed, output } from "cli-for-ai";

const tag = command({
  summary: "Check a tag",
  input: {
    positionals: [{
      name: "tag",
      summary: "Tag to check",
      required: true,
      check: check.string("not empty or only whitespace", (value) => value.trim() !== ""),
    }],
  },
  output: output<string>(),
  run: ({ tag }) => completed(tag),
});
```

`check.string` gives the predicate a string; `check.number` gives it a number.
Repeated options and variadic positionals check each element. Predicates must be
synchronous and return a boolean. A false result is an input error; a thrown error
or an invalid return value is an internal error.

Help displays the description. The programmatic `applicationSchema(app)` API marks
the check as custom and includes the same description; it does not translate the
function into a JSON Schema predicate.
Rejected custom checks identify the input and expected rule without automatically
copying the received value into the error.

## Check related inputs

Declare a rule's dependencies explicitly. The `constraints` factory binds those
names and the callback's value types to this command's inputs:

```ts
const range = command({
  summary: "Select an inclusive range",
  input: {
    options: {
      from: { summary: "First index", type: "integer", required: true },
      to: { summary: "Last index", type: "integer", required: true },
    },
  },
  constraints: (rule) => [
    rule(["from", "to"], "from must not exceed to", ({ from, to }) =>
      from <= to ? undefined : "The first index exceeds the last index"),
  ],
  output: output<{ from: number; to: number }>(),
  run: ({ from, to }) => completed({ from, to }),
});
```

A rule returns `undefined` when the inputs are valid, or a public explanation when
they are invalid. A returned explanation is an input rejection (exit 2); a thrown
error or a result other than a string or undefined is an internal error (exit 70). It receives only its named dependencies. Those values, including
arrays, are read-only; a validation rule cannot change what the handler receives.
Optional inputs remain optional inside the callback. Listing a dependency does not
make it required.

During execution, rules inspect the final parsed inputs, including defaults. During
help, a rule runs only when all its dependencies were explicitly supplied. This
allows `range --help` to describe a command without requiring its execution inputs,
while `range --from 8 --to 3 --help` still rejects the invalid range. A default does
not count as an explicitly supplied value.

Help lists the rule's dependencies and description, as does the programmatic schema.
Keep public reasons
focused on how to correct the invocation; avoid including credentials or raw service
responses in them.

Mutual exclusion between application options can use the same rule factory:

```ts
const send = command({
  summary: "Select how to send input",
  input: {
    options: {
      keys: { summary: "Send literal key presses", type: "boolean" },
      wait: { summary: "Wait for the reply", type: "boolean" },
    },
  },
  constraints: (rule) => [
    rule(["keys", "wait"], "keys and wait cannot be combined", ({ keys, wait }) =>
      keys && wait ? "Choose either --keys or --wait" : undefined),
  ],
  output: output<null>(),
  run: () => completed(null),
});
```

This example checks the option combination without sending anything. A real handler
would perform the operation after validation. Rules cannot refer to framework
`--human` as a declared input.

### Distinguish a default from an explicit value

The callback's second argument provides `provided(name)`. It accepts only names in
the rule's dependency list. An explicit value counts as provided even if it equals
the default:

```ts
const waitForReply = command({
  summary: "Choose how long to wait",
  input: { options: {
    wait: { summary: "Wait for a reply", type: "boolean" },
    timeout: { summary: "Wait seconds", type: "integer", min: 1, default: 30 },
  } },
  constraints: (rule) => [
    rule(["timeout", "wait"], "Explicit timeout requires --wait",
      ({ wait }, { provided }) => provided("timeout") && !wait
        ? "Use --wait with --timeout" : undefined),
  ],
  output: output<number>(),
  run: ({ timeout }) => completed(timeout),
});
```

`--timeout 30` fails; `--wait` uses 30 without marking timeout as supplied.
Help still runs a rule only when every dependency was explicitly supplied, so
`--timeout 30 --help` skips this rule. A shared rule should be a factory function
that receives each command's `ConstraintFactory<A>` and builds a new rule there;
do not reuse an already-built rule from another command.

## Check stdin before creating the context

A JSON declaration first checks that stdin is valid JSON. An optional shape parser
checks the resulting value and can normalize it for the handler:

```ts
const count = command({
  summary: "Count names read from stdin",
  input: {
    stdin: {
      format: "json",
      summary: "A JSON array of names",
      shape: {
        description: "an array containing only strings",
        parse(value: unknown) {
          if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
            return { ok: false as const, reason: "Expected an array of names" };
          }
          return { ok: true as const, value: value as string[] };
        },
      },
    },
  },
  output: output<number>(),
  run: ({ stdin }) => completed(stdin.length),
});
```

The handler's stdin type comes from the parser's successful value. Invalid JSON or
an explicit shape rejection exits 2 before context construction. A parser that
throws or returns a malformed result produces an internal error with exit 70.
Help describes stdin without reading it or running the shape parser.

The [notebook import command](../examples/local-cli/src/commands/notes.ts) checks the
whole batch, including each tag, before accessing the store. Its store then writes
one document. This prevents invalid input from producing a partially imported batch;
it does not guarantee that a filesystem write can never fail partway through.

## Select when stdin is read

A stdin declaration without `when` reads on every execution. Add a condition when
an argument selects stdin:

```ts
const select = command({
  summary: "Select session IDs",
  input: {
    positionals: [{
      name: "id",
      summary: "Session ID, or - to read IDs from stdin",
      required: true,
    }],
    stdin: {
      when: { input: "id", equals: "-" },
      format: "text",
      summary: "Session IDs, one per line; blank lines are ignored",
    },
  },
  output: output<string[]>(),
  run: ({ id, stdin }) => completed(
    stdin === undefined
      ? [id]
      : stdin.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  ),
});
```

`when.input` names a declared scalar positional or option. For an option named
`input-file`, use `when: { input: "input-file", equals: "-" }`. This selects stdin;
it does not make the framework load other values as file paths.

The condition compares the parsed value after defaults and argument constraints,
without coercion. A default of `"-"` therefore selects stdin even when the argument
is omitted. An omitted non-boolean argument without a default has no value and
does not match. Boolean options can be compared to `true` or `false`; repeated options and variadic positionals cannot select stdin.
Unknown input names, incompatible comparison types and values outside a declared
enum are rejected when the command is declared. The condition does not prove that
the value can pass every pattern, custom check or cross-input rule. These checks
run on actual argv, not additionally on the selector constant. If `"-"` selects
stdin, make sure the input's pattern or check also permits `"-"`.

When the condition does not match, neither the reader nor the shape parser runs,
and the `stdin` key is absent (reading it gives `undefined`). An open input pipe does not delay that invocation.
When it matches, the runner reads to EOF, decodes and checks the input, then creates
the context. Empty text is `""`, not `undefined`; use a shape parser if empty input
must be rejected. Conditional text or shape-validated stdin has an optional
handler property, `stdin?: T`. Raw JSON remains `unknown` until validated or narrowed.

Help and the programmatic schema describe the selection condition. Help never
reads stdin, even when the supplied arguments select it. Selected stdin is still
read in full; the condition does not introduce streaming input.

### Share a stdin declaration

For a declaration stored outside the command, preserve its literal condition name:

```ts
import type { StdinDecl } from "cli-for-ai";

const sessionStdin = {
  summary: "Session IDs, one per line",
  format: "text",
  when: { input: "scope", equals: "-" },
} as const satisfies StdinDecl;
```

Mount this declaration on a command with a scalar `scope` input. A broad
`: StdinDecl` annotation erases the name needed to check that the condition refers
to that command's input, so it is rejected when composing the command. Use
`as const satisfies StdinDecl` for shared conditional declarations. For an
unconditional declaration, `satisfies StdinDecl` alone preserves the format.

The same applies to a whole input declaration annotated `: InputDecl`, even if
its current value has no stdin. That broad type permits a conditional stdin with
an unknown input name, so the compiler cannot prove the declaration is safe to
compose. This is a source compatibility change for broadly annotated declarations.
Preserve the actual keys and literals instead:

```ts
import type { InputDecl } from "cli-for-ai";

const sessionInput = {
  positionals: [{ name: "scope", summary: "Session scope", required: true }],
} as const satisfies InputDecl;
```

Pass `sessionInput` as the command's `input`. Inline declarations need no extra
annotation. The condition diagnostic can refer to `stdin.when` even when the
current value omits stdin, because it checks what the declared type permits.

## Keep checks deterministic

Checks inspect supplied values. They do not access the network, load configuration
or query application services. Those operations belong in the context and handler,
where failures describe execution rather than malformed input.

`parseInvocation` applies the same argv checks used by `execute`. It can return an
`internal` invocation when a check itself fails. Its raw cause is diagnostic data;
`execute` reports a fixed public message and passes the original cause only to an
explicit `onDiagnostic` callback.

## Forward arguments to another program

Declare `input.forward` for a separate child argument list:

```ts
const preview = command({
  summary: "Preview arguments for a child program",
  input: {
    positionals: [{ name: "program", summary: "Program name", required: true }],
    forward: { name: "args", summary: "Arguments passed to the child" },
  },
  output: output<{ program: string; args: string[] }>(),
  examples: [{ summary: "Pass child options", input: { program: "worker", args: ["--model", "small"] } }],
  run: ({ program, args }) => completed({ program, args }),
});
```

With this command mounted as `tool preview`, use
`tool preview worker -- --model small`. Own arguments must precede the first
`--`; all later tokens remain unchanged, including empty strings, another `--`
and flags such as `--help`. An extra argument before the delimiter fails with
exit 2 before context or child launch. This example only returns the arguments;
it does not launch a process.

No delimiter gives `args: []`. A bare delimiter also gives an empty array but
counts as explicitly provided to constraints. A command cannot combine forward
with a variadic positional. Its own positionals cannot use option-shaped values,
because its `--` belongs to the child list; lone `-` and negative JSON numbers
remain expressible. Examples are checked against the same boundary.

Forwarding does not give a child ownership of the CLI's stdout or stderr. Capture
or adapt child output into the declared result or payload. The host still owns
output framing, backpressure and failure reporting.

## Preserve types when sharing declarations

Inline objects remain sufficient. Optional helpers preserve literal types when
extracting declarations into variables:

```ts
import { integer, positional, stdinText, string } from "cli-for-ai";

const limit = integer({ summary: "Maximum items", min: 1, default: 20 });
const scope = positional("scope", string({ summary: "Session scope", required: true }));
const ids = stdinText({
  summary: "Session IDs, one per line",
  when: { input: "scope", equals: "-" },
});

const sharedInput = { positionals: [scope], options: { limit }, stdin: ids };
```

Pass `sharedInput` to `command`. `string`, `number`, `integer`, `flag`,
`positional`, `stdinText` and `stdinJson` return ordinary declarations and use
the same command validation. `string({ values, default })` also checks an enum
default at compile time. Raw objects still check that default at construction.
Helpers reject accessors, symbol keys, non-enumerable properties and non-plain
objects rather than silently copying or dropping them.

Types reflect every possible declaration. If a positional tuple or the whole
input can be absent, a handler must narrow before accessing its fields, for
example with `"scope" in input`. Selectors and constraints can only rely on names
guaranteed across alternatives. Broad value declarations yield unions rather
than pretending to be strings. Some optional or union declaration errors are
reported only at construction; TypeScript is not a substitute for that check.
Examples for a union are checked against the actual declaration at application
construction and can be rejected even if they passed the static union type.

For names assembled at runtime, use [dynamicCommand](commands.md#declare-input-names-at-runtime).
