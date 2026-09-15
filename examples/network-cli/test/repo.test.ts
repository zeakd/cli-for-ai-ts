import { resultJson } from "../../../test/support/result-json.ts";
import { applicationSchema, execute, type CommandSchema, type GroupSchema } from "cli-for-ai";
import { expect, test } from "vitest";
import { ghLite, type Context } from "../src/repo.ts";

// Injected fetch → no real network.
type Fake = (url: string, init: RequestInit) => Promise<Response>;

function run(argv: string[], fake: Fake, signal?: AbortSignal) {
  const urls: string[] = [];
  const context: Context = {
    fetch: ((url: string, init: RequestInit) => {
      urls.push(url);
      return fake(url, init);
    }) as unknown as typeof fetch,
  };
  return execute(ghLite, argv, { context: () => context, ...(signal ? { signal } : {}) }).then((r) => ({
    ...r,
    urls,
    json: r.exitCode !== 0 || r.stdout.startsWith("{") ? resultJson(r) : undefined,
  }));
}

const respond = (status: number, body: string, headers: Record<string, string> = {}): Fake => async () => new Response(body, { status, headers });
const repoBody = JSON.stringify({ full_name: "octocat/Hello-World", stargazers_count: 42, description: "hi" });

test("200 maps the payload to the projected shape", async () => {
  const r = await run(["repo", "get", "octocat/Hello-World"], respond(200, repoBody));
  expect(r.exitCode).toBe(0);
  expect(r.json).toEqual({ status: "completed", data: { name: "octocat/Hello-World", stars: 42, description: "hi" } });
  expect(r.urls).toEqual(["https://api.github.com/repos/octocat/Hello-World"]);
});

test.each(["../users/x", "a/b?x=1", "a/b/c", "a/..", "a", "-a/b", "a/b#c", "a/%2e%2e"])("slug %j is invalid input and nothing is fetched", async (slug) => {
  const r = await run(["repo", "get", slug], respond(200, repoBody));
  expect(r.exitCode).toBe(2);
  expect(r.json.error.code).toBe("INVALID_INPUT");
  expect(r.urls).toEqual([]);
});

test("help rejects a supplied slug that breaks the pattern, and schema publishes it", async () => {
  expect((await run(["repo", "get", "../users/x", "--help"], respond(200, repoBody))).exitCode).toBe(2);
  expect((await run(["repo", "get", "--help"], respond(200, repoBody))).exitCode).toBe(0);
  const repo = applicationSchema(ghLite).commands.repo as GroupSchema;
  expect((repo.commands.get as CommandSchema).input.positionals[0]!.pattern).toMatchObject({ description: "owner/name of a GitHub repository", match: "whole-value" });
});

test.each([
  [404, {}, "NOT_FOUND"],
  [403, { "x-ratelimit-remaining": "0" }, "RATE_LIMITED"],
  [429, { "retry-after": "30" }, "RATE_LIMITED"],
  [403, {}, "FORBIDDEN"],
  [401, {}, "FORBIDDEN"],
  [422, {}, "UNEXPECTED_STATUS"],
  [451, {}, "UNEXPECTED_STATUS"],
  [503, {}, "SERVER_ERROR"],
])("HTTP %i %j is a %s failure", async (status, headers, code) => {
  const r = await run(["repo", "get", "a/b"], respond(status, "{}", headers));
  expect(r.exitCode).toBe(1);
  expect(r.json.error.code).toBe(code);
});

test("retry-after is reported when given", async () => {
  const r = await run(["repo", "get", "a/b"], respond(429, "", { "retry-after": "30" }));
  expect(r.json.error.details).toEqual({ retryAfterSeconds: 30 });
});

test("an unreachable API is a NETWORK_ERROR failure", async () => {
  const r = await run(["repo", "get", "a/b"], async () => {
    throw new TypeError("fetch failed");
  });
  expect(r.exitCode).toBe(1);
  expect(r.json.error.code).toBe("NETWORK_ERROR");
});

test.each([
  ["HTML from a proxy", "<html>blocked</html>"],
  ["a non-repository JSON body", JSON.stringify({ message: "moved" })],
  ["a malformed repository", JSON.stringify({ full_name: "a/b", stargazers_count: "many", description: null })],
])("%s is an INVALID_RESPONSE failure", async (_name, body) => {
  const r = await run(["repo", "get", "a/b"], respond(200, body));
  expect(r.exitCode).toBe(1);
  expect(r.json.error.code).toBe("INVALID_RESPONSE");
});

test("aborting during the request is INTERRUPTED with exit 130, not a network failure", async () => {
  const controller = new AbortController();
  const r = await run(
    ["repo", "get", "a/b"],
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
        controller.abort();
      }),
    controller.signal,
  );
  expect(r).toMatchObject({ exitCode: 130, kind: "interrupted" });
  expect(r.json.error.code).toBe("INTERRUPTED");
});

test("aborting while the body is read is also INTERRUPTED", async () => {
  const controller = new AbortController();
  const r = await run(
    ["repo", "get", "a/b"],
    async () => {
      const response = new Response(repoBody, { status: 200 });
      Object.defineProperty(response, "json", {
        value: () => {
          controller.abort();
          return Promise.reject(new DOMException("aborted", "AbortError"));
        },
      });
      return response;
    },
    controller.signal,
  );
  expect(r.exitCode).toBe(130);
});
