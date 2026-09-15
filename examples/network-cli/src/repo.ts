import { application, authoring, group, output, type Fault } from "cli-for-ai";
import { fromNeverthrow } from "cli-for-ai/neverthrow";
import { ResultAsync, errAsync, okAsync } from "neverthrow";

// Network is not in the core. The fetch function arrives through Context, and
// remote failures are domain errors mapped to faults explicitly.
export interface Context {
  fetch: typeof fetch;
}

export type RepoError =
  | { kind: "interrupted" }
  | { kind: "not-found"; slug: string }
  | { kind: "rate-limited"; retryAfterSeconds: number | null }
  | { kind: "forbidden"; status: number }
  | { kind: "server"; status: number }
  | { kind: "unexpected-status"; status: number }
  | { kind: "network"; reason: string }
  | { kind: "invalid-response"; reason: string };

export interface Repo {
  name: string;
  stars: number;
  description: string | null;
}

// GitHub owner and repository names; anything that could change the request path or query is rejected.
export const SLUG_PATTERN = {
  regex: "[A-Za-z0-9][A-Za-z0-9-]{0,38}/(?!\\.\\.?$)[A-Za-z0-9._-]{1,100}",
  description: "owner/name of a GitHub repository",
} as const;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fetchRepo(ctx: Context, slug: string, signal: AbortSignal): ResultAsync<Repo, RepoError> {
  // Any failure after the caller aborted is the interruption, not a network problem.
  const classify = (error: unknown, otherwise: (e: unknown) => RepoError): RepoError =>
    signal.aborted ? { kind: "interrupted" } : otherwise(error);

  return ResultAsync.fromPromise(
    ctx.fetch(`https://api.github.com/repos/${slug}`, { headers: { "user-agent": "gh-lite" }, signal }),
    (e) => classify(e, (x) => ({ kind: "network", reason: reason(x) })),
  )
    .andThen((res): ResultAsync<Response, RepoError> => {
      if (res.ok) return okAsync(res);
      if (res.status === 404) return errAsync({ kind: "not-found", slug });
      const remaining = res.headers.get("x-ratelimit-remaining");
      const retryAfter = res.headers.get("retry-after");
      if (res.status === 429 || (res.status === 403 && (remaining === "0" || retryAfter !== null))) {
        const seconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
        return errAsync({ kind: "rate-limited", retryAfterSeconds: seconds });
      }
      if (res.status === 401 || res.status === 403) return errAsync({ kind: "forbidden", status: res.status });
      if (res.status >= 500) return errAsync({ kind: "server", status: res.status });
      return errAsync({ kind: "unexpected-status", status: res.status });
    })
    .andThen((res) =>
      ResultAsync.fromPromise(res.json() as Promise<unknown>, (e) =>
        classify(e, (x) => ({ kind: "invalid-response", reason: `body is not JSON: ${reason(x)}` })),
      ),
    )
    .andThen((body): ResultAsync<Repo, RepoError> => {
      const v = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
      if (typeof v.full_name !== "string" || !Number.isSafeInteger(v.stargazers_count) || !(v.description === null || typeof v.description === "string")) {
        return errAsync({ kind: "invalid-response", reason: "body is not a repository" });
      }
      return okAsync({ name: v.full_name, stars: v.stargazers_count as number, description: v.description });
    });
}

/** Output validation guards the command's own projection, independent of the API check above. */
export function parseRepo(value: unknown): Repo {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof v.name !== "string" || !Number.isSafeInteger(v.stars) || !(v.description === null || typeof v.description === "string")) {
    throw new TypeError("repository data does not match {name: string, stars: integer, description: string | null}");
  }
  return { name: v.name, stars: v.stars as number, description: v.description };
}

export function repoFault(error: RepoError): Fault {
  switch (error.kind) {
    case "interrupted":
      return { code: "INTERRUPTED", message: "The request was interrupted; it may still have reached GitHub" };
    case "not-found":
      return { code: "NOT_FOUND", message: `Repository not found or not public: ${error.slug}`, details: { slug: error.slug } };
    case "rate-limited":
      return {
        code: "RATE_LIMITED",
        message: "The GitHub API rate limit was reached; retry later",
        details: { retryAfterSeconds: error.retryAfterSeconds },
      };
    case "forbidden":
      return { code: "FORBIDDEN", message: `GitHub refused the request (${error.status})`, details: { status: error.status } };
    case "server":
      return { code: "SERVER_ERROR", message: `The GitHub API returned ${error.status}`, details: { status: error.status } };
    case "unexpected-status":
      return { code: "UNEXPECTED_STATUS", message: `The GitHub API returned ${error.status}`, details: { status: error.status } };
    case "network":
      return { code: "NETWORK_ERROR", message: `The GitHub API could not be reached: ${error.reason}` };
    case "invalid-response":
      return { code: "INVALID_RESPONSE", message: `The GitHub API response could not be used: ${error.reason}` };
  }
}

const { command } = authoring<Context>();

export const ghLite = application({
  name: "gh-lite",
  version: "0.1.0",
  summary: "Read public GitHub repositories",
  commands: {
    repo: group({
      summary: "Public repositories",
      commands: {
        get: command({
          summary: "Fetch public repository information",
          input: { positionals: [{ name: "slug", summary: "owner/name", required: true, pattern: SLUG_PATTERN }] },
          output: output({
            summary: "Name, star count and description",
            fields: [
              { path: "data.name", summary: "owner/name of the repository" },
              { path: "data.stars", summary: "Star count" },
              { path: "data.description", summary: "Description, or null when the repository has none" },
            ],
            parse: parseRepo,
          }),
          examples: [{ summary: "Inspect GitHub's sample repository", input: { slug: "octocat/Hello-World" } }],
          run: fromNeverthrow((input, ctx, { signal }) => fetchRepo(ctx, input.slug, signal), { error: repoFault }),
          human: (r) => `${r.name} ★${r.stars}${r.description ? ` — ${r.description}` : ""}`,
        }),
      },
    }),
  },
});
