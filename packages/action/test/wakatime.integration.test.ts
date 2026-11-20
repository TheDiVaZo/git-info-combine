import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_VERSION, combine, emptyTotals, fetchWakaTime, SensitiveNames, type Collected } from "@git-info-combine/core";
import { json, mockFetch } from "../../core/test/mock.ts";
import { readConfig } from "../src/inputs.ts";
import { run } from "../src/run.ts";

const logger = { info() {}, warning() {} };
const collect = async (): Promise<Collected> => ({
  activity: combine([{
    host: "github", login: "fixture-user", days: { "2026-10-01": 3 },
    totals: { ...emptyTotals(), contributions: 3, commits: 3 },
    languages: { TypeScript: { size: 100, weight: 1, repos: 1, color: "#3178c6" } },
    repos: { public: 1, private: 0 },
  }], new Date("2026-10-02T00:00:00Z")),
  cache: { version: CACHE_VERSION }, mirrored: 0, sensitive: new SensitiveNames(),
});

function settings(commit = false) {
  const input: Record<string, string> = {
    "github-token": "fixture-token", "wakatime-api-key": "fixture-waka-key", "wakatime-range": "last_30_days",
    cards: "heatmap,stats,languages,hosts,wakatime", layout: "heatmap\nstats languages\nwakatime hosts",
    "layout-width": "800", "layout-gap": "10", "equal-heights": "false", commit: String(commit),
  };
  return readConfig((name) => input[name] ?? "");
}

async function snapshot(workspace: string) {
  const output = join(workspace, "git-info-combine");
  return Object.fromEntries(await Promise.all((await readdir(output)).sort().map(async (name) => [name, {
    content: await readFile(join(output, name), "utf8"),
    modified: (await stat(join(output, name))).mtimeMs,
  }])));
}

describe("WakaTime readiness through the Action", () => {
  test("publishes a ready combined block and preserves every byte and mtime after exhausted polling", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gic-waka-ready-"));
    const ready = mockFetch(() => json({ data: {
      status: "ok", is_up_to_date: true, human_readable_total: "2 hrs",
      languages: [{ name: "TypeScript", percent: 100, text: "2 hrs" }],
      projects: [{ name: "private-fixture-project" }],
    } }));
    await run(settings(), {
      workspace, logger, collect,
      wakatime: (options) => fetchWakaTime({ ...options, fetch: ready.fetch }),
    });
    const before = await snapshot(workspace);
    expect(Object.keys(before)).toHaveLength(28);
    for (const suffix of ["", "-light", "-dark"]) {
      expect(before[`layout${suffix}.svg`]!.content).toContain("2 hrs in the last 30 days");
      expect(before[`layout${suffix}.svg`]!.content).toContain('width="800"');
    }
    expect(JSON.stringify(before)).not.toContain("private-fixture-project");

    const pending = mockFetch(() => json({ data: { status: "pending_update", is_up_to_date: false } }, {}, 202));
    const sleeps: number[] = [];
    let commits = 0;
    await expect(run(settings(true), {
      workspace, logger, collect,
      wakatime: (options) => fetchWakaTime({ ...options, fetch: pending.fetch, sleep: async (ms) => { sleeps.push(ms); } }),
      commit: async () => { commits++; return true; },
    })).rejects.toThrow(/WakaTime/);
    expect(pending.calls).toHaveLength(4);
    expect(sleeps).toEqual([10_000, 20_000, 30_000]);
    expect(commits).toBe(0);
    expect(await snapshot(workspace)).toEqual(before);
  });

  test("a pending injected result cannot create initial output or commit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gic-waka-pending-"));
    let commits = 0;
    await expect(run(settings(true), {
      workspace, logger, collect,
      wakatime: async () => ({ range: "last_30_days", total: "0 secs", ready: false, languages: [] }),
      commit: async () => { commits++; return true; },
    })).rejects.toThrow("WakaTime statistics are still calculating");
    expect(await readdir(workspace)).toEqual([]);
    expect(commits).toBe(0);
  });
});
