import { describe, expect, test } from "bun:test";
import { primaryGitLabSource, readConfig } from "../src/inputs.ts";

const inputs = (values: Record<string, string | undefined>) => (name: string) => values[name] ?? "";
const sources = [
  { id: "work", label: "Work", url: "https://git.work.example", token: "work-token", color: "#fc6d26" },
  { id: "personal", label: "Personal", url: "https://git.personal.example", token: "personal-token", color: "#6e49cb" },
];

describe("readConfig", () => {
  test("defaults", () => {
    const config = readConfig(inputs({ "github-token": "a" }));
    expect(config.cards).toEqual(["heatmap", "stats", "languages", "hosts", "wakatime", "pins", "gists"]);
    expect(config.layout).toEqual([]);
    expect(config.layoutWidth).toBe(800);
    expect(config.layoutGap).toBe(10);
    expect(config.outputDir).toBe("git-info-combine");
    expect(config.commit).toBe(true);
    expect(config.includeOrgRepos).toBe(true);
    expect(config.excludeRepos).toEqual([]);
    expect(config.stats.showHosts).toBe(true);
    expect(config.stats.hideRank).toBe(false);
    expect(config.heatmap.theme).toBeUndefined();
  });

  test("reads card options", () => {
    const config = readConfig(
      inputs({
        "gitlab-token": "b",
        "gitlab-url": "https://git.example.com",
        cards: "heatmap, stats",
        theme: "radical",
        "stats-hide": "stars,\nreviews",
        "hide-rank": "true",
        "languages-layout": "compact",
        "languages-count": "8",
        "languages-hide": "Untyped Plutus Core, HTML",
        "heatmap-range": "all",
        "heatmap-mode": "single",
        "gitlab-color": "#6e49cb",
        "include-org-repos": "false",
        "exclude-repos": "octo/dotfiles",
        commit: "no",
      }),
    );
    expect(config.cards).toEqual(["heatmap", "stats"]);
    expect(config.gitlabUrl).toBe("https://git.example.com");
    expect(config.stats).toMatchObject({ theme: "radical", hide: ["stars", "reviews"], hideRank: true });
    expect(config.languages).toMatchObject({ layout: "compact", count: 8, hide: ["Untyped Plutus Core", "HTML"] });
    expect(config.heatmap).toMatchObject({ range: "all", mode: "single", hostColors: { gitlab: "#6e49cb" } });
    expect(config.includeOrgRepos).toBe(false);
    expect(config.excludeRepos).toEqual(["octo/dotfiles"]);
    expect(config.commit).toBe(false);
  });

  test("reads the layout, one row per line", () => {
    const config = readConfig(inputs({ "github-token": "a", layout: "heatmap\n\n stats, languages \nWakaTime hosts\npins", "layout-width": "760" }));
    expect(config.layout).toEqual([["heatmap"], ["stats", "languages"], ["wakatime", "hosts"], ["pins"]]);
    expect(config.layoutWidth).toBe(760);
    expect(() => readConfig(inputs({ "github-token": "a", layout: "heatmap streak" }))).toThrow('unknown card "streak"');
  });

  test("rejects bad values with a clear message", () => {
    expect(() => readConfig(inputs({}))).toThrow("Set at least one of github-token, gitlab-token, gitlab-sources or manual-contributions-dir.");
    expect(() => readConfig(inputs({ "github-token": "a", "hide-rank": "maybe" }))).toThrow("Input hide-rank must be true or false");
    expect(() => readConfig(inputs({ "github-token": "a", "heatmap-range": "week" }))).toThrow("Input heatmap-range must be one of last-year, all");
    expect(() => readConfig(inputs({ "github-token": "a", "stats-hide": "followers" }))).toThrow('unknown stat "followers"');
    expect(() => readConfig(inputs({ "github-token": "a", "languages-count": "-1" }))).toThrow("positive number");
  });

  test("accepts GitLab sources without a GitHub token and ignores the legacy URL default", () => {
    const config = readConfig(inputs({ "gitlab-sources": JSON.stringify(sources), "gitlab-url": "https://gitlab.com" }));
    expect(config.gitlabSources).toEqual(sources);
    expect(config.gitlabToken).toBeUndefined();
    expect(primaryGitLabSource(config)).toBeUndefined();
  });

  test("rejects legacy and new credentials together, including an empty new list", () => {
    for (const value of [JSON.stringify(sources), "[]"]) {
      expect(() => readConfig(inputs({ "gitlab-token": "secret-token", "gitlab-sources": value }))).toThrow(
        "Use either gitlab-token or gitlab-sources, not both.",
      );
    }
    expect(() => readConfig(inputs({ "gitlab-sources": "[]" }))).toThrow("Set at least one");
  });

  test("selects one source automatically and a named primary independently of order", () => {
    const single = readConfig(inputs({ "gitlab-sources": JSON.stringify([sources[0]]), pins: "gitlab:group/project" }));
    expect(primaryGitLabSource(single)).toEqual(sources[0]);
    const multiple = readConfig(inputs({ "gitlab-sources": JSON.stringify(sources), "gitlab-primary-source": "personal", gists: "gitlab:42" }));
    expect(primaryGitLabSource(multiple)).toEqual(sources[1]);
  });

  test("requires a primary only for enabled GitLab showcase cards", () => {
    const base = { "gitlab-sources": JSON.stringify(sources) };
    for (const setting of [{ pins: "gitlab:group/project" }, { gists: "GitLab:42" }]) {
      expect(() => readConfig(inputs({ ...base, ...setting }))).toThrow("Set gitlab-primary-source");
    }
    expect(() => readConfig(inputs({ ...base, cards: "stats", pins: "gitlab:group/project", gists: "gitlab:42" }))).not.toThrow();
    expect(() => readConfig(inputs({ ...base, "github-token": "a", pins: "owner/repo", gists: "github:42" }))).not.toThrow();
    expect(() => readConfig(inputs({ ...base, "gitlab-primary-source": "secret-value" }))).toThrow(
      "Input gitlab-primary-source must match an id in gitlab-sources.",
    );
  });

  test("new configuration errors never echo source credentials or input values", () => {
    const secret = "unique-sensitive-token";
    const values = [
      { "gitlab-sources": `[{"token":"${secret}",` },
      { "gitlab-sources": JSON.stringify([{ ...sources[0], token: secret, url: secret }]) },
      { "gitlab-sources": JSON.stringify([{ ...sources[0], token: secret, color: secret }]) },
      { "gitlab-sources": JSON.stringify(sources), "gitlab-primary-source": secret },
    ];
    for (const value of values) {
      let error: unknown;
      try {
        readConfig(inputs(value));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(secret);
    }
  });
});
