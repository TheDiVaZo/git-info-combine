import { describe, expect, test } from "bun:test";
import { detectForgejo, fetchForgejo, forgejoInstanceId, type ForgejoCache } from "../src/forgejo.ts";
import { ProviderError } from "../src/provider.ts";
import { addDays, type Fetch } from "../src/model.ts";
import { json, mockFetch, noSleep } from "./mock.ts";

const BASE = "https://private-forge.example.invalid/service";
const TOKEN = "private-fixture-token";
const LOGIN = "private-fixture-account";
const NOW = new Date("2026-11-20T12:00:00Z");
const START = addDays("2026-11-20", -370);
const PARTIAL = addDays(START, -1);
const unix = (date: string) => Date.parse(date) / 1000;
const account = { id: 17, login: LOGIN, email: "private-fixture@example.invalid", full_name: "Private Fixture Name" };
const bucket = (date: string, contributions = 1) => ({ timestamp: unix(date), contributions });

function fixture(entries: unknown = [], extra: { account?: unknown; date?: string; response?: Response } = {}) {
  return mockFetch(({ url }) => {
    if (url.pathname === "/service/api/v1/user") return json(extra.account ?? account);
    if (url.pathname === `/service/api/v1/users/${encodeURIComponent(LOGIN)}/heatmap`) return extra.response ?? json(entries, extra.date ? { date: extra.date } : {});
    return undefined;
  });
}

function run(entries: unknown = [], extra: { cache?: ForgejoCache; account?: unknown; date?: string; response?: Response } = {}) {
  const { fetch } = fixture(entries, extra);
  return fetchForgejo({ baseUrl: BASE, token: TOKEN, now: NOW, cache: extra.cache, fetch, sleep: noSleep });
}

function cache(days: Record<string, number>): ForgejoCache {
  return { instance: forgejoInstanceId(BASE), userId: account.id, days };
}

describe("Forgejo discovery", () => {
  test("uses only the Forgejo-specific public endpoint and checks its response", async () => {
    const { fetch, calls } = mockFetch(({ url }) => url.pathname === "/service/api/forgejo/v1/version" ? json({ version: "17.0.0+gitea-1.22.0" }) : undefined);
    expect(await detectForgejo({ baseUrl: BASE + "/", fetch })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.has("authorization")).toBe(false);
    expect(calls[0]!.url.origin).toBe(new URL(BASE).origin);
    for (const response of [json({ version: "1.0" }, {}, 404), json({ version: "" }), json({ version: 17 }), json([]), json(null)]) {
      expect(await detectForgejo({ baseUrl: BASE, fetch: async () => response })).toBe(false);
    }
  });

  test("does not classify HTML, unauthorized or unavailable endpoints as Forgejo", async () => {
    for (const status of [401, 403, 500]) {
      await expect(detectForgejo({ baseUrl: BASE, retries: 0, fetch: async () => json({ private: TOKEN }, {}, status) })).rejects.toThrow(`HTTP ${status}`);
    }
    await expect(detectForgejo({ baseUrl: BASE, fetch: async () => new Response("<html>private login page</html>", { headers: { "content-type": "text/html" } }) })).rejects.toThrow("non-JSON");
  });
});

