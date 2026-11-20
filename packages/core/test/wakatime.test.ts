import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/http.ts";
import { fetchWakaTime } from "../src/wakatime.ts";
import { json, mockFetch, noSleep } from "./mock.ts";

const KEY = "synthetic-waka-credential";
const READY = {
  status: "ok", is_up_to_date: true, human_readable_total: "12 hrs 5 mins",
  languages: [{ name: "TypeScript", percent: 70.5, text: "8 hrs 30 mins", total_seconds: 30_600 }],
  projects: [{ name: "private-synthetic-project" }],
  email: "private-synthetic@example.invalid",
};

describe("WakaTime readiness polling", () => {
  test("waits through 202 and contradictory flags before returning only ready language statistics", async () => {
    const replies = [
      () => json({ data: READY }, {}, 202),
      () => json({ data: { ...READY, is_up_to_date: false } }),
      () => json({ data: { ...READY, status: "pending_update" } }),
      () => json({ data: READY }),
    ];
    const waits: number[] = [];
    const fixture = mockFetch(() => replies.shift()!());
    const stats = await fetchWakaTime({ apiKey: KEY, range: "last_30_days", fetch: fixture.fetch, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([10_000, 20_000, 30_000]);
    expect(fixture.calls).toHaveLength(4);
    expect(stats).toEqual({
      range: "last_30_days", total: "12 hrs 5 mins", ready: true,
      languages: [{ name: "TypeScript", percent: 70.5, text: "8 hrs 30 mins" }],
    });
    for (const call of fixture.calls) {
      expect(call.url.href).toBe("https://wakatime.com/api/v1/users/current/stats/last_30_days");
      expect(call.headers.get("authorization")).toBe(`Basic ${btoa(KEY)}`);
      expect(call.url.search).toBe("");
    }
    expect(JSON.stringify(stats)).not.toContain("private-synthetic");
    expect(JSON.stringify(stats)).not.toContain(KEY);
  });

  test("every explicit pending signal takes priority over ready flags and existing values", async () => {
    for (const data of [
      { ...READY, status: "pending_update" },
      { ...READY, is_up_to_date: false },
      { ...READY, status: undefined, is_up_to_date: false },
      { status: "updating", is_up_to_date: true },
    ]) {
      const waits: number[] = [];
      const fixture = mockFetch(() => json({ data }));
      await expect(fetchWakaTime({ apiKey: KEY, fetch: fixture.fetch, sleep: async (ms) => void waits.push(ms) }))
        .rejects.toThrow("still calculating after 4 attempts");
      expect(fixture.calls).toHaveLength(4);
      expect(waits).toEqual([10_000, 20_000, 30_000]);
    }
  });

  test("an empty HTTP 202 response is pending and never becomes a fabricated zero", async () => {
    const fixture = mockFetch(() => new Response(null, { status: 202 }));
    await expect(fetchWakaTime({ apiKey: KEY, range: "last_30_days", fetch: fixture.fetch, sleep: noSleep }))
      .rejects.toThrow("last_30_days are still calculating");
    expect(fixture.calls).toHaveLength(4);
    expect(fixture.calls.every((call) => call.url.pathname.endsWith("/last_30_days"))).toBe(true);
  });

  test("accepts validated compatible-server data with absent readiness flags", async () => {
    for (const flags of [{}, { status: "ok" }, { is_up_to_date: true }]) {
      const fixture = mockFetch(() => json({ data: { human_readable_total: "1 hr", languages: [], ...flags } }));
      const stats = await fetchWakaTime({ apiKey: KEY, apiUrl: "https://wakapi.example.invalid/api/compat/wakatime/v1/", fetch: fixture.fetch });
      expect(stats).toEqual({ range: "last_7_days", total: "1 hr", ready: true, languages: [] });
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0]!.url.pathname).toBe("/api/compat/wakatime/v1/users/current/stats/last_7_days");
      expect(fixture.calls[0]!.headers.get("authorization")).toBe(`Basic ${btoa(KEY)}`);
    }
  });

  test("accepts genuine zero activity without polling", async () => {
    const fixture = mockFetch(() => json({ data: { status: "ok", is_up_to_date: true, human_readable_total: "0 secs", languages: [] } }));
    expect(await fetchWakaTime({ apiKey: KEY, fetch: fixture.fetch })).toEqual({ range: "last_7_days", total: "0 secs", ready: true, languages: [] });
    expect(fixture.calls).toHaveLength(1);
  });

  test("rejects malformed ready data instead of inventing totals or language entries", async () => {
    const invalid = [
      null, [], {}, { data: null }, { data: [] },
      { data: { ...READY, status: true } },
      { data: { ...READY, is_up_to_date: "true" } },
      { data: { ...READY, human_readable_total: undefined } },
      { data: { ...READY, human_readable_total: " " } },
      { data: { ...READY, human_readable_total: 0 } },
      { data: { ...READY, languages: undefined } },
      { data: { ...READY, languages: null } },
      { data: { ...READY, languages: {} } },
      ...[
        null, {}, { name: "", percent: 10, text: "1 hr" },
        { name: "TypeScript", percent: 10, text: " " },
        ...[-1, 101, NaN, Infinity, "10"].map((percent) => ({ name: "TypeScript", percent, text: "1 hr" })),
      ].map((language) => ({ data: { ...READY, languages: [language] } })),
    ];
    for (const body of invalid) {
      const fixture = mockFetch(() => json(body));
      await expect(fetchWakaTime({ apiKey: KEY, fetch: fixture.fetch, sleep: noSleep })).rejects.toThrow("invalid statistics data");
      expect(fixture.calls).toHaveLength(1);
    }
  });

  test("only HTTP 200 may publish data; unexpected successful statuses fail", async () => {
    for (const status of [201, 204, 206]) {
      const fixture = mockFetch(() => status === 204 ? new Response(null, { status }) : json({ data: READY }, {}, status));
      await expect(fetchWakaTime({ apiKey: KEY, fetch: fixture.fetch, sleep: noSleep })).rejects.toThrow(`HTTP ${status}`);
      expect(fixture.calls).toHaveLength(1);
    }
  });

  test("authentication errors fail immediately without exposing server paths or bodies", async () => {
    for (const status of [401, 403]) {
      const waits: number[] = [];
      const fixture = mockFetch(() => json({ error: `private-synthetic-project ${KEY}` }, {}, status));
      const error = await fetchWakaTime({
        apiKey: KEY, apiUrl: "https://private-host.example.invalid/private-installation", fetch: fixture.fetch,
        sleep: async (ms) => void waits.push(ms),
      }).catch((error: unknown) => error) as Error;
      expect(error).toBeInstanceOf(HttpError);
      expect(error.message).toBe(`WakaTime statistics request failed with HTTP ${status}.`);
      expect(fixture.calls).toHaveLength(1);
      expect(waits).toEqual([]);
    }
  });

  test("network and malformed JSON diagnostics never include credentials or upstream content", async () => {
    const privateMessage = `${KEY} private-synthetic-project https://private-host.example.invalid/private-installation`;
    for (const fetch of [
      async () => { throw new Error(privateMessage); },
      async () => new Response(privateMessage, { headers: { "content-type": "text/html" } }),
    ]) {
      const error = await fetchWakaTime({ apiKey: KEY, fetch }).catch((error: unknown) => error) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("private-synthetic");
      expect(error.message).not.toContain("private-host");
    }
  });

  test("shared HTTP retries remain active within readiness polling", async () => {
    const replies = [
      () => json({}, { "retry-after": "2" }, 429),
      () => json({}, {}, 503),
      () => json({ data: { status: "pending_update" } }),
      () => json({ data: READY }),
    ];
    const waits: number[] = [];
    const fixture = mockFetch(() => replies.shift()!());
    expect((await fetchWakaTime({ apiKey: KEY, fetch: fixture.fetch, sleep: async (ms) => void waits.push(ms) })).ready).toBe(true);
    expect(waits).toEqual([2000, 2000, 10_000]);
    expect(fixture.calls).toHaveLength(4);
  });
});

