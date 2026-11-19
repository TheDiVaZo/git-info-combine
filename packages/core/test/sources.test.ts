import { describe, expect, test } from "bun:test";
import { gitlabInstanceId, normalizeGitLabSources, parseGitLabSources, type GitLabSourceConfig } from "../src/sources.ts";
import { opaqueId } from "../src/privacy.ts";

const source: GitLabSourceConfig = {
  id: "work", url: "https://git.example.com", token: "do-not-print-this-token", label: "Work", color: "#fc6d26",
};

describe("GitLab source configuration", () => {
  test("parses explicit sources and normalizes without mutating input", () => {
    const input = { ...source, label: " Work ", url: "https://git.example.com///", color: "fc6d26", mirrors: [" group/repo "] };
    expect(parseGitLabSources(JSON.stringify([input]))).toEqual([{ ...source, mirrors: ["group/repo"] }]);
    expect(input.label).toBe(" Work ");
    expect(parseGitLabSources(undefined)).toBeUndefined();
    expect(parseGitLabSources("  ")).toBeUndefined();
    expect(parseGitLabSources("[]")).toEqual([]);
  });

  test("preserves existing instance hashes", () => {
    expect(gitlabInstanceId("https://Git.Example.com///")).toBe(opaqueId("gitlab-instance", "https://git.example.com"));
    expect(gitlabInstanceId()).toBe(opaqueId("gitlab-instance", "https://gitlab.com"));
  });

  test("rejects malformed JSON without quoting tokens", () => {
    for (const text of [`[{"token":"${source.token}",}]`, JSON.stringify(source), "null", "1"]) {
      expect(() => parseGitLabSources(text)).toThrow("Input gitlab-sources must be a JSON array.");
    }
  });

  test("typed callers receive the same validation", () => {
    for (const invalid of [null, false, [], { ...source, token: 1 }, { ...source, label: "" }]) {
      expect(() => normalizeGitLabSources([invalid as unknown as GitLabSourceConfig])).toThrow("Input gitlab-sources[0]");
    }
  });

  test("validation errors identify fields without echoing input values", () => {
    const invalids = [
      { ...source, url: source.token },
      { ...source, color: source.token },
      { ...source, id: `${source.token}/` },
      { ...source, label: `${source.token}\nprivate` },
      { ...source, mirrors: [null] },
    ];
    for (const invalid of invalids) {
      let message = "";
      try { parseGitLabSources(JSON.stringify([invalid])); } catch (error) { message = (error as Error).message; }
      expect(message).toContain("Input gitlab-sources[0].");
      expect(message).not.toContain(source.token);
      expect(message).not.toContain(source.url);
    }
  });

  test("rejects credential-bearing URLs and URL parameters", () => {
    for (const url of ["ftp://git.example.com", "https://user:pass@git.example.com", "https://git.example.com?token=secret", "https://git.example.com#fragment"]) {
      expect(() => normalizeGitLabSources([{ ...source, url }])).toThrow("base URL");
    }
  });

  test("rejects repeated aliases and canonical server URLs", () => {
    expect(() => normalizeGitLabSources([source, { ...source, url: "https://another.example.com" }])).toThrow("id must be unique");
    for (const url of ["https://GIT.EXAMPLE.COM/", "https://git.example.com:443"]) {
      expect(() => normalizeGitLabSources([source, { ...source, id: "other", url }])).toThrow("url must identify a different server");
    }
  });
});
