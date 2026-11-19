import { describe, expect, test } from "bun:test";
import { CACHE_VERSION, collect, parseCache } from "../src/collect.ts";
import { gitlabInstanceId, type GitLabSourceConfig } from "../src/sources.ts";
import { GITLAB_EVENTS, githubRoute, gitlabRoute, NOW, PRIVATE_NAMES } from "./fixtures.ts";
import { json, mockFetch, type Route } from "./mock.ts";

const route = (base?: string) => {
  const gitlab = gitlabRoute(base);
  return mockFetch((call) => githubRoute(call) ?? gitlab(call)).fetch;
};

describe("collect", () => {
  test("combines both hosts", async () => {
    const { activity } = await collect({ githubToken: "a", gitlabToken: "b", fetch: route(), now: NOW });
    expect(activity.hosts.map((host) => host.host)).toEqual(["github", "gitlab"]);
    expect(activity.totals.contributions).toBe(30);
    expect(activity.totals.stars).toBe(10);
    expect(activity.days["2026-10-01"]).toBe(5);
    expect(Object.keys(activity.days)).toEqual([...Object.keys(activity.days)].sort());
    expect(activity.languages.Swift).toEqual({ size: 5500, weight: 1 + 1 / 3, repos: 2, color: "#F05138" });
    expect(activity.generatedAt).toBe(NOW.toISOString());
  });

  test("no private name reaches the activity data or the cache", async () => {
    const result = await collect({
      githubToken: "a",
      gitlabToken: "b",
      gitlabUrl: "https://git.secretcorp.internal",
      fetch: route("https://git.secretcorp.internal"),
      now: NOW,
    });
    const output = JSON.stringify({ activity: result.activity, cache: result.cache }).toLowerCase();
    for (const name of PRIVATE_NAMES) expect(output).not.toContain(name.toLowerCase());
    // GitHub: name and owner/name. GitLab, for each of two private projects: name (same as
    // its path) and both full paths. Plus the hostname.
    expect(result.sensitive.size).toBe(9);
  });

  test("named GitLab mirrors are counted once and reported", async () => {
    const result = await collect({
      githubToken: "a",
      gitlabToken: "b",
      gitlabMirrors: ["acme-corp/client-portal-x"],
      fetch: route(),
      now: NOW,
    });
    expect(result.mirrored).toBe(1);
    expect(result.activity.hosts[1]!.totals.commits).toBe(16);
  });

  test("the cache round-trips", async () => {
    const first = await collect({ githubToken: "a", gitlabToken: "b", fetch: route(), now: NOW });
    const cache = parseCache(JSON.stringify(first.cache));
    expect(cache).toEqual(first.cache);
    const second = await collect({ githubToken: "a", gitlabToken: "b", fetch: route(), now: NOW, cache });
    expect(second.activity).toEqual(first.activity);
  });

  test("excluded repos and projects leave languages and stars", async () => {
    const { activity } = await collect({
      githubToken: "a",
      gitlabToken: "b",
      fetch: route(),
      now: NOW,
      excludeRepos: ["octo/dotfiles", "OPEN-WIDGET"],
    });
    expect(activity.totals.stars).toBe(3);
    expect(Object.keys(activity.languages).sort()).toEqual(["CSS", "PHP", "Swift", "TypeScript"]);
  });

  test("needs at least one token", async () => {
    await expect(collect({ fetch: route(), now: NOW })).rejects.toThrow("Set at least one of github-token, gitlab-token and gitlab-sources.");
  });
});

const SOURCES: GitLabSourceConfig[] = [
  { id: "work", url: "https://git.secretcorp.internal", token: "work-secret-token", label: "Work", color: "#fc6d26" },
  { id: "personal", url: "https://git.othercorp.internal", token: "personal-secret-token", label: "Personal", color: "#2878c8" },
];
const [WORK, PERSONAL] = SOURCES as [GitLabSourceConfig, GitLabSourceConfig];
const workId = gitlabInstanceId(WORK.url);
const personalId = gitlabInstanceId(PERSONAL.url);

function multipleRoutes(override?: Route) {
  const routes = [gitlabRoute(WORK.url), gitlabRoute(PERSONAL.url, GITLAB_EVENTS.slice(4))];
  return mockFetch((call) => override?.(call) ?? githubRoute(call) ?? routes.map((route) => route(call)).find(Boolean));
}

