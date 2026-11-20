import { describe, expect, test } from "bun:test";
import { collect } from "../src/collect.ts";
import { manualSourceColor, parseManualContribution, validateManualContribution, type ManualContributionDocument } from "../src/manual.ts";
import { GITLAB_EVENTS, githubRoute, gitlabRoute, NOW, PRIVATE_NAMES } from "./fixtures.ts";
import { mockFetch } from "./mock.ts";

const example = (): ManualContributionDocument => ({
  schemaVersion: 1,
  source: { id: "exbo", name: "EXBO", type: "manual", metric: "commits" },
  timezone: "Europe/Moscow",
  days: { "2026-10-01": 3, "2026-09-30": 2 },
});

describe("manual contribution documents", () => {
  test("normalizes a document without mutating its input", () => {
    const original = example();
    original.source.color = "A855F7";
    const document = validateManualContribution(original);
    expect(document.source).toEqual({ id: "exbo", name: "EXBO", type: "manual", metric: "commits", color: "#a855f7" });
    expect(Object.keys(document.days)).toEqual(["2026-09-30", "2026-10-01"]);
    expect(Object.keys(original.days)).toEqual(["2026-10-01", "2026-09-30"]);
    expect(original.source.color).toBe("A855F7");
    expect(parseManualContribution(JSON.stringify(document))).toEqual(document);
    expect(manualSourceColor("exbo")).toBe(manualSourceColor("exbo"));
  });

  test("allows empty histories and real leap days", () => {
    expect(validateManualContribution({ ...example(), days: {} }).days).toEqual({});
    expect(validateManualContribution({ ...example(), days: { "2024-02-29": 0 } }).days).toEqual({ "2024-02-29": 0 });
    expect(validateManualContribution({ ...example(), source: { ...example().source, name: "Работа 🌍" } }).source.name).toBe("Работа 🌍");
  });

  test("rejects malformed documents and extra private metadata without echoing values", () => {
    const secret = "do-not-print-person@example.invalid";
    const invalid: unknown[] = [
      null, [], 12,
      { ...example(), schemaVersion: 2 },
      { ...example(), emails: [secret] },
      { ...example(), source: { ...example().source, email: secret } },
      { ...example(), source: { ...example().source, name: "\n" } },
      { ...example(), source: { ...example().source, name: "invalid\ud800" } },
      { ...example(), source: { ...example().source, name: "invalid\uffff" } },
      { ...example(), source: { ...example().source, id: "../private" } },
      { ...example(), source: { ...example().source, id: "con" } },
      { ...example(), source: { ...example().source, metric: secret } },
      { ...example(), source: { ...example().source, type: secret } },
      { ...example(), source: { ...example().source, color: secret } },
      { ...example(), timezone: secret },
      { ...example(), timezone: "+03:00" },
      { ...example(), days: { [secret]: 1 } },
      { ...example(), days: { "2026-02-29": 1 } },
      { ...example(), days: { "2026-04-31": 1 } },
      { ...example(), days: { "2026-1-01": 1 } },
      { ...example(), days: null },
    ];
    for (const value of invalid) {
      let message = "";
      try { validateManualContribution(value); } catch (error) { message = (error as Error).message; }
      expect(message).toStartWith("Invalid manual contributions:");
      expect(message).not.toContain(secret);
    }
    expect(() => parseManualContribution(`{"email":"${secret}",}`)).toThrow("document must be valid JSON");
  });

  test("rejects unsafe daily counts and total overflow", () => {
    for (const count of [-1, 0.5, NaN, Infinity, "2", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateManualContribution({ ...example(), days: { "2026-01-01": count } })).toThrow("daily counts");
    }
    expect(() => validateManualContribution({ ...example(), days: { "2026-01-01": Number.MAX_SAFE_INTEGER, "2026-01-02": 1 } })).toThrow("total count");
  });
});

describe("manual collection", () => {
  test("supports manual-only data without network access and without inventing other metrics", async () => {
    const result = await collect({ manualSources: [example()], now: NOW, fetch: async () => { throw new Error("Unexpected network access"); } });
    expect(result.activity.totals).toEqual({ contributions: 5, commits: 5, pullRequests: 0, issues: 0, reviews: 0, stars: 0, followers: 0, contributedTo: 0 });
    expect(result.activity.hosts[0]).toMatchObject({ host: "manual", login: "", repos: { public: 0, private: 0 }, languages: {} });
    expect(result.activity.hosts[0]!.source).toEqual({ id: "manual:exbo", label: "EXBO", color: manualSourceColor("exbo"), metric: "commits", timezone: "Europe/Moscow" });
    expect(result.cache).toEqual({ version: 3 });
    expect(result.mirrored).toBe(0);
  });

  test("replaces snapshots on repeated runs rather than adding them to cached counts", async () => {
    const first = await collect({ manualSources: [example()], now: NOW });
    const second = await collect({ manualSources: [{ ...example(), days: { "2026-10-01": 1 } }], cache: first.cache, now: NOW });
    expect(second.activity.days).toEqual({ "2026-10-01": 1 });
    expect(second.activity.totals.commits).toBe(1);
    expect(second.cache).toEqual(first.cache);
  });

  test("combines GitHub, two GitLab servers and manual commits with isolated identities", async () => {
    const sources = [
      { id: "one", label: "One", color: "#123456", token: "token-one", url: "https://one.example.invalid" },
      { id: "two", label: "Two", color: "#654321", token: "token-two", url: "https://two.example.invalid" },
    ];
    const routes = [gitlabRoute(sources[0]!.url), gitlabRoute(sources[1]!.url, GITLAB_EVENTS.slice(4))];
    const api = mockFetch((call) => githubRoute(call) ?? routes[0]!(call) ?? routes[1]!(call));
    const result = await collect({ githubToken: "github-secret", gitlabSources: sources, manualSources: [example()], fetch: api.fetch, now: NOW });
    expect(result.activity.hosts.map((host) => host.host)).toEqual(["github", "gitlab", "gitlab", "manual"]);
    expect(result.activity.totals).toMatchObject({ contributions: 39, commits: 75, stars: 17 });
    expect(Object.keys(result.cache.sources!)).toHaveLength(2);
    expect(JSON.stringify(result.cache)).not.toContain("EXBO");
    const written = JSON.stringify({ activity: result.activity, cache: result.cache });
    for (const secret of [...PRIVATE_NAMES, ...sources.flatMap((source) => [source.url, source.token]), "github-secret"]) expect(written).not.toContain(secret);
  });

  test("rejects invalid or duplicate documents before requesting automatic data", async () => {
    let requested = false;
    const fetch = async () => { requested = true; throw new Error("Network must not be called"); };
    await expect(collect({ githubToken: "t", manualSources: [example(), example()], fetch })).rejects.toThrow("duplicate source identifiers");
    await expect(collect({ githubToken: "t", manualSources: null as unknown as ManualContributionDocument[], fetch })).rejects.toThrow("array of documents");
    expect(requested).toBe(false);
    await expect(collect({ manualSources: [] })).rejects.toThrow("No automatic or manual activity sources");
  });

  test("rejects overflow across otherwise valid snapshots and automatic counts", async () => {
    const large = { ...example(), days: { "2026-10-01": Number.MAX_SAFE_INTEGER } };
    const other = { ...example(), source: { ...example().source, id: "other" }, days: { "2026-10-02": 1 } };
    await expect(collect({ manualSources: [large, other] })).rejects.toThrow("safe integer range");
    await expect(collect({ githubToken: "t", manualSources: [large], fetch: mockFetch(githubRoute).fetch, now: NOW })).rejects.toThrow("safe integer range");
  });
});
