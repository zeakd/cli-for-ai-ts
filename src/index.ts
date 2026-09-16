// cli-for-ai — the root export. Declarations, parsing, routing, results
// (core) and help/schema (discovery) are deterministic. execute orchestrates an
// execution without a process but is not pure: it calls the context factory,
// stdin reader and handlers it is given. Node process execution lives in
// cli-for-ai/node; handler adapters in cli-for-ai/neverthrow and
// cli-for-ai/effect are not re-exported. Nothing here imports Node APIs.

export { application } from "./application.ts";
export type { ContextCheck } from "./application.ts";

export { authoring, command, dynamicCommand, group, output, AuthoringError } from "./core/command.ts";
export { flag, integer, number, positional, stdinJson, stdinText, string } from "./core/helpers.ts";
export type {
  AnyCommand,
  Authoring,
  CommandFactory,
  Command,
  DynamicCommand,
  DynamicCommandSpec,
  DynamicInput,
  FramingCheck,
  PayloadCommand,
  PayloadCommandSpec,
  CommandSpec,
  ContextOf,
  Example,
  Execution,
  Group,
  GroupSpec,
  Handler,
  OutputDecl,
  OutputField,
  OutputOptions,
  Tree,
} from "./core/command.ts";

export { check } from "./core/constraints.ts";
export type { Constraint, ConstraintFacts, ConstraintFactory, PatternDecl, ValueCheck } from "./core/constraints.ts";
export { RESERVED_OPTIONS } from "./core/input.ts";
export type {
  ArgsOf,
  ExampleInputOf,
  InputDeclCheck,
  ShapeResult,
  StdinShape,
  FlagOptionDecl,
  ForwardDecl,
  InputDecl,
  InputOf,
  OptionDecl,
  PositionalDecl,
  StdinCondition,
  StdinDecl,
  ValueOptionDecl,
  ValueType,
} from "./core/input.ts";

export { accepted, completed, failed, isFault, isOutcome } from "./core/result.ts";
export type { Fault, Outcome } from "./core/result.ts";

export { parseInvocation } from "./core/parse.ts";
export type { Application, ApplicationSpec, ApplicationView, Invocation, Node } from "./core/parse.ts";

export { renderHelp, usage } from "./discovery/help.ts";
export { applicationSchema, GLOBAL_OPTIONS } from "./discovery/schema.ts";
export type { ApplicationSchema, CommandSchema, GlobalOptionSchema, GroupSchema, OptionScope, OrdinaryCommandSchema, PayloadCommandSchema, PayloadSchema, ValueSchema } from "./discovery/schema.ts";

export { execute, executeTo, EXIT_CODES, OutputClosedError } from "./execution/execute.ts";
export type { Completion, Diagnostic, ExecuteOptions, ExecuteToOptions, ExitKind, PayloadFacts, Rendered, Sink } from "./execution/execute.ts";
export { DEFAULT_MAX_RECORD_BYTES, payload, records, stop } from "./core/payload.ts";
export type { JsonlPayload, PayloadDecl, Records, RecordOf, Stop, TextFraming, TextPayload } from "./core/payload.ts";

export type { ReaderClose } from "./core/payload.ts";
