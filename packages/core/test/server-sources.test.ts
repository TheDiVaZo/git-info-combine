import { describe, expect, test } from "bun:test";
import { collect, parseCache } from "../src/collect.ts";
import type { GitLabCache } from "../src/gitlab.ts";
import { emptyTotals } from "../src/model.ts";
import { SensitiveNames, opaqueId } from "../src/privacy.ts";
import { ProviderError, type SourceProvider, type ServerSourceConfig } from "../src/provider.ts";
import { DEFAULT_PROVIDERS } from "../src/providers.ts";
import { normalizeSources, parseSources, resolveSources } from "../src/server-sources.ts";
import { gitlabInstanceId } from "../src/sources.ts";
import { renderHeatmapCard } from "../src/render/heatmap.ts";
import { githubRoute, gitlabRoute, NOW } from "./fixtures.ts";
import { json, mockFetch } from "./mock.ts";

const SOURCE: ServerSourceConfig = {
  id: "work", url: "https://source.example.invalid/service", token: "private-fixture-token",
  label: "Work", color: "#fc6d26",
};

describe("unified source configuration", () => {
  test("parses optional and explicit provider choices and provider-owned options", () => {
    expect(parseSources(undefined)).toBeUndefined();
    expect(parseSources(" ")).toBeUndefined();
    const input = [{ ...SOURCE, url: `${SOURCE.url}/`, color: "fc6d26" }, { ...SOURCE, id: "other", provider: "gitlab", url: "https://another.example.invalid", options: { mirrors: [" group/project "] } }];
    const normalized = parseSources(JSON.stringify(input))!;
    expect(normalized[0]).toEqual(SOURCE);
    expect(normalized[1]!.options).toEqual({ mirrors: ["group/project"] });
    expect((input[1]!.options as { mirrors: string[] }).mirrors[0]).toBe(" group/project ");
  });

  test("invalid fields, unknown providers and ambiguous legacy configuration fail before requests", async () => {
    const { fetch, calls } = mockFetch(() => { throw new Error("must not fetch"); });
    for (const item of [
      { ...SOURCE, provider: "unknown-private-provider" }, { ...SOURCE, provider: "" },
      { ...SOURCE, url: "https://secret:credential@example.invalid" },
      { ...SOURCE, url: `${SOURCE.url}?private=query` },
      { ...SOURCE, label: "bad\nprivate" }, { ...SOURCE, token: "bad\nprivate" },
      { ...SOURCE, color: "red;private" }, { ...SOURCE, options: [] },
      { ...SOURCE, provider: "forgejo", options: { private: true } },
      { ...SOURCE, provider: "gitlab", options: { mirrors: [2] } },
      { ...SOURCE, unwanted: SOURCE.token },
    ]) {
      const error = await collect({ sources: [item] as ServerSourceConfig[], fetch }).catch((error) => error as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(SOURCE.token);
      expect((error as Error).message).not.toContain(SOURCE.url);
    }
    await expect(collect({ sources: null as unknown as ServerSourceConfig[], fetch })).rejects.toThrow("Input sources");
    await expect(collect({ sources: [], gitlabToken: "legacy", fetch })).rejects.toThrow("not both");
    await expect(collect({ sources: [], gitlabSources: [], fetch })).rejects.toThrow("not both");
    expect(() => parseSources('{"private-secret":')).toThrow("Input sources must be a JSON array");
    expect(calls).toHaveLength(0);
  });

  test("rejects duplicate aliases and explicit server identities without discovery", () => {
    expect(() => normalizeSources([SOURCE, { ...SOURCE, url: "https://other.example.invalid" }])).toThrow("id must be unique");
    expect(() => normalizeSources([{ ...SOURCE, provider: "gitlab" }, { ...SOURCE, id: "other", provider: "gitlab", url: `${SOURCE.url}/` }])).toThrow("different server");
  });
});

describe("provider discovery", () => {
  test("detects GitLab and Forgejo from metadata, preserving base paths and credential isolation", async () => {
    const seen: { url: URL; headers: Headers; redirect?: RequestInit["redirect"]; signal?: AbortSignal | null }[] = [];
    const fetch = async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      seen.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect, signal: init?.signal });
      if (url.pathname.endsWith("/api/v4/version")) return json({ version: "19.0", revision: "revision" });
      return json({ error: "not found" }, {}, 404);
    };
    expect((await resolveSources([SOURCE], { fetch }))[0]!.provider).toBe("gitlab");
    expect(seen).toHaveLength(2);
    expect(seen.every((call) => call.url.origin === new URL(SOURCE.url).origin && call.url.pathname.startsWith("/service/") && call.redirect === "error" && call.signal)).toBe(true);
    expect(seen.find((call) => call.url.pathname.endsWith("/api/v4/version"))!.headers.get("authorization")).toBe(`Bearer ${SOURCE.token}`);
    expect(seen.find((call) => call.url.pathname.endsWith("/api/forgejo/v1/version"))!.headers.has("authorization")).toBe(false);

    const forgejo = mockFetch((call) => call.url.pathname.endsWith("/api/forgejo/v1/version") ? json({ version: "17.0.0+gitea-1.22.0" }) : json({}, {}, 401));
    expect((await resolveSources([SOURCE], { fetch: forgejo.fetch }))[0]!.provider).toBe("forgejo");
  });

  test("explicit provider skips discovery and is authoritative even when fetching fails", async () => {
    const { fetch, calls } = mockFetch((call) => call.url.pathname.endsWith("/api/v4/user") ? json({}, {}, 404) : undefined);
    await expect(collect({ sources: [{ ...SOURCE, provider: "gitlab" }], fetch })).rejects.toThrow("GitLab source 1 failed with HTTP 404");
    expect(calls.map((call) => call.url.pathname)).toEqual(["/service/api/v4/user"]);
  });

  test("does not identify products from 401, 403, redirects, HTML or arbitrary version objects", async () => {
    for (const status of [401, 403, 404, 302, 201]) {
      const { fetch } = mockFetch(() => json({ version: "1", revision: "2", secret: SOURCE.token }, {}, status));
      await expect(resolveSources([SOURCE], { fetch })).rejects.toThrow("could not be detected");
    }
    const empty = mockFetch(() => new Response(null, { status: 204 }));
    await expect(resolveSources([SOURCE], { fetch: empty.fetch })).rejects.toThrow("could not be detected");
    const html = mockFetch(() => new Response(`<html>${SOURCE.token}</html>`, { headers: { "content-type": "text/html" } }));
    const error = await resolveSources([SOURCE], { fetch: html.fetch }).catch((error) => error as Error);
    expect((error as Error).message).toContain("recognizable JSON");
    expect((error as Error).message).not.toContain(SOURCE.token);
    const genericVersion = mockFetch((call) => call.url.pathname.endsWith("/api/v4/version") ? json({ version: "17" }) : json({}, {}, 404));
    await expect(resolveSources([SOURCE], { fetch: genericVersion.fetch })).rejects.toThrow("could not be detected");
  });

  test("ambiguous responses require an explicit provider and duplicate auto sources fail", async () => {
    const ambiguous = mockFetch(() => json({ version: "17", revision: "2" }));
    await expect(resolveSources([SOURCE], { fetch: ambiguous.fetch })).rejects.toThrow("multiple providers");
    const gitlab = mockFetch((call) => call.url.pathname.endsWith("/api/v4/version") ? json({ version: "19", revision: "2" }) : json({}, {}, 404));
    await expect(resolveSources([{ ...SOURCE, provider: "gitlab" }, { ...SOURCE, id: "duplicate" }], { fetch: gitlab.fetch })).rejects.toThrow("different server");
  });

  test("discovery errors never print upstream exception text and retain useful HTTP status", async () => {
    const { fetch } = mockFetch((call) => call.url.pathname.endsWith("/api/v4/version") ? json({ private: SOURCE.token }, {}, 403) : undefined);
    const error = await resolveSources([SOURCE], { fetch }).catch((error) => error as Error);
    expect((error as Error).message).toContain("403");
    expect((error as Error).message).not.toContain(SOURCE.url);
    expect((error as Error).message).not.toContain(SOURCE.token);
  });
});

