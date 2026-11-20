import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, fetchGitLab, parseCache, svgHeight, svgWidth, type Collected } from "@git-info-combine/core";
import { GITLAB_EVENTS, githubRoute, gitlabRoute, NOW, PRIVATE_NAMES } from "../../core/test/fixtures.ts";
import { mockFetch } from "../../core/test/mock.ts";
import { readConfig } from "../src/inputs.ts";
import { run } from "../src/run.ts";

const sources = [
  { id: "work", url: "https://work.example.internal", token: "work-secret-token", label: "Work", color: "#a855f7" },
  { id: "personal", url: "https://personal.example.internal", token: "personal-secret-token", label: "Personal", color: "#fc6d26" },
];

function config() {
  const inputs: Record<string, string> = {
    "github-token": "github-secret-token",
    "gitlab-sources": JSON.stringify(sources),
    cards: "heatmap,stats,hosts,languages",
    layout: "heatmap\nstats hosts\nlanguages",
    commit: "false",
  };
  return readConfig((name) => inputs[name] ?? "");
}

function logger() {
  const lines: string[] = [];
  return { lines, info: (line: string) => void lines.push(line), warning: (line: string) => void lines.push(line) };
}

async function readOutputs(workspace: string) {
  const directory = join(workspace, "git-info-combine");
  const files = (await readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(join(directory, file), "utf8")])));
}

describe("multiple GitLab servers through the complete Action pipeline", () => {
  test("migrates old history, isolates credentials and renders each server in standalone cards and layouts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gic-multiple-"));
    const old = await fetchGitLab({
      token: sources[0]!.token,
      baseUrl: sources[0]!.url,
      fetch: mockFetch(gitlabRoute(sources[0]!.url)).fetch,
      now: NOW,
    });
    await mkdir(join(workspace, "git-info-combine"));
    await writeFile(join(workspace, "git-info-combine/cache.json"), JSON.stringify({ version: 1, gitlab: old.cache }));

    // The first server has already removed an old event. Only its migrated cache can retain it.
    const routes = [gitlabRoute(sources[0]!.url, GITLAB_EVENTS.slice(1)), gitlabRoute(sources[1]!.url)];
    const api = mockFetch((call) => githubRoute(call) ?? routes[0]!(call) ?? routes[1]!(call));
    const collected: Collected[] = [];
    const log = logger();
    const result = await run(config(), {
      workspace,
      logger: log,
      collect: async (options) => {
        const value = await collect({ ...options, fetch: api.fetch, now: NOW });
        collected.push(value);
        return value;
      },
    });

    expect(result.committed).toBe(false);
    const activity = collected[0]!.activity;
    expect(activity.hosts.map((host) => host.source?.label ?? "GitHub")).toEqual(["GitHub", "Work", "Personal"]);
    expect(activity.totals.contributions).toBe(37);
    expect(activity.totals.commits).toBe(70);
    expect(activity.hosts[1]!.days).toEqual(activity.hosts[2]!.days);
    for (const source of sources) {
      const calls = api.calls.filter((call) => call.url.origin === source.url);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.headers.get("authorization") === `Bearer ${source.token}`)).toBe(true);
    }

    const outputs = await readOutputs(workspace);
    for (const name of ["heatmap", "stats", "hosts", "layout"]) {
      for (const suffix of ["", "-light", "-dark"]) {
        const svg = outputs[`${name}${suffix}.svg`]!;
        expect(svg).toContain("Work");
        expect(svg).toContain("Personal");
        expect(svg).toContain("#a855f7");
        expect(svg).toContain("#fc6d26");
        expect(svg).not.toMatch(/NaN|Infinity/);
      }
    }
    expect(svgWidth(outputs["row-2.svg"]!)).toBe(800);
    expect(svgHeight(outputs["stats.svg"]!)).toBe(svgHeight(outputs["hosts.svg"]!));
    const persisted = parseCache(outputs["cache.json"]);
    expect(persisted?.version).toBe(3);
    expect(Object.keys(persisted?.sources ?? {})).toHaveLength(2);

    const written = JSON.stringify({ outputs, logs: log.lines });
    for (const sensitive of [...PRIVATE_NAMES, ...sources.flatMap((source) => [new URL(source.url).hostname, source.token]), "github-secret-token"]) {
      expect(written.toLowerCase()).not.toContain(sensitive.toLowerCase());
    }
  });

  test("a later server failure leaves every previously generated card and cache unchanged", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gic-multiple-failure-"));
    const routes = sources.map((source) => gitlabRoute(source.url));
    const first = mockFetch((call) => githubRoute(call) ?? routes[0]!(call) ?? routes[1]!(call));
    await run(config(), { workspace, logger: logger(), collect: (options) => collect({ ...options, fetch: first.fetch, now: NOW }) });
    const before = await readOutputs(workspace);

    const failing = mockFetch((call) => {
      if (call.url.origin === sources[1]!.url) return new Response(null, { status: 401 });
      return githubRoute(call) ?? routes[0]!(call);
    });
    let commits = 0;
    const next = { ...config(), commit: true };
    await expect(run(next, {
      workspace,
      logger: logger(),
      collect: (options) => collect({ ...options, fetch: failing.fetch, now: NOW }),
      commit: async () => { commits++; return true; },
    })).rejects.toThrow();
    expect(commits).toBe(0);
    expect(await readOutputs(workspace)).toEqual(before);
  });
});
