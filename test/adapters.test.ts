import { resultJson } from "./support/result-json.ts";
import { Context, Effect } from "effect";
import { errAsync, okAsync, err, ok } from "neverthrow";
import { describe, expect, test } from "vitest";
import { fromEffect } from "../src/adapters/effect.ts";
import { fromNeverthrow } from "../src/adapters/neverthrow.ts";
import { application, authoring, execute, output, type Handler } from "../src/index.ts";

interface Ctx {
  base: number;
}
const { command } = authoring<Ctx>();
type DomainError = { reason: "too-big"; limit: number };

const appWith = (run: Handler<{ n: number }, Ctx, number>) =>
  application({
    name: "t",
    version: "1",
    summary: "t",
    commands: {
      x: command({
        summary: "x",
        input: { positionals: [{ name: "n", summary: "n", type: "integer", required: true }] },
        output: output<number>(),
        run,
      }),
    },
  });

const call = (target: ReturnType<typeof appWith>, n = "1", signal?: AbortSignal) =>
  execute(target, ["x", n], { context: () => ({ base: 10 }), ...(signal ? { signal } : {}) });

describe("fromNeverthrow", () => {
  test("Ok becomes completed; Result and ResultAsync share the wrapper", async () => {
    expect(JSON.parse((await call(appWith(fromNeverthrow((i, c) => ok(i.n + c.base))))).stdout)).toEqual({ status: "completed", data: 11 });
    expect(JSON.parse((await call(appWith(fromNeverthrow((i, c) => okAsync(i.n * c.base))))).stdout).data).toBe(10);
  });

  test("Err maps through the explicit mapper, or passes through when already a Fault", async () => {
    const mapped = appWith(
      fromNeverthrow((i) => (i.n > 5 ? err<number, DomainError>({ reason: "too-big", limit: 5 }) : ok(i.n)), {
        error: (e) => ({ code: "TOO_BIG", message: `limit ${e.limit}`, details: { limit: e.limit } }),
      }),
    );
    const r = await call(mapped, "9");
    expect(r.exitCode).toBe(1);
    expect(resultJson(r).error).toEqual({ code: "TOO_BIG", message: "limit 5", details: { limit: 5 } });

    const direct = appWith(fromNeverthrow(() => errAsync({ code: "NOPE", message: "no" })));
    expect(resultJson(await call(direct)).error).toEqual({ code: "NOPE", message: "no" });
  });

  test("throws, rejections and mapper defects are internal errors", async () => {
    const cases = [
      appWith(fromNeverthrow(() => { throw new Error("bug"); })),
      appWith(fromNeverthrow(() => okAsync(1).andThen(() => { throw new Error("bug"); }))),
      appWith(fromNeverthrow(() => err<number, DomainError>({ reason: "too-big", limit: 1 }), { error: () => { throw new Error("mapper bug"); } })),
    ];
    for (const target of cases) expect((await call(target)).exitCode).toBe(70);
  });
});