describe("multiple GitLab sources", () => {
  test("keeps tokens, identical project IDs and per-source activity separate", async () => {
    const { fetch, calls } = multipleRoutes();
    const result = await collect({ githubToken: "github-secret-token", gitlabSources: SOURCES, fetch, now: NOW });
    expect(result.activity.hosts.map((host) => host.host)).toEqual(["github", "gitlab", "gitlab"]);
    expect(result.activity.hosts.map((host) => host.totals.contributions)).toEqual([23, 7, 4]);
    expect(result.activity.totals).toMatchObject({ contributions: 34, commits: 70, stars: 17 });
    expect(result.activity.hosts[1]!.source).toEqual({ id: workId, label: "Work", color: WORK.color });
    expect(result.activity.hosts[2]!.source).toEqual({ id: personalId, label: "Personal", color: PERSONAL.color });
    expect(Object.keys(result.cache.gitlabs!).sort()).toEqual([workId, personalId].sort());
    expect(result.cache.gitlabs![workId]!.days["2026-09-30"]?.contributions).toBe(3);
    expect(result.cache.gitlabs![personalId]!.days["2026-09-30"]).toBeUndefined();
    for (const source of SOURCES) {
      const requests = calls.filter((call) => call.url.origin === source.url);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((call) => call.headers.get("authorization") === `Bearer ${source.token}`)).toBe(true);
    }
    const output = JSON.stringify({ activity: result.activity, cache: result.cache });
    for (const name of [...PRIVATE_NAMES, ...SOURCES.flatMap((source) => [source.url, source.token])]) {
      expect(output).not.toContain(name);
    }
    expect(JSON.stringify(result.cache)).not.toContain("Personal");
  });

  test("reuses each cache after reordering, renaming, changing colours and rotating tokens", async () => {
    const first = await collect({ gitlabSources: SOURCES, fetch: multipleRoutes().fetch, now: NOW });
    const changed = [...SOURCES].reverse().map((source) => ({ ...source, id: `${source.id}-new`, label: `${source.label} new`, color: "#abcdef", token: `${source.token}-rotated` }));
    const { fetch, calls } = multipleRoutes();
    const second = await collect({ gitlabSources: changed, cache: first.cache, fetch, now: NOW });
    expect(second.activity.totals).toEqual(first.activity.totals);
    expect(second.activity.hosts.map((host) => host.source?.id)).toEqual([personalId, workId]);
    expect(second.cache).toEqual(first.cache);
    expect(calls.filter((call) => call.url.pathname.includes("/repository/"))).toHaveLength(0);
    expect(calls.filter((call) => call.url.pathname.endsWith("/events")).every((call) => call.url.searchParams.get("after") === "2026-10-01")).toBe(true);
  });

  test("a different user invalidates only that server's cache", async () => {
    const first = await collect({ gitlabSources: SOURCES, fetch: multipleRoutes().fetch, now: NOW });
    for (const cache of Object.values(first.cache.gitlabs!)) {
      cache.days["2020-01-01"] = { contributions: 9, commits: 9, pullRequests: 0, issues: 0, reviews: 0 };
    }
    const { fetch, calls } = multipleRoutes((call) => call.url.origin === PERSONAL.url && call.url.pathname === "/api/v4/user"
      ? json({ id: 99, username: "octo", name: "Octo Cat", email: "octo@example.com", followers: 2 }) : undefined);
    const second = await collect({ gitlabSources: SOURCES, cache: first.cache, fetch, now: NOW });
    expect(second.cache.gitlabs![workId]!.days["2020-01-01"]?.contributions).toBe(9);
    expect(second.cache.gitlabs![personalId]!.days["2020-01-01"]).toBeUndefined();
    expect(second.cache.gitlabs![personalId]!.userId).toBe(99);
    const contributions = calls.filter((call) => call.url.pathname.endsWith("/contributors"));
    expect(contributions.length).toBeGreaterThan(0);
    expect(contributions.every((call) => call.url.origin === PERSONAL.url)).toBe(true);
  });

  test("disabled servers retain history without contributing to totals", async () => {
    const first = await collect({ gitlabSources: SOURCES, fetch: multipleRoutes().fetch, now: NOW });
    const second = await collect({ gitlabSources: [WORK], cache: first.cache, fetch: multipleRoutes().fetch, now: NOW });
    expect(second.activity.hosts).toHaveLength(1);
    expect(second.activity.totals.contributions).toBe(7);
    expect(second.cache.gitlabs![personalId]).toEqual(first.cache.gitlabs![personalId]);
    const { fetch, calls } = multipleRoutes();
    const restored = await collect({ gitlabSources: SOURCES, cache: second.cache, fetch, now: NOW });
    expect(restored.activity).toEqual(first.activity);
    expect(calls.some((call) => call.url.pathname.includes("/repository/"))).toBe(false);
  });

  test("combines global and source-specific mirrors without affecting another server", async () => {
    const sources = [{ ...WORK, mirrors: ["acme-corp/client-portal-x"] }, PERSONAL];
    const result = await collect({ gitlabSources: sources, gitlabMirrors: ["octo/open-widget"], fetch: multipleRoutes().fetch, now: NOW });
    expect(result.mirrored).toBe(3);
    expect(result.activity.hosts.map((host) => host.totals.commits)).toEqual([11, 23]);
  });

  test("rejects mixed config and duplicate servers before any request", async () => {
    const { fetch, calls } = multipleRoutes();
    await expect(collect({ gitlabToken: "legacy", gitlabSources: SOURCES, fetch })).rejects.toThrow("not both");
    await expect(collect({ gitlabSources: [WORK, { ...PERSONAL, url: `${WORK.url}/` }], fetch })).rejects.toThrow("different server");
    expect(calls).toHaveLength(0);
  });

  test("rejects malformed typed configuration before any request without exposing token values", async () => {
    const { fetch, calls } = multipleRoutes();
    for (const sources of [null, [{ ...WORK, token: { value: WORK.token } }], [{ ...WORK, label: { value: WORK.token } }]]) {
      let message = "";
      try {
        await collect({ gitlabSources: sources as unknown as GitLabSourceConfig[], fetch });
      } catch (error) { message = (error as Error).message; }
      expect(message).toStartWith("Input gitlab-sources");
      expect(message).not.toContain(WORK.token);
      expect(message).not.toContain(WORK.url);
    }
    expect(calls).toHaveLength(0);
  });

  test("a failed server rejects the entire collection without changing the input cache or leaking the error", async () => {
    const first = await collect({ gitlabSources: SOURCES, fetch: multipleRoutes().fetch, now: NOW });
    const original = JSON.stringify(first.cache);
    const normal = multipleRoutes().fetch;
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.startsWith(PERSONAL.url)) throw new Error(`${PERSONAL.url}: ${PERSONAL.token} client-portal-x`);
      return normal(url, init);
    };
    await expect(collect({ gitlabSources: SOURCES, cache: first.cache, fetch, now: NOW })).rejects.toThrow("GitLab source 2 failed. Check its connection, token and API response.");
    expect(JSON.stringify(first.cache)).toBe(original);
  });

  test("HTTP failures disclose only source number and status", async () => {
    const { fetch } = multipleRoutes((call) => call.url.origin === PERSONAL.url ? json({ secret: PERSONAL.token }, {}, 401) : undefined);
    await expect(collect({ gitlabSources: SOURCES, fetch, now: NOW })).rejects.toThrow("GitLab source 2 failed with HTTP 401.");
  });

  test("malformed API JSON cannot expose secrets in parser errors", async () => {
    const { fetch } = multipleRoutes((call) => call.url.origin === PERSONAL.url
      ? new Response(`{"token":"${PERSONAL.token}","project":"client-portal-x",}`, { status: 200 }) : undefined);
    await expect(collect({ gitlabSources: SOURCES, fetch, now: NOW })).rejects.toThrow("GitLab source 2 failed. Check its connection, token and API response.");
  });

  test("labels cannot expose another source's private names, domain or token", async () => {
    for (const label of ["client-portal-x", new URL(PERSONAL.url).hostname, PERSONAL.token]) {
      const sources = [{ ...WORK, label }, PERSONAL];
      await expect(collect({ gitlabSources: sources, fetch: multipleRoutes().fetch, now: NOW })).rejects.toThrow("Refusing to write");
    }
  });
});

