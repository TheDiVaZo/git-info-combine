import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportLocal } from "../src/export.ts";
import { parseExportConfig } from "../src/config.ts";

const EMAIL = "worker+exact@example.invalid";
const OTHER = "someone@example.invalid";
const DATE = "2026-11-18T12:00:00Z";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

function identity(email = EMAIL, date = DATE, authorDate = date) {
  return { ...process.env, GIT_AUTHOR_NAME: "Fixture Author", GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_NAME: "Fixture Committer", GIT_COMMITTER_EMAIL: "committer@example.invalid", GIT_COMMITTER_DATE: date };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gic-export-"));
  const config = join(root, "local.json");
  const output = join(root, "output");
  async function repo(name: string) {
    const path = join(root, name);
    await mkdir(path);
    git(path, "init", "--quiet", "--initial-branch=main");
    git(path, "config", "user.name", "Fixture Author");
    git(path, "config", "user.email", EMAIL);
    git(path, "config", "commit.gpgsign", "false");
    return path;
  }
  async function configure(folders: unknown[], extra: Record<string, unknown> = {}) {
    await writeFile(config, JSON.stringify({ "source-name": "EXBO", "source-id": "exbo", "repo-folders": folders, timezone: "Europe/Moscow", ...extra }));
  }
  return { root, config, output, repo, configure, document: async (name = "exbo") => JSON.parse(await readFile(join(output, `${name}.json`), "utf8")) };
}

function commit(repo: string, message: string, email = EMAIL, date = DATE, authorDate = date) {
  execFileSync("git", ["-C", repo, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message], { env: identity(email, date, authorDate), stdio: "pipe" });
  return git(repo, "rev-parse", "HEAD");
}

describe("export configuration", () => {
  test("groups mixed string/object folders and applies explicit group IDs", () => {
    const config = parseExportConfig({
      "source-name": "Work", timezone: "UTC", "author-emails": [EMAIL],
      "repo-folders": ["a", { path: "b", "source-id": "stable" }, { path: "c", "source-name": "Work / Other", "author-emails": [OTHER] }],
    }, resolve("local.json"));
    expect(config.sources.map((source) => [source.id, source.repositories.length])).toEqual([["stable", 2], ["work-other", 1]]);
    expect(config.sources[0]!.repositories.every((repo) => repo.emails?.[0] === EMAIL)).toBe(true);
    expect(config.sources[1]!.repositories[0]!.emails).toEqual([OTHER]);
  });

  test("rejects conflicting grouping, IDs, invalid metadata and unsafe filenames", () => {
    const base = { "source-name": "Work", "repo-folders": ["a"], timezone: "UTC" };
    for (const change of [
      { "author-emails": [] }, { timezone: "bad/timezone" }, { "source-id": "../private" }, { "source-id": "con" },
      { "source-name": "bad\nlabel" }, { color: "red;private" }, { "unknown-private-field": true },
      { "repo-folders": [{ path: "a", "source-id": "one" }, { path: "b", "source-id": "two" }] },
      { "repo-folders": [{ path: "a", color: "#fff" }, { path: "b", color: "#000" }] },
      { "repo-folders": [{ path: "a", "source-name": "A B" }, { path: "b", "source-name": "A-B" }] },
    ]) expect(() => parseExportConfig({ ...base, ...change }, resolve("local.json"))).toThrow();
    const generated = parseExportConfig({ ...base, "source-name": "Работа" }, resolve("local.json")).sources[0]!.id;
    expect(generated).toMatch(/^source-[a-f0-9]{12}$/);
    expect(parseExportConfig({ ...base, "source-name": "Работа" }, resolve("local.json")).sources[0]!.id).toBe(generated);
  });
});

