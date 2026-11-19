import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, type ManualContributionDocument } from "@git-info-combine/core";
import { readConfig } from "../src/inputs.ts";
import { loadManualContributions } from "../src/manual.ts";
import { run } from "../src/run.ts";

const document = (id = "exbo"): ManualContributionDocument => ({ schemaVersion: 1, source: { id, name: "EXBO", type: "manual", metric: "commits" }, timezone: "Europe/Moscow", days: { "2026-10-01": 4 } });
const logger = { info() {}, warning() {} };
const config = () => readConfig((name) => ({ "manual-contributions-dir": "contributions/manual", cards: "heatmap", commit: "false", "heatmap-mode": "single", "icon-color": "40c463" })[name] ?? "");

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "gic-manual-"));
  await mkdir(join(root, "contributions/manual"), { recursive: true });
  return root;
}

describe("manual contribution loading", () => {
  test("an unset or missing directory is an empty source list", async () => {
    const root = await workspace();
    expect(await loadManualContributions(root)).toEqual([]);
    expect(await loadManualContributions(root, "absent/manual")).toEqual([]);
  });

  test("reads immediate JSON in stable filename order, ignoring unrelated files and nested directories", async () => {
    const root = await workspace();
    const dir = join(root, "contributions/manual");
    await writeFile(join(dir, "b.json"), JSON.stringify(document("second")));
    await writeFile(join(dir, "a.json"), JSON.stringify(document("first")));
    await writeFile(join(dir, "notes.txt"), "not JSON");
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested/ignored.json"), "invalid");
    expect((await loadManualContributions(root, "contributions/manual")).map((item) => item.source.id)).toEqual(["first", "second"]);
  });

  test("rejects escaping paths and linked directories", async () => {
    const root = await workspace();
    for (const dir of ["../private", "..\\private", root, "C:\\private", "C:private"]) {
      await expect(loadManualContributions(root, dir)).rejects.toThrow("manual-contributions-dir");
    }
    await symlink(join(root, "contributions"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(loadManualContributions(root, "linked/manual")).rejects.toThrow("real directory components");
  });

  test("a present non-directory and invalid JSON entries fail rather than appearing absent", async () => {
    const root = await workspace();
    await writeFile(join(root, "not-a-directory"), "x");
    await expect(loadManualContributions(root, "not-a-directory")).rejects.toThrow("real directory components");
    await mkdir(join(root, "contributions/manual/directory.json"));
    await expect(loadManualContributions(root, "contributions/manual")).rejects.toThrow("file 1");
  });

  test("rejects duplicate IDs and never echoes private file names or parser content", async () => {
    const root = await workspace();
    const dir = join(root, "contributions/manual");
    await writeFile(join(dir, "a.json"), JSON.stringify(document()));
    await writeFile(join(dir, "b.json"), JSON.stringify(document()));
    await expect(loadManualContributions(root, "contributions/manual")).rejects.toThrow("duplicate source identifiers");
    await writeFile(join(dir, "b.json"), '{"email":"private@example.invalid",}');
    let message = "";
    try { await loadManualContributions(root, "contributions/manual"); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("Manual contribution file 2 could not be read or has an invalid schema.");
    expect(message).not.toContain(root);
    expect(message).not.toContain("private@example.invalid");
  });
});

describe("manual-only Action", () => {
  test("accepts a manual directory without API credentials and generates light and dark cards", async () => {
    const root = await workspace();
    await writeFile(join(root, "contributions/manual/exbo.json"), JSON.stringify(document()));
    const settings = config();
    expect(settings.manualContributionsDir).toBe("contributions/manual");
    expect(settings.githubToken).toBeUndefined();
    const result = await run(settings, { workspace: root, logger, collect: (options) => collect({ ...options, now: new Date("2026-10-02T00:00:00Z"), fetch: async () => { throw new Error("No network allowed"); } }) });
    expect(result.committed).toBe(false);
    expect((await readdir(join(root, "git-info-combine"))).sort()).toEqual(["cache.json", "heatmap-dark.svg", "heatmap-light.svg", "heatmap.svg"]);
    expect(await readFile(join(root, "git-info-combine/heatmap-light.svg"), "utf8")).toContain("EXBO");
    expect(await readFile(join(root, "git-info-combine/heatmap-dark.svg"), "utf8")).toContain("--bg:#0d1117");
  });

  test("bad manual data leaves existing output and cache unchanged before API calls or commits", async () => {
    const root = await workspace();
    await writeFile(join(root, "contributions/manual/exbo.json"), "not JSON");
    const output = join(root, "git-info-combine");
    await mkdir(output);
    await writeFile(join(output, "heatmap.svg"), "old svg");
    await writeFile(join(output, "cache.json"), "old cache");
    let requested = false;
    let committed = false;
    await expect(run({ ...config(), githubToken: "t", commit: true }, {
      workspace: root, logger,
      collect: async () => { requested = true; throw new Error("Should not collect"); },
      commit: async () => { committed = true; return true; },
    })).rejects.toThrow("invalid schema");
    expect(requested).toBe(false);
    expect(committed).toBe(false);
    expect(await readFile(join(output, "heatmap.svg"), "utf8")).toBe("old svg");
    expect(await readFile(join(output, "cache.json"), "utf8")).toBe("old cache");
  });

  test("a missing directory passes no manual sources to the existing automatic flow", async () => {
    const root = await workspace();
    let manualCount = -1;
    await run({ ...config(), githubToken: "t", manualContributionsDir: "absent", cards: [] }, {
      workspace: root, logger,
      collect: async (options) => {
        manualCount = options.manualSources!.length;
        return collect({ manualSources: [document()] });
      },
    });
    expect(manualCount).toBe(0);
  });

  test("a missing directory cannot silently render an empty profile without automatic sources", async () => {
    const root = await workspace();
    await expect(run({ ...config(), manualContributionsDir: "absent" }, { workspace: root, logger })).rejects.toThrow("No automatic or manual");
  });
});
