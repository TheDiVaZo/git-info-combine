import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, type Collected, type ShowcaseOptions } from "@git-info-combine/core";
import { githubRoute, gitlabRoute, NOW, PRIVATE_NAMES } from "../../core/test/fixtures.ts";
import { json, mockFetch, type Route } from "../../core/test/mock.ts";
import { primaryGitLabSource, readConfig } from "../src/inputs.ts";
import { run } from "../src/run.ts";

const servers = [
  { id: "lab-one", url: "https://lab-one.example.invalid", token: "lab-one-secret", label: "Lab One", color: "#fc6d26" },
  { id: "forge-one", url: "https://forge-one.example.invalid", token: "forge-one-secret", label: "Forge One", color: "#fb923c" },
  { id: "lab-two", url: "https://lab-two.example.invalid", token: "lab-two-secret", label: "Lab Two", color: "#a855f7", provider: "gitlab" },
  { id: "forge-two", url: "https://forge-two.example.invalid", token: "forge-two-secret", label: "Forge Two", color: "#2f80ed", provider: "forgejo" },
];

function settings(extra: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "github-token": "fixture-github-token", sources: JSON.stringify(servers),
    "manual-contributions-dir": "contributions/manual", cards: "heatmap,stats,hosts,languages",
    "heatmap-mode": "single", "icon-color": "40c463", commit: "false", ...extra,
  };
  return readConfig((name) => values[name] ?? "");
}

function api(failLast = false) {
  const labs = [servers[0]!, servers[2]!];
  const labRoutes = labs.map((source) => gitlabRoute(source.url));
  const route: Route = (call) => {
    const github = githubRoute(call);
    if (github) return github;
    const index = servers.findIndex((source) => source.url === call.url.origin);
    if (index < 0) return undefined;
    const isLab = index === 0 || index === 2;
    if (call.url.pathname === "/api/forgejo/v1/version") return isLab ? json({}, {}, 404) : json({ version: "17.0.0+gitea-1.22.0" });
    if (call.url.pathname === "/api/v4/version") return isLab ? json({ version: "19.0.0", revision: "fixture-revision" }) : json({}, {}, 404);
    if (isLab) return labRoutes[index === 0 ? 0 : 1]!(call);
    if (call.url.pathname === "/api/v1/user") return json({ id: 7, login: "fixture-account", email: "never-publish@example.invalid" });
    if (call.url.pathname === "/api/v1/users/fixture-account/heatmap") {
      if (failLast && index === 3) return new Response("<html>private proxy diagnostic</html>", { headers: { "content-type": "text/html" } });
      return json([
        { timestamp: Date.parse("2026-10-01T09:00:00Z") / 1000, contributions: 1 },
        { timestamp: Date.parse("2026-10-01T09:15:00Z") / 1000, contributions: index === 1 ? 2 : 3 },
      ], { date: NOW.toUTCString() });
    }
    return undefined;
  };
  return mockFetch(route);
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "gic-provider-action-"));
  await mkdir(join(root, "contributions/manual"), { recursive: true });
  await writeFile(join(root, "contributions/manual/exbo.json"), JSON.stringify({
    schemaVersion: 1, source: { id: "exbo", name: "EXBO", type: "manual", metric: "commits" },
    timezone: "Europe/Moscow", days: { "2026-10-01": 5 },
  }));
  return root;
}

async function outputs(root: string) {
  const directory = join(root, "git-info-combine");
  return Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async (name) => [name, await readFile(join(directory, name), "utf8")])));
}