describe("parseCache", () => {
  test("starts fresh on missing, broken or old caches", () => {
    expect(parseCache(undefined)).toBeUndefined();
    expect(parseCache("{not json")).toBeUndefined();
    expect(parseCache(JSON.stringify({ version: 0 }))).toBeUndefined();
  });

  test("migrates v1 and preserves historical days that the server no longer returns", async () => {
    const first = await collect({ githubToken: "a", gitlabToken: WORK.token, gitlabUrl: WORK.url, fetch: multipleRoutes().fetch, now: NOW });
    const legacyGitLab = first.cache.gitlabs![workId]!;
    legacyGitLab.days["2020-01-01"] = { contributions: 9, commits: 9, pullRequests: 0, issues: 0, reviews: 0 };
    const cache = parseCache(JSON.stringify({ version: 1, github: first.cache.github, gitlab: legacyGitLab }));
    expect(cache).toEqual({ version: CACHE_VERSION, github: first.cache.github, gitlabs: { [workId]: legacyGitLab } });
    const next = await collect({ gitlabSources: SOURCES, cache, fetch: multipleRoutes().fetch, now: NOW });
    expect(next.activity.hosts[0]!.days["2020-01-01"]).toBe(9);
    expect(next.activity.hosts[1]!.days["2020-01-01"]).toBeUndefined();
    expect(next.cache.github).toEqual(first.cache.github);
    expect(next.cache.gitlabs![workId]!.projectStats).toEqual(legacyGitLab.projectStats);
  });
});
