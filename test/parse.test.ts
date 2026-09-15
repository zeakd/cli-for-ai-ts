import { describe, expect, test } from "vitest";
import { application, command, completed, output, parseInvocation } from "../src/index.ts";
import { app } from "./fixture.ts";

const parse = (...argv: string[]) => parseInvocation(app, argv);
const input = (...argv: string[]) => {
  const inv = parse(...argv);
  if (inv.kind !== "run") throw new Error(`expected run, got ${JSON.stringify(inv)}`);
  return inv.input;
};
const fault = (...argv: string[]) => {
  const inv = parse(...argv);
  if (inv.kind !== "invalid") throw new Error(`expected invalid, got ${inv.kind}`);
  return inv.fault;
};

describe("routing", () => {
  test("bare application and --help are the same help", () => {
    expect(parse()).toEqual(parse("--help"));
    expect(parse()).toMatchObject({ kind: "help", path: [] });
  });

  test("bare groups at any depth are help, never execution", () => {
    expect(parse("jobs")).toEqual(parse("jobs", "--help"));
    expect(parse("jobs", "deep")).toMatchObject({ kind: "help", path: ["jobs", "deep"] });
    expect(parse("--help", "jobs")).toMatchObject({ kind: "help", path: ["jobs"] });
  });

  test("leaves at different depths execute", () => {
    expect(parse("jobs", "submit", "a")).toMatchObject({ kind: "run", path: ["jobs", "submit"] });
    expect(parse("jobs", "deep", "fail")).toMatchObject({ kind: "run", path: ["jobs", "deep", "fail"] });
  });

  test("unknown commands are refused with a suggestion, not substituted", () => {
    expect(fault("jobs", "submt")).toEqual({
      code: "UNKNOWN_COMMAND",
      message: "Unknown command: tool jobs submt",
      details: { input: "submt", allowed: ["submit", "deep"], suggestion: "submit" },
    });
    expect(fault("toString").code).toBe("UNKNOWN_COMMAND");
  });

  test("--version only at the root and alone", () => {
    expect(parse("--version")).toEqual({ kind: "version" });
    expect(fault("--version", "echo").code).toBe("INVALID_INPUT");
    expect(fault("jobs", "--version").code).toBe("INVALID_INPUT");
    expect(fault("echo", "x", "--version").code).toBe("INVALID_INPUT");
  });

  test("there is no built-in schema command", () => {
    expect(fault("schema").code).toBe("UNKNOWN_COMMAND");
    expect(fault("schema", "--help").code).toBe("UNKNOWN_COMMAND");
  });
});

