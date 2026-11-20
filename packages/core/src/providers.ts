import { fetchForgejo, detectForgejo, forgejoInstanceId, type ForgejoCache } from "./forgejo.ts";
import { fetchGitLab, type GitLabCache } from "./gitlab.ts";
import { HttpError, request, type HttpOptions } from "./http.ts";
import { emptyTotals, type Totals } from "./model.ts";
import { ProviderError, type ProviderRegistry, type SourceProvider } from "./provider.ts";
import { gitlabInstanceId } from "./sources.ts";

function noOptions(value: unknown): undefined {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length)) {
    throw new Error("This provider does not support source options.");
  }
  return undefined;
}

function gitlabOptions(value: unknown): { mirrors?: string[] } {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitLab options must be an object.");
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some((key) => key !== "mirrors")) throw new Error("GitLab options contain an unsupported field.");
  if (options.mirrors === undefined) return {};
  if (!Array.isArray(options.mirrors) || options.mirrors.some((path) => typeof path !== "string" || !path.trim())) {
    throw new Error("GitLab options.mirrors must be an array of non-empty strings.");
  }
  return { mirrors: options.mirrors.map((path) => (path as string).trim()) };
}

function gitlabCache(value: unknown): GitLabCache | undefined {
  if (value === undefined) return undefined;
  const record = (input: unknown): input is Record<string, unknown> => Boolean(input && typeof input === "object" && !Array.isArray(input));
  const date = (input: unknown): input is string => {
    if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return false;
    const parsed = new Date(`${input}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === input;
  };
  const invalid = (): never => { throw new ProviderError("cache", "validation"); };
  if (!record(value)) return invalid();
  if (typeof value.instance !== "string" || typeof value.login !== "string"
    || !Number.isSafeInteger(value.userId) || (value.userId as number) <= 0 || !date(value.fetchedThrough)
    || !record(value.days) || !Array.isArray(value.projects) || value.projects.some((id) => typeof id !== "string")) return invalid();
  for (const [key, day] of Object.entries(value.days as Record<string, unknown>)) {
    if (!date(key) || !record(day)) return invalid();
    for (const field of ["contributions", "commits", "pullRequests", "issues", "reviews"]) {
      if (!Number.isSafeInteger(day[field]) || (day[field] as number) < 0) invalid();
    }
  }
  return value as unknown as GitLabCache;
}

const gitlab: SourceProvider = {
  id: "gitlab",
  name: "GitLab",
  cacheVersion: 1,
  metric: "contributions",
  timezone: "UTC",
  capabilities: { totals: Object.keys(emptyTotals()) as (keyof Totals)[], languages: true, repos: true },
  normalizeOptions: gitlabOptions,
  instanceId: gitlabInstanceId,
  async detect(source, options) {
    let response: Response;
    try {
      response = await request(`${source.url}/api/v4/version`, {
        headers: { authorization: `Bearer ${source.token}`, "user-agent": "git-info-combine" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }, options);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return false;
      throw error;
    }
    if (response.status !== 200) throw new HttpError(response.status, "Unexpected metadata HTTP status.");
    if (!/\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get("content-type") ?? "")) {
      throw new Error("Unexpected non-JSON API response.");
    }
    let data: unknown;
    try { data = await response.json(); } catch { throw new Error("Invalid JSON API response."); }
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const value = data as Record<string, unknown>;
    return typeof value.version === "string" && Boolean(value.version.trim()) && typeof value.revision === "string" && Boolean(value.revision.trim());
  },
  collect(source, context) {
    const options = gitlabOptions(source.options);
    return fetchGitLab({
      ...context,
      token: source.token,
      baseUrl: source.url,
      cache: gitlabCache(context.cache),
      mirrors: [...(context.gitlabMirrors ?? []), ...(options.mirrors ?? [])],
    });
  },
};

const forgejo: SourceProvider = {
  id: "forgejo",
  name: "Forgejo",
  cacheVersion: 1,
  metric: "contributions",
  timezone: "UTC",
  capabilities: { totals: ["contributions"], languages: false, repos: false },
  normalizeOptions: noOptions,
  instanceId: forgejoInstanceId,
  detect: (source, options) => detectForgejo({ ...options, baseUrl: source.url }),
  collect: (source, context) => fetchForgejo({ ...context, baseUrl: source.url, token: source.token, cache: context.cache as ForgejoCache | undefined }),
};

/** Add an adapter here; configuration, orchestration and SVG remain provider-independent. */
export const DEFAULT_PROVIDERS: ProviderRegistry = new Map([gitlab, forgejo].map((provider) => [provider.id, provider]));

/** Every provider HTTP request stays on its configured server, with bounded network waits. */
export function serverHttpOptions(baseUrl: string, options: HttpOptions): HttpOptions {
  const base = new URL(baseUrl);
  const prefix = `${base.pathname.replace(/\/+$/, "")}/`;
  const fetchFn = options.fetch ?? fetch;
  return {
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.retries !== undefined ? { retries: options.retries } : {}),
    timeoutMs: 10_000,
    fetch: (url, init) => {
      const target = new URL(url);
      if (target.origin !== base.origin || !target.pathname.startsWith(prefix)) {
        throw new Error("Provider request must stay inside its configured server.");
      }
      return fetchFn(url, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(10_000) });
    },
  };
}