describe("provider registry and cache", () => {
  test("a third adapter joins discovery, collection and rendering without provider branches", async () => {
    let detected = 0;
    const provider: SourceProvider = {
      id: "fixture", name: "Fixture", cacheVersion: 1, metric: "contributions", timezone: "UTC",
      capabilities: { totals: ["contributions"], languages: false, repos: false },
      instanceId: (url) => opaqueId("fixture", url),
      normalizeOptions: (value) => value,
      detect: async (_source, context) => {
        detected++;
        expect(context).not.toHaveProperty("sources");
        expect(context).not.toHaveProperty("githubToken");
        return true;
      },
      collect: async (source, context) => {
        expect(source.token).toBe(SOURCE.token);
        expect(context).not.toHaveProperty("sources");
        expect(context).not.toHaveProperty("githubToken");
        expect(context).not.toHaveProperty("gitlabToken");
        expect(JSON.stringify(context)).not.toContain("other-private-token");
        const data = { "2026-10-02": 4 };
        return {
          activity: { host: "irrelevant", login: "", days: data, totals: { ...emptyTotals(), contributions: 4 }, repos: { public: 0, private: 0 }, languages: {} },
          cache: { days: data }, sensitive: new SensitiveNames(),
        };
      },
    };
    const registry = new Map([[provider.id, provider]]);
    const { fetch } = mockFetch(githubRoute);
    const first = await collect({ sources: [SOURCE], githubToken: "other-private-token", fetch, now: NOW }, { providers: registry });
    expect(first.activity.hosts.map((host) => host.host)).toEqual(["github", "fixture"]);
    expect(first.activity.hosts[1]!.source).toMatchObject({ label: "Work", origin: "api", capabilities: provider.capabilities });
    expect(Object.keys(first.cache.sources!)).toEqual([`fixture:${provider.instanceId(SOURCE.url)}`]);
    const svg = renderHeatmapCard(first.activity, { mode: "single" });
    expect(svg).toContain("Work");
    expect(svg).toContain("2026-10-02");
    expect(svg).not.toContain(SOURCE.url);
    expect(svg).not.toContain(SOURCE.token);
    await collect({ sources: [SOURCE], githubToken: "other-private-token", fetch, now: NOW, cache: first.cache }, { providers: registry });
    expect(detected).toBe(2);
  });

  test("an adapter cannot send credential requests outside its configured base", async () => {
    let calls = 0;
    const fixture: SourceProvider = {
      ...DEFAULT_PROVIDERS.get("forgejo")!, id: "fixture", name: "Fixture",
      detect: async () => true,
      collect: async (source, context) => {
        await context.fetch!("https://outside.example.invalid/api/v1/user", { headers: { authorization: source.token } });
        throw new Error("unreachable");
      },
    };
    await expect(collect({ sources: [{ ...SOURCE, provider: "fixture" }], fetch: async () => { calls++; return json({}); } }, { providers: new Map([[fixture.id, fixture]]) })).rejects.toThrow("Fixture source 1 failed");
    expect(calls).toBe(0);
  });

  test("changing providers cannot reuse another provider's cache and failures preserve caller data", async () => {
    const cache = { version: 3 as const, sources: { "other:same": { provider: "other", version: 1, data: { days: { "2020-01-01": 99 } } } } };
    const fixture: SourceProvider = {
      ...DEFAULT_PROVIDERS.get("forgejo")!, id: "fixture", name: "Fixture", instanceId: () => "same",
      collect: async (_source, context) => {
        expect(context.cache).toBeUndefined();
        throw new ProviderError("account", "http", 401);
      },
    };
    const before = JSON.stringify(cache);
    await expect(collect({ sources: [{ ...SOURCE, provider: "fixture" }], cache }, { providers: new Map([[fixture.id, fixture]]) })).rejects.toThrow("account failed with HTTP 401");
    expect(JSON.stringify(cache)).toBe(before);
  });

  test("provider identities are namespaced in SVG data and identity failures cannot leak credentials", async () => {
    const base = DEFAULT_PROVIDERS.get("forgejo")!;
    const make = (id: string): SourceProvider => ({
      ...base, id, name: "Fixture", instanceId: () => "same",
      collect: async () => ({
        activity: { host: id, login: "", days: { "2026-10-02": 2 }, totals: { ...emptyTotals(), contributions: 2 }, languages: {}, repos: { public: 0, private: 0 } },
        cache: {}, sensitive: new SensitiveNames(),
      }),
    });
    const providers = new Map([make("alpha"), make("beta")].map((provider) => [provider.id, provider]));
    const result = await collect({ sources: [{ ...SOURCE, provider: "alpha" }, { ...SOURCE, id: "second", label: "Second", color: "#2878c8", provider: "beta" }], now: NOW }, { providers });
    expect(result.activity.hosts.map((host) => host.source!.id)).toEqual(["alpha:same", "beta:same"]);
    expect(result.sourceProviders).toEqual(["alpha", "beta"]);
    const svg = renderHeatmapCard(result.activity, { mode: "hosts" });
    expect(svg).toContain(SOURCE.color);
    expect(svg).toContain("#2878c8");
    providers.set("alpha", { ...make("alpha"), instanceId: () => { throw new Error(`${SOURCE.url} ${SOURCE.token}`); } });
    const error = await collect({ sources: [{ ...SOURCE, provider: "alpha" }] }, { providers }).catch((error) => error as Error);
    expect((error as Error).message).toContain("Fixture source 1 failed");
    expect((error as Error).message).not.toContain(SOURCE.token);
    expect((error as Error).message).not.toContain(SOURCE.url);
  });

  test("a failing adapter receives an isolated cache payload", async () => {
    const fixture: SourceProvider = {
      ...DEFAULT_PROVIDERS.get("forgejo")!, id: "fixture", name: "Fixture", instanceId: () => "same",
      collect: async (_source, context) => {
        (context.cache as { days: Record<string, number> }).days["2020-01-01"] = 0;
        throw new Error("upstream failed");
      },
    };
    const cache = { version: 3 as const, sources: { "fixture:same": { provider: "fixture", version: 1, data: { days: { "2020-01-01": 99 } } } } };
    await expect(collect({ sources: [{ ...SOURCE, provider: "fixture" }], cache }, { providers: new Map([[fixture.id, fixture]]) })).rejects.toThrow();
    expect(cache.sources["fixture:same"].data.days["2020-01-01"]).toBe(99);
  });

  test("normalizing automatic options can intentionally remove the supplied object", async () => {
    const fixture: SourceProvider = { ...DEFAULT_PROVIDERS.get("forgejo")!, id: "fixture", name: "Fixture", normalizeOptions: () => undefined, detect: async () => true };
    const resolved = await resolveSources([{ ...SOURCE, options: {} }], {}, new Map([[fixture.id, fixture]]));
    expect(resolved[0]).not.toHaveProperty("options");
  });

  test("migrates disabled v2 GitLab buckets and reuses the same history through unified config", async () => {
    const other = { ...SOURCE, id: "other", url: "https://other.example.invalid" };
    const routes = [gitlabRoute(SOURCE.url), gitlabRoute(other.url)];
    const { fetch } = mockFetch((call) => routes.map((route) => route(call)).find(Boolean));
    const first = await collect({ gitlabSources: [SOURCE, other], fetch, now: NOW });
    const workId = gitlabInstanceId(SOURCE.url);
    const otherId = gitlabInstanceId(other.url);
    const work = first.cache.sources![`gitlab:${workId}`]!.data as GitLabCache;
    const disabled = first.cache.sources![`gitlab:${otherId}`]!.data as GitLabCache;
    work.days["2020-01-01"] = { contributions: 5, commits: 5, issues: 0, pullRequests: 0, reviews: 0 };
    const migrated = parseCache(JSON.stringify({ version: 2, gitlabs: { [workId]: work, [otherId]: disabled } }))!;
    const second = await collect({ sources: [{ ...SOURCE, provider: "gitlab" }], cache: migrated, fetch, now: NOW });
    expect(second.activity.hosts[0]!.days["2020-01-01"]).toBe(5);
    expect(second.activity.hosts[0]!.source!.id).toBe(`gitlab:${workId}`);
    expect(second.cache.sources![`gitlab:${otherId}`]!.data).toEqual(disabled);
    expect(second.cache.sources![`gitlab:${workId}`]!.data).toEqual(work);
    expect(JSON.stringify(second.cache)).not.toContain(SOURCE.url);
  });

  test("migration preserves old GitLab identities containing an explicit default port", async () => {
    const source = { ...SOURCE, url: "https://source.example.invalid:443/service" };
    const { fetch } = mockFetch(gitlabRoute(SOURCE.url));
    const first = await collect({ gitlabSources: [source], fetch, now: NOW });
    const instance = gitlabInstanceId(source.url);
    expect(instance).not.toBe(gitlabInstanceId(SOURCE.url));
    const data = first.cache.sources![`gitlab:${instance}`]!.data as GitLabCache;
    data.days["2020-01-01"] = { contributions: 7, commits: 7, issues: 0, pullRequests: 0, reviews: 0 };
    const migrated = parseCache(JSON.stringify({ version: 2, gitlabs: { [instance]: data } }));
    const next = await collect({ sources: [{ ...source, provider: "gitlab" }], fetch, now: NOW, cache: migrated });
    expect(next.activity.hosts[0]!.days["2020-01-01"]).toBe(7);
    expect(next.activity.hosts[0]!.source!.id).toBe(`gitlab:${instance}`);
    expect(Object.keys(next.cache.sources!)).toEqual([`gitlab:${instance}`]);
  });

  test("known malformed cache schemas fail instead of silently discarding archived activity", async () => {
    for (const cache of [
      { version: 3, sources: [] },
      { version: 3, sources: { "forgejo:hash": { provider: "forgejo", version: 0, data: {} } } },
      { version: 3, sources: { "forgejo:private.example.invalid": { provider: "forgejo", version: 1, data: {} } } },
      { version: 2, gitlabs: { hash: { instance: "different" } } },
      { version: 1, gitlab: { instance: 3 } },
    ]) expect(() => parseCache(JSON.stringify(cache))).toThrow("Previous history was not replaced");
    const key = `gitlab:${gitlabInstanceId(SOURCE.url)}`;
    const cache = { version: 3 as const, sources: { [key]: { provider: "gitlab", version: 1, data: { days: { "2020-01-01": 9 } } } } };
    const { fetch, calls } = mockFetch(() => { throw new Error("should not fetch"); });
    await expect(collect({ sources: [{ ...SOURCE, provider: "gitlab" }], cache, fetch })).rejects.toThrow("cache returned invalid activity data");
    expect(calls).toHaveLength(0);
    expect(cache.sources[key]!.data.days["2020-01-01"]).toBe(9);
  });
});