describe("WakaTime polling deadline", () => {
  test("bounds an unresponsive injected fetch and aborts its signal", async () => {
    let signal: AbortSignal | null | undefined;
    const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      signal = init?.signal;
      return new Promise(() => {});
    };
    await expect(fetchWakaTime({ apiKey: KEY, fetch, timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
  });

  test("bounds response body parsing", async () => {
    const fetch = async () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } });
    await expect(fetchWakaTime({ apiKey: KEY, fetch, timeoutMs: 10 })).rejects.toThrow("timed out");
  });

  test("bounds cancellation of an incomplete HTTP 202 response body", async () => {
    const fetch = async () => new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), { status: 202 });
    await expect(fetchWakaTime({ apiKey: KEY, fetch, timeoutMs: 10 })).rejects.toThrow("timed out");
  });

  test("cancels the default polling timer before a second request", async () => {
    const fixture = mockFetch(() => json({ data: { status: "pending_update" } }));
    await expect(fetchWakaTime({ apiKey: KEY, fetch: fixture.fetch, timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(fixture.calls).toHaveLength(1);
  });

  test("bounds injected polling waits as well", async () => {
    const fixture = mockFetch(() => json({ data: { status: "pending_update" } }));
    await expect(fetchWakaTime({ apiKey: KEY, fetch: fixture.fetch, timeoutMs: 10, sleep: () => new Promise(() => {}) })).rejects.toThrow("timed out");
    expect(fixture.calls).toHaveLength(1);
  });

  test("cancels long Retry-After waits within the same deadline", async () => {
    const fixture = mockFetch(() => json({}, { "retry-after": "86400" }, 429));
    await expect(fetchWakaTime({ apiKey: KEY, fetch: fixture.fetch, timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(fixture.calls).toHaveLength(1);
  });

  test("reuses the same deadline across polling attempts", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      signals.push(init?.signal);
      return signals.length === 1 ? json({ data: { status: "pending_update" } }) : new Promise(() => {});
    };
    await expect(fetchWakaTime({ apiKey: KEY, fetch, timeoutMs: 50, sleep: () => new Promise((resolve) => setTimeout(resolve, 20)) })).rejects.toThrow("timed out");
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
  });

  test("caps large caller budgets and safely rejects invalid timeouts", async () => {
    const fixture = mockFetch(() => json({ data: READY }));
    expect((await fetchWakaTime({ apiKey: KEY, fetch: fixture.fetch, timeoutMs: Number.MAX_SAFE_INTEGER })).ready).toBe(true);
    for (const timeoutMs of [0, -1, NaN, Infinity, 0.5]) {
      await expect(fetchWakaTime({ apiKey: KEY, fetch: fixture.fetch, timeoutMs })).rejects.toThrow("positive integer request timeout");
    }
    expect(fixture.calls).toHaveLength(1);
  });
});