describe("fromEffect", () => {
  test("success and typed failure", async () => {
    expect(JSON.parse((await call(appWith(fromEffect((i, c) => Effect.succeed(i.n + c.base))))).stdout).data).toBe(11);
    const failing = appWith(
      fromEffect(() => Effect.fail<DomainError>({ reason: "too-big", limit: 3 }), {
        error: (e) => ({ code: "TOO_BIG", message: `limit ${e.limit}` }),
      }),
    );
    const r = await call(failing);
    expect(r.exitCode).toBe(1);
    expect(resultJson(r).error).toEqual({ code: "TOO_BIG", message: "limit 3" });
  });

  test("a service can be provided from the command context", async () => {
    class Base extends Context.Tag("Base")<Base, number>() {}
    const target = appWith(fromEffect((i, c) => Effect.map(Base, (base) => base + i.n).pipe(Effect.provideService(Base, c.base))));
    expect(JSON.parse((await call(target, "5")).stdout).data).toBe(15);
  });

  test("internal interruption without caller cancellation is not reported as INTERRUPTED", async () => {
    const r = await call(appWith(fromEffect(() => Effect.interrupt)));
    expect(r.exitCode).toBe(70);
    expect(resultJson(r).error.code).toBe("INTERNAL_ERROR");
  });

  test("pre-cancelled execution never calls the source handler", async () => {
    let called = false;
    const controller = new AbortController();
    controller.abort();
    const target = appWith(
      fromEffect(() => {
        called = true;
        return Effect.succeed(1);
      }),
    );
    expect((await call(target, "1", controller.signal)).exitCode).toBe(130);
    expect(called).toBe(false);
  });

  test("execution stays pending until a gated finalizer completes, for success, failure and abort", async () => {
    for (const mode of ["success", "failure", "abort"] as const) {
      let enter!: () => void;
      let begin!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => (enter = resolve));
      const begun = new Promise<void>((resolve) => (begin = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const controller = new AbortController();
      let settled = false;
      let released = false;
      const target = appWith(
        fromEffect(() =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(Effect.sync(enter), () =>
                Effect.promise(async () => {
                  begin();
                  await gate;
                  released = true;
                }),
              );
              if (mode === "abort") return yield* Effect.never;
              if (mode === "failure") return yield* Effect.fail({ code: "OFFLINE", message: "offline" });
              return 1;
            }),
          ),
        ),
      );
      const pending = call(target, "1", controller.signal);
      void pending.then(() => (settled = true));
      await entered;
      if (mode === "abort") controller.abort();
      await begun;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled, mode).toBe(false);
      expect(released, mode).toBe(false);
      release();
      const r = await pending;
      expect(released, mode).toBe(true);
      expect(r.exitCode, mode).toBe({ success: 0, failure: 1, abort: 130 }[mode]);
    }
  });

  test("defects and finalizer failures are internal errors, not typed failures", async () => {
    const defect = appWith(fromEffect(() => Effect.die(new Error("defect"))));
    const seen: { cause: unknown }[] = [];
    const d = await execute(defect, ["x", "1"], { context: () => ({ base: 10 }), onDiagnostic: (x) => seen.push(x) });
    expect(d.exitCode).toBe(70);
    expect(String((seen[0]!.cause as Error).cause)).toContain("defect");

    let mapped = false;
    const finalizer = appWith(
      fromEffect(
        () =>
          Effect.scoped(
            Effect.acquireRelease(Effect.succeed(1), () => Effect.die(new Error("finalizer defect"))).pipe(
              Effect.flatMap(() => Effect.fail<DomainError>({ reason: "too-big", limit: 1 })),
            ),
          ),
        {
          error: () => {
            mapped = true;
            return { code: "TOO_BIG", message: "typed" };
          },
        },
      ),
    );
    const f = await execute(finalizer, ["x", "1"], { context: () => ({ base: 10 }), onDiagnostic: (x) => seen.push(x) });
    expect(f.exitCode).toBe(70);
    expect(mapped).toBe(false);
    expect(String((seen[1]!.cause as Error).message)).toContain("finalizer defect");
  });

  test("aborting interrupts the effect, runs finalizers and reports INTERRUPTED", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const target = appWith(
      fromEffect(() =>
        Effect.scoped(
          Effect.acquireRelease(
            Effect.sync(() => events.push("acquired")),
            () => Effect.sync(() => events.push("released")),
          ).pipe(
            Effect.tap(() => Effect.sync(() => setTimeout(() => controller.abort(), 5))),
            Effect.flatMap(() => Effect.never),
          ),
        ),
      ),
    );
    const r = await call(target, "1", controller.signal);
    expect(r.exitCode).toBe(130);
    expect(resultJson(r).error.code).toBe("INTERRUPTED");
    expect(events).toEqual(["acquired", "released"]);
  });
});