describe("input", () => {
  test("positionals are named, defaults applied, flags false", () => {
    expect(input("echo", "a")).toEqual({
      first: "a", rest: [], count: 1, ratio: undefined, format: undefined, tag: [], title: undefined, loud: false,
    });
  });

  test("values, repeat, variadic, numbers and enums", () => {
    expect(input("echo", "a", "b", "c", "--count=3", "--ratio", "-0.5", "--format", "csv", "--tag", "x", "--tag=y", "--loud")).toMatchObject({
      first: "a", rest: ["b", "c"], count: 3, ratio: -0.5, format: "csv", tag: ["x", "y"], loud: true,
    });
  });

  test("a value starting like an option must be written inline; a separate option-shaped token is a missing value", () => {
    expect(input("echo", "a", "--title=--help")).toMatchObject({ title: "--help" });
    expect(input("echo", "a", "--title=--human")).toMatchObject({ title: "--human" });
    expect(parse("echo", "a", "--title=--human")).toMatchObject({ human: false });
    for (const next of ["--help", "--human", "--", "-x"]) {
      expect(fault("echo", "a", "--title", next)).toEqual({
        code: "INVALID_INPUT",
        message: 'Missing value: --title. To give a value that starts with "-", write --title=<value>',
        details: { input: "--title", expected: "string", hint: "--title=<value>" },
      });
    }
  });

  test("-- makes every following token positional", () => {
    expect(input("echo", "--", "--help", "-x", "--loud")).toMatchObject({ first: "--help", rest: ["-x", "--loud"], loud: false });
    expect(input("echo", "-", "-5")).toMatchObject({ first: "-", rest: ["-5"] });
  });

  test("invalid values name the input and allowed values", () => {
    expect(fault("echo", "a", "--format", "yaml")).toEqual({
      code: "INVALID_INPUT",
      message: "Invalid value: --format yaml",
      details: { input: "--format", received: "yaml", expected: "json|csv", allowed: ["json", "csv"] },
    });
    expect(fault("echo", "a", "--count", "4").details).toMatchObject({ expected: "integer 1..3" });
    expect(fault("echo", "a", "--count", "1.5").message).toBe("Invalid value: --count 1.5");
    expect(fault("echo", "a", "--ratio", "").message).toBe("Invalid value: --ratio ");
    expect(fault("echo", "a", "--ratio", "abc").code).toBe("INVALID_INPUT");
  });

  test("numeric arguments accept only the documented syntax", () => {
    expect(input("echo", "a", "--ratio", "2e3", "--count", "3")).toMatchObject({ ratio: 2000, count: 3 });
    expect(input("echo", "-7")).toMatchObject({ first: "-7" });
    for (const spelling of ["0x10", "0b11", " 5", "+1", "Infinity", "1.", ".5", "01.5", "1_000"]) {
      expect(fault("echo", "a", "--ratio", spelling).details, spelling).toMatchObject({ syntax: "json-number" });
    }
    for (const spelling of ["1e0", "2.0", "0x2", "9007199254740993"]) {
      expect(fault("echo", "a", "--count", spelling).message, spelling).toBe(`Invalid value: --count ${spelling}`);
    }
  });

  test("unknown, missing, duplicated and excess input are errors", () => {
    expect(fault("echo", "a", "--colour")).toMatchObject({ message: "Unknown option: --colour" });
    expect(fault("echo", "a", "--titel", "x").details).toMatchObject({ suggestion: "--title" });
    expect(fault("echo", "a", "-x").message).toBe("Unknown option: -x");
    expect(fault("echo").message).toBe("Missing argument: <first>");
    expect(fault("echo", "a", "--title").message).toBe("Missing value: --title");
    expect(fault("echo", "a", "--title", "x", "--title", "y").message).toBe("--title was given more than once");
    expect(fault("echo", "a", "--loud=yes").message).toBe("--loud does not take a value");
    expect(fault("echo", "a", "--help=1").message).toBe("--help does not take a value");
    expect(fault("jobs", "submit", "a", "b").message).toBe("Unexpected argument: b");
    expect(fault("jobs", "deep", "fail", "extra").message).toBe("Unexpected argument: extra");
    expect(fault("echo", "a", "--constructor", "x").message).toBe("Unknown option: --constructor");
  });

  test("help validates supplied input but allows omitted required input", () => {
    expect(parse("echo", "--help")).toMatchObject({ kind: "help", path: ["echo"] });
    expect(parse("echo", "--count", "2", "--help")).toMatchObject({ kind: "help" });
    expect(fault("echo", "--count", "9", "--help").message).toBe("Invalid value: --count 9");
    expect(fault("echo", "--bogus", "--help").message).toBe("Unknown option: --bogus");
    expect(parse("read", "--help")).toMatchObject({ kind: "help" });
  });
});

describe("prototype-named inputs", () => {
  const target = application({
    name: "t",
    version: "1",
    summary: "t",
    commands: {
      x: command({
        summary: "x",
        input: {
          positionals: [{ name: "valueof", summary: "v" }],
          options: { constructor: { summary: "c" }, "to-string": { summary: "s", repeat: true }, hasownproperty: { summary: "h", type: "boolean" } },
        },
        output: output<null>(),
        run: () => completed(null),
      }),
    },
  });
  const run = (...argv: string[]) => parseInvocation(target, ["x", ...argv]);

  test("declared names work and never read inherited values", () => {
    expect(run("--constructor", "c1")).toMatchObject({ kind: "run", input: { constructor: "c1" } });
    const omitted = run();
    if (omitted.kind !== "run") throw new Error(omitted.kind);
    expect(Object.hasOwn(omitted.input, "constructor")).toBe(true);
    expect(omitted.input.constructor).toBeUndefined();
    expect(omitted.input).toMatchObject({ "to-string": [], hasownproperty: false, valueof: undefined });
    expect(run("--constructor", "a", "--constructor", "b")).toMatchObject({ kind: "invalid", fault: { message: "--constructor was given more than once" } });
    expect(run("--hasownproperty", "--hasownproperty")).toMatchObject({ kind: "invalid" });
  });

  test("undeclared prototype names are unknown", () => {
    const target2 = application({ name: "u", version: "1", summary: "u", commands: { x: command({ summary: "x", output: output<null>(), run: () => completed(null) }) } });
    expect(parseInvocation(target2, ["x", "--constructor", "v"])).toMatchObject({ kind: "invalid", fault: { message: "Unknown option: --constructor" } });
    expect(parseInvocation(target2, ["__proto__"])).toMatchObject({ kind: "invalid", fault: { code: "UNKNOWN_COMMAND" } });
  });
});