describe("shared sources through the Action", () => {
  test("accepts auto and explicit sources without GitHub and rejects conflicting legacy input", () => {
    const config = settings({ "github-token": "" });
    expect(config.sources).toMatchObject(servers);
    expect(config.githubToken).toBeUndefined();
    for (const legacy of [{ "gitlab-token": "sensitive-value" }, { "gitlab-sources": "[]" }] as Record<string, string>[]) {
      expect(() => settings(legacy)).toThrow("either sources");
    }
    expect(() => settings({ sources: "[]", "github-token": "", "manual-contributions-dir": "" })).toThrow("Set at least one");
    expect(() => settings({ sources: '[{"token":"private-sensitive-json",' })).toThrow();
  });

  test("combines GitHub, multiple servers of both providers and EXBO without publishing credentials", async () => {
    const root = await workspace();
    const fixture = api();
    const logs: string[] = [];
    let result: Collected | undefined;
    await run(settings(), {
      workspace: root, logger: { info: (line) => void logs.push(line), warning() {} },
      collect: async (options) => result = await collect({ ...options, fetch: fixture.fetch, now: NOW }),
    });
    expect(result!.activity.hosts.map((host) => host.source?.label ?? "GitHub")).toEqual(["GitHub", ...servers.map((source) => source.label), "EXBO"]);
    expect(result!.activity.hosts.filter((host) => host.host === "forgejo").map((host) => host.totals.contributions)).toEqual([3, 4]);
    expect(Object.keys(result!.cache.sources ?? {})).toHaveLength(4);
    const files = await outputs(root);
    for (const suffix of ["", "-light", "-dark"]) {
      const svg = files[`heatmap${suffix}.svg`]!;
      for (const label of ["GitHub", "EXBO", ...servers.map((source) => source.label)]) expect(svg).toContain(label);
      expect(svg).toContain("#40c463");
      expect(svg).toContain("UTC");
      expect(svg).toContain("local commits");
    }
    expect(logs.filter((line) => line.startsWith("Forge ")).every((line) => !line.includes("repos"))).toBe(true);
    const publicData = JSON.stringify({ files, logs });
    for (const secret of [...PRIVATE_NAMES, ...servers.flatMap((source) => [source.token, new URL(source.url).hostname]), "never-publish@example.invalid", "fixture-account", "fixture-github-token"]) {
      expect(publicData).not.toContain(secret);
    }
    for (const call of fixture.calls.filter((call) => call.url.pathname.startsWith("/api/v1/"))) {
      const source = servers.find((source) => source.url === call.url.origin)!;
      expect(call.headers.get("authorization")).toBe(`token ${source.token}`);
    }
  });

  test("a late provider HTML response leaves all previous output unchanged and never commits", async () => {
    const root = await workspace();
    const first = api();
    const logger = { info() {}, warning() {} };
    await run(settings(), { workspace: root, logger, collect: (options) => collect({ ...options, fetch: first.fetch, now: NOW }) });
    const before = await outputs(root);
    const failing = api(true);
    let commits = 0;
    await expect(run(settings({ commit: "true" }), {
      workspace: root, logger,
      collect: (options) => collect({ ...options, fetch: failing.fetch, now: NOW }),
      commit: async () => { commits++; return true; },
    })).rejects.toThrow();
    expect(commits).toBe(0);
    expect(await outputs(root)).toEqual(before);
  });

  test("selects a detected GitLab source for existing showcases, never a Forgejo token", async () => {
    const root = await workspace();
    const fixture = api();
    const seen: ShowcaseOptions[] = [];
    const config = settings({ cards: "pins", pins: "gitlab:public/project", "gitlab-primary-source": "lab-one" });
    await run(config, {
      workspace: root, logger: { info() {}, warning() {} },
      collect: (options) => collect({ ...options, fetch: fixture.fetch, now: NOW }),
      pin: async (_ref, options) => {
        seen.push(options);
        return { host: "gitlab", kind: "repo", title: "Project", path: "public/project", description: "Public fixture", language: null, stars: 0, forks: 0, archived: false };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.gitlabToken).toBe(servers[0]!.token);
    expect(seen[0]!.gitlabUrl).toBe(servers[0]!.url);
    const invalid = api();
    await expect(run(settings({ cards: "pins", pins: "gitlab:public/project", "gitlab-primary-source": "forge-one" }), {
      workspace: root, logger: { info() {}, warning() {} },
      collect: (options) => collect({ ...options, fetch: invalid.fetch, now: NOW }),
    })).rejects.toThrow("must match a GitLab source");
  });

  test("keeps provider identity when different providers share the same server URL", async () => {
    const url = "https://shared.example.invalid";
    const labRoute = gitlabRoute(url);
    for (const provider of [undefined, "forgejo"]) {
      const shared = [
        { ...servers[1]!, url, provider },
        { ...servers[2]!, url },
      ];
      const config = settings({
        sources: JSON.stringify(shared), "github-token": "", "manual-contributions-dir": "",
        cards: "pins", pins: "gitlab:public/project", "gitlab-primary-source": "lab-two",
      });
      const fixture = mockFetch((call) => {
        if (call.url.pathname === "/api/forgejo/v1/version") return json({ version: "17.0.0" });
        if (call.url.pathname === "/api/v4/version") return json({}, {}, 404);
        if (call.url.pathname === "/api/v1/user") return json({ id: 7, login: "fixture-account" });
        if (call.url.pathname.endsWith("/heatmap")) return json([], { date: NOW.toUTCString() });
        return labRoute(call);
      });
      const result = await collect({ sources: config.sources, fetch: fixture.fetch, now: NOW });
      expect(result.sourceProviders).toEqual(["forgejo", "gitlab"]);
      expect(primaryGitLabSource(config, result.sourceProviders)?.token).toBe(servers[2]!.token);
      expect(() => primaryGitLabSource({ ...config, gitlabPrimarySource: "forge-one" }, result.sourceProviders))
        .toThrow("must match a GitLab source");
    }
  });
});