describe("Forgejo native calendar", () => {
  test("combines UTC buckets into sorted days without inventing detailed metrics or exposing account metadata", async () => {
    const { fetch, calls } = fixture([
      bucket("2026-11-20T00:15:00Z", 3), bucket("2026-11-19T23:45:00Z", 4), bucket("2026-11-20T00:00:00Z", 2),
    ]);
    const result = await fetchForgejo({ baseUrl: BASE, token: TOKEN, now: NOW, fetch });
    expect(result.activity.days).toEqual({ "2026-11-19": 4, "2026-11-20": 5 });
    expect(Object.keys(result.activity.days)).toEqual(["2026-11-19", "2026-11-20"]);
    expect(result.activity.host).toBe("forgejo");
    expect(result.activity.login).toBe("");
    expect(result.activity.totals.contributions).toBe(9);
    expect(result.activity.totals.commits).toBe(0);
    expect(result.activity.languages).toEqual({});
    expect(result.activity.repos).toEqual({ public: 0, private: 0 });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.headers.get("authorization") === `token ${TOKEN}`)).toBe(true);
    const output = JSON.stringify({ activity: result.activity, cache: result.cache });
    for (const value of [BASE, new URL(BASE).hostname, TOKEN, LOGIN, account.email, account.full_name]) expect(output).not.toContain(value);
    expect(result.cache.userId).toBe(account.id);
  });

  test("does not mistake common account names for structural secrets", async () => {
    const fetch: Fetch = async (url) => url.endsWith("/user") ? json({ id: 17, login: "days" }) : json([bucket("2026-11-19T12:00:00Z", 2)]);
    expect((await fetchForgejo({ baseUrl: BASE, token: TOKEN, now: NOW, fetch })).activity.days).toEqual({ "2026-11-19": 2 });
  });

  test("preserves installation subpaths, encodes the account route and disables redirects with a deadline", async () => {
    const urls: string[] = [];
    const fetch: Fetch = async (url, init) => {
      urls.push(url);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return url.endsWith("/user") ? json({ id: 17, login: "fixture+account/name" }) : json([]);
    };
    await fetchForgejo({ baseUrl: BASE + "/", token: TOKEN, now: NOW, fetch });
    expect(urls).toEqual([BASE + "/api/v1/user", BASE + "/api/v1/users/fixture%2Baccount%2Fname/heatmap"]);
    await detectForgejo({ baseUrl: BASE, fetch: async (_url, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return json({ version: "17.0.0" });
    } });
  });

  test("drops the incomplete oldest date on first fetch and keeps the first complete date", async () => {
    const result = await run([bucket(`${PARTIAL}T23:45:00Z`, 5), bucket(`${START}T00:00:00Z`, 7)]);
    expect(result.activity.days).toEqual({ [START]: 7 });
  });

  test("replaces the current window including disappeared dates while retaining older and boundary history", async () => {
    const previous = cache({ "2024-01-11": 9, [PARTIAL]: 8, [START]: 2, "2026-11-19": 4, "2026-11-20": 6 });
    const snapshot = JSON.stringify(previous);
    const result = await run([bucket(`${PARTIAL}T23:45:00Z`, 100), bucket("2026-11-19T12:00:00Z", 1)], { cache: previous });
    expect(result.activity.days).toEqual({ "2024-01-11": 9, [PARTIAL]: 8, "2026-11-19": 1 });
    expect(result.activity.totals.contributions).toBe(18);
    expect(JSON.stringify(previous)).toBe(snapshot);
    const repeated = await run([bucket("2026-11-19T12:00:00Z", 1)], { cache: result.cache });
    expect(repeated.cache).toEqual(result.cache);
  });

  test("empty calendars clear recent counts and retain only archived history", async () => {
    const result = await run([], { cache: cache({ "2024-01-11": 9, [PARTIAL]: 8, [START]: 2, "2026-11-19": 4 }) });
    expect(result.activity.days).toEqual({ "2024-01-11": 9, [PARTIAL]: 8 });
    expect((await run()).activity.days).toEqual({});
  });

  test("server HTTP Date controls the UTC window with local time as fallback", async () => {
    const future = bucket("2026-11-21T00:00:00Z", 3);
    const result = await run([future], { date: "Sat, 21 Nov 2026 00:15:00 GMT" });
    expect(result.activity.days).toEqual({ "2026-11-21": 3 });
    const fallback = await run([bucket("2026-11-20T00:00:00Z", 2)], { date: "invalid HTTP date" });
    expect(fallback.activity.days).toEqual({ "2026-11-20": 2 });
    await expect(run([future])).rejects.toMatchObject({ operation: "heatmap", code: "response" });
  });

  test("account or instance changes reset only supplied source history; token rotation retains it", async () => {
    const previous = cache({ "2024-01-11": 9 });
    expect((await run([], { cache: { ...previous, userId: 18 } })).cache.days).toEqual({});
    expect((await run([], { cache: { ...previous, instance: "different-server" } })).cache.days).toEqual({});
    const { fetch } = fixture([]);
    expect((await fetchForgejo({ baseUrl: BASE, token: "rotated-fixture-token", cache: previous, now: NOW, fetch })).cache.days).toEqual(previous.days);
  });

  test("validates account identity without returning private response fields", async () => {
    for (const value of [null, [], {}, { id: 0, login: LOGIN }, { id: 17, login: "" }, { id: 17, login: ".." }, { id: 17, login: "bad\nname" }]) {
      const { fetch } = mockFetch(() => json(value));
      await expect(fetchForgejo({ baseUrl: BASE, token: TOKEN, now: NOW, fetch })).rejects.toMatchObject({ operation: "account", code: "response" });
    }
  });

  test("rejects malformed counts, timestamps, calendars and duplicate buckets", async () => {
    const valid = bucket("2026-11-20T00:00:00Z");
    for (const entries of [null, {}, [null], [{ ...valid, contributions: -1 }], [{ ...valid, contributions: 0.5 }], [{ ...valid, contributions: "1" }], [{ ...valid, contributions: Number.MAX_SAFE_INTEGER + 1 }], [{ ...valid, timestamp: "today" }], [{ ...valid, timestamp: 1.5 }], [{ ...valid, timestamp: Number.MAX_SAFE_INTEGER }], [valid, valid]]) {
      await expect(run(entries)).rejects.toMatchObject({ operation: "heatmap", code: "response" });
    }
  });

  test("rejects daily and overall overflow including archived counts", async () => {
    await expect(run([bucket("2026-11-20T00:00:00Z", Number.MAX_SAFE_INTEGER), bucket("2026-11-20T00:15:00Z", 1)])).rejects.toMatchObject({ operation: "heatmap", code: "response" });
    await expect(run([bucket("2026-11-19T00:00:00Z", Number.MAX_SAFE_INTEGER), bucket("2026-11-20T00:15:00Z", 1)])).rejects.toMatchObject({ operation: "heatmap", code: "response" });
    await expect(run([bucket("2026-11-20T00:00:00Z", 1)], { cache: cache({ "2024-01-11": Number.MAX_SAFE_INTEGER }) })).rejects.toMatchObject({ operation: "heatmap", code: "response" });
  });

  test("rejects malformed matching cache rather than publishing corrupt archived data", async () => {
    const cases: Record<string, number>[] = [{ "bad-private-date": 1 }, { "2024-02-30": 1 }, { "2024-01-11": -1 }, { "2024-01-11": 1.5 }];
    for (const days of cases) {
      await expect(run([], { cache: cache(days) })).rejects.toMatchObject({ operation: "cache", code: "validation" });
    }
  });

  test("preserves HTTP status and operation without disclosing URLs, tokens or bodies", async () => {
    for (const operation of ["account", "heatmap"]) {
      for (const status of [401, 403, 404]) {
        const { fetch } = mockFetch(({ url }) => operation === "heatmap" && url.pathname.endsWith("/user") ? json(account) : json({ private: `${TOKEN} ${LOGIN} ${BASE}` }, {}, status));
        const error = await fetchForgejo({ baseUrl: BASE, token: TOKEN, now: NOW, fetch }).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).status).toBe(status);
        expect((error as ProviderError).operation).toBe(operation);
        expect((error as Error).message).toBe(`${operation} failed with HTTP ${status}.`);
      }
    }
  });

  test("retries rate limiting through the existing HTTP helper", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const { fetch } = mockFetch(({ url }) => url.pathname.endsWith("/user") ? json(account) : ++attempts === 1 ? json({}, { "retry-after": "1" }, 429) : json([bucket("2026-11-20T00:00:00Z", 2)]));
    const result = await fetchForgejo({ baseUrl: BASE, token: TOKEN, now: NOW, fetch, sleep: async (ms) => { waits.push(ms); } });
    expect(result.activity.totals.contributions).toBe(2);
    expect(waits).toEqual([1000]);
  });

  test("HTML, bad JSON, redirects and raw network errors never escape diagnostics", async () => {
    const responses = [
      new Response(`<html>${TOKEN}</html>`, { headers: { "content-type": "text/html" } }),
      new Response(`{"private":"${TOKEN}",`, { headers: { "content-type": "application/json" } }),
      new Response(null, { status: 302, headers: { location: "https://unrelated.example.invalid/" } }),
    ];
    for (const response of responses) {
      const error = await run([], { response }).catch((error: unknown) => error as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("heatmap");
      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as Error).message).not.toContain(BASE);
      expect((error as Error).message).not.toContain("unrelated");
    }
    const error = await fetchForgejo({ baseUrl: BASE, token: TOKEN, now: NOW, fetch: async () => { throw new Error(`${BASE} ${TOKEN}`); } }).catch((error: unknown) => error as Error);
    expect((error as Error).message).toBe("account request failed; check connection, redirects and API access.");
  });
});