describe("local Git export", () => {
  test("combines three repositories and deduplicates mirror SHAs and branch aliases", async () => {
    const f = await fixture();
    const repos = await Promise.all(["first", "second", "third"].map(f.repo));
    const shared = repos.map((repo) => commit(repo, "shared synthetic root"));
    expect(new Set(shared).size).toBe(1);
    repos.forEach((repo, i) => { commit(repo, `unique synthetic commit ${i}`); git(repo, "branch", "duplicate-ref"); });
    await f.configure(repos);
    const summary = await exportLocal(f.config, f.output);
    expect(summary.sources).toEqual([{ id: "exbo", name: "EXBO", repositories: 3, commits: 4, firstDate: "2026-11-18", lastDate: "2026-11-18", file: "exbo.json", changed: true }]);
    expect(await f.document()).toEqual({ schemaVersion: 1, source: { id: "exbo", name: "EXBO", type: "manual", metric: "commits" }, timezone: "Europe/Moscow", days: { "2026-11-18": 4 } });
    const publicText = JSON.stringify(summary) + await readFile(join(f.output, "exbo.json"), "utf8");
    for (const privateValue of [...repos, EMAIL, OTHER, ...shared, "shared synthetic root", "unique synthetic commit"]) expect(publicText).not.toContain(privateValue);
  });

  test("split groups retain separate SHAs and override global source ID and author filters", async () => {
    const f = await fixture();
    const a = await f.repo("a");
    const b = await f.repo("b");
    commit(a, "shared");
    commit(b, "shared");
    commit(b, "other author", OTHER);
    await f.configure([{ path: a, "source-name": "EXBO / Alpha" }, { path: b, "source-name": "EXBO / Beta", "author-emails": [EMAIL, OTHER], color: "#ABC" }]);
    const summary = await exportLocal(f.config, f.output);
    expect(summary.sources.map((source) => [source.id, source.commits])).toEqual([["exbo-alpha", 1], ["exbo-beta", 2]]);
    expect((await f.document("exbo-beta")).source.color).toBe("#abc");
  });

  test("uses exact author emails rather than regex or committer identity and ignores mailmap", async () => {
    const f = await fixture();
    const repo = await f.repo("repo");
    commit(repo, "wanted");
    commit(repo, "not a substring", `prefix${EMAIL}`);
    commit(repo, "not a regex match", "workerrrexact@example.invalid");
    commit(repo, "case differs", EMAIL.toUpperCase());
    commit(repo, "only committer matches", "committer@example.invalid");
    await writeFile(join(repo, ".mailmap"), `Fixture Author <${EMAIL}> Someone <${OTHER}>\n`);
    commit(repo, "mailmap must not count", OTHER);
    await f.configure([repo], { "author-emails": [EMAIL] });
    expect((await exportLocal(f.config, f.output)).sources[0]!.commits).toBe(1);
  });

  test("includes remote-tracking refs and detached HEAD but excludes stash and tag-only commits", async () => {
    const f = await fixture();
    const repo = await f.repo("repo");
    const root = commit(repo, "root");
    const remote = commit(repo, "remote only");
    git(repo, "update-ref", "refs/remotes/origin/feature", remote);
    git(repo, "reset", "--hard", root);
    const tag = commit(repo, "tag only");
    git(repo, "tag", "archive", tag);
    git(repo, "reset", "--hard", root);
    await writeFile(join(repo, "temporary.txt"), "synthetic unfinished work");
    execFileSync("git", ["-C", repo, "stash", "push", "--include-untracked", "--quiet"], { env: identity(), stdio: "pipe" });
    git(repo, "checkout", "--quiet", "--detach");
    commit(repo, "detached only");
    await f.configure([repo]);
    expect((await exportLocal(f.config, f.output)).sources[0]!.commits).toBe(3);
  });

  test("counts merge commits and preserves the source worktree and refs", async () => {
    const f = await fixture();
    const repo = await f.repo("repo");
    commit(repo, "root");
    git(repo, "checkout", "--quiet", "-b", "feature");
    commit(repo, "feature");
    git(repo, "checkout", "--quiet", "main");
    execFileSync("git", ["-C", repo, "merge", "--quiet", "--no-ff", "feature", "-m", "synthetic merge"], { env: identity(), stdio: "pipe" });
    await writeFile(join(repo, "untracked.txt"), "leave this alone");
    const before = { refs: git(repo, "show-ref"), status: git(repo, "status", "--porcelain"), head: git(repo, "rev-parse", "HEAD") };
    await f.configure([repo]);
    expect((await exportLocal(f.config, f.output)).sources[0]!.commits).toBe(3);
    expect({ refs: git(repo, "show-ref"), status: git(repo, "status", "--porcelain"), head: git(repo, "rev-parse", "HEAD") }).toEqual(before);
    expect(await readFile(join(repo, "untracked.txt"), "utf8")).toBe("leave this alone");
  });

  test("groups by committer time in Moscow rather than author time", async () => {
    const f = await fixture();
    const repo = await f.repo("repo");
    commit(repo, "before boundary", EMAIL, "2026-11-18T20:59:59Z", "2020-01-01T00:00:00Z");
    commit(repo, "after boundary", EMAIL, "2026-11-18T21:00:00Z", "2020-01-01T00:00:00Z");
    await f.configure([repo]);
    await exportLocal(f.config, f.output);
    expect((await f.document()).days).toEqual({ "2026-11-18": 1, "2026-11-19": 1 });
  });

  test("honours daylight-saving time instead of a fixed offset", async () => {
    const f = await fixture();
    const repo = await f.repo("repo");
    commit(repo, "winter", EMAIL, "2026-01-15T04:30:00Z");
    commit(repo, "summer", EMAIL, "2026-07-15T04:30:00Z");
    await f.configure([repo], { timezone: "America/New_York" });
    await exportLocal(f.config, f.output);
    expect((await f.document()).days).toEqual({ "2026-01-14": 1, "2026-07-15": 1 });
  });

  test("repeat export keeps bytes and mtime and preserves foreign JSON", async () => {
    const f = await fixture();
    const repo = await f.repo("repo");
    commit(repo, "initial");
    await f.configure([repo]);
    await exportLocal(f.config, f.output);
    await writeFile(join(f.output, "someone-else.json"), "foreign data");
    const target = join(f.output, "exbo.json");
    const before = { text: await readFile(target, "utf8"), time: (await stat(target)).mtimeMs };
    expect((await exportLocal(f.config, f.output)).sources[0]!.changed).toBe(false);
    expect({ text: await readFile(target, "utf8"), time: (await stat(target)).mtimeMs }).toEqual(before);
    expect(await readFile(join(f.output, "someone-else.json"), "utf8")).toBe("foreign data");
    expect((await readdir(f.output)).sort()).toEqual(["exbo.json", "someone-else.json"]);
  });

  test("an unavailable last repository leaves every existing source file unchanged", async () => {
    const f = await fixture();
    const repo = await f.repo("repo");
    commit(repo, "initial");
    await f.configure([repo]);
    await exportLocal(f.config, f.output);
    const original = await readFile(join(f.output, "exbo.json"), "utf8");
    commit(repo, "new data not published on failure");
    await f.configure([repo, { path: join(f.root, "private-missing-folder"), "source-name": "Other" }]);
    const error = await exportLocal(f.config, f.output).catch((error) => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Repository 2");
    expect((error as Error).message).not.toContain(f.root);
    expect((error as Error).message).not.toContain("private-missing-folder");
    expect(await readFile(join(f.output, "exbo.json"), "utf8")).toBe(original);
    expect(await readdir(f.output)).toEqual(["exbo.json"]);
  });

  test("valid empty history exports zero counts; missing author and shallow history fail safely", async () => {
    const f = await fixture();
    const repo = await f.repo("repo");
    await f.configure([repo]);
    expect((await exportLocal(f.config, f.output)).sources[0]!.commits).toBe(0);
    expect((await f.document()).days).toEqual({});
    git(repo, "config", "user.email", "");
    await expect(exportLocal(f.config, f.output)).rejects.toThrow("author email");
    git(repo, "config", "user.email", EMAIL);
    const head = commit(repo, "initial");
    await writeFile(join(repo, ".git", "shallow"), `${head}\n`);
    await expect(exportLocal(f.config, f.output)).rejects.toThrow("shallow");
    expect((await f.document()).days).toEqual({});
  });

  test("rejects non-repos, nested worktrees, corrupt history and occupied filenames", async () => {
    const f = await fixture();
    const repo = await f.repo("repo");
    const plain = join(f.root, "plain");
    await mkdir(plain);
    await f.configure([plain]);
    await expect(exportLocal(f.config, f.output)).rejects.toThrow("Git worktree");
    const nested = join(repo, "nested");
    await mkdir(nested);
    await f.configure([nested]);
    await expect(exportLocal(f.config, f.output)).rejects.toThrow("Git worktree");
    commit(repo, "initial");
    await f.configure([repo]);
    await mkdir(f.output);
    await writeFile(join(f.output, "exbo.json"), '{"private":"keep"}');
    await expect(exportLocal(f.config, f.output)).rejects.toThrow("not overwritten");
    expect(await readFile(join(f.output, "exbo.json"), "utf8")).toBe('{"private":"keep"}');
    await writeFile(join(repo, ".git", "refs", "heads", "broken"), "f".repeat(40) + "\n");
    await expect(exportLocal(f.config, f.output)).rejects.toThrow("history could not be read");
  });

  test("explicit IDs allow display-name changes without creating another output", async () => {
    const f = await fixture();
    const repo = await f.repo("repo");
    commit(repo, "initial");
    await f.configure([repo]);
    await exportLocal(f.config, f.output);
    await f.configure([repo], { "source-name": "Renamed Work" });
    await exportLocal(f.config, f.output);
    expect((await f.document()).source.name).toBe("Renamed Work");
    expect(await readdir(f.output)).toEqual(["exbo.json"]);
  });

  test("CLI prints only safe JSON summary and never raw malformed config or stack traces", async () => {
    const f = await fixture();
    const repo = await f.repo("repo");
    commit(repo, "private synthetic message");
    await f.configure([repo]);
    const entry = resolve(import.meta.dir, "../src/index.ts");
    const args = [entry, "--config", f.config, "--output-dir", f.output, "--json-summary"];
    const success = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(success.status).toBe(0);
    expect(JSON.parse(success.stdout).sources[0].commits).toBe(1);
    expect(success.stderr).toBe("");
    expect(success.stdout).not.toContain(repo);
    expect(success.stdout).not.toContain(EMAIL);
    await writeFile(f.config, '{"private-server":"must-not-leak",');
    const failure = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain("configuration as JSON");
    expect(failure.stderr.trim()).toMatch(/^Export failed: [^\r\n]+$/);
    expect(failure.stderr).not.toContain("must-not-leak");
    expect(failure.stderr).not.toContain(f.root);
    expect(failure.stderr).not.toContain("at ");
  });
});
