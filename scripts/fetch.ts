/**
 * Fetches real activity and prints a summary. Reads tokens from the
 * environment: GIC_GITHUB_TOKEN, GIC_GITLAB_TOKEN, and optionally GIC_GITLAB_URL
 * and GIC_INCLUDE_ORG_REPOS=false. For multiple GitLab servers, use
 * GIC_GITLAB_SOURCES (the same JSON array as the Action's gitlab-sources)
 * instead of GIC_GITLAB_TOKEN. Prefer GIC_SOURCES for mixed GitLab/Forgejo
 * servers with optional provider autodetection; it replaces legacy GitLab inputs.
 * Writes the cache and activity JSON to .out/ so a second run is incremental.
 *
 *   bun run fetch
 */
import { mkdir } from "node:fs/promises";
import { collect, parseCache, parseGitLabSources, parseSources } from "@git-info-combine/core";

const cacheFile = Bun.file(".out/cache.json");
const cache = parseCache((await cacheFile.exists()) ? await cacheFile.text() : null);

const started = performance.now();
const { activity, mirrored, cache: next } = await collect({
  githubToken: process.env.GIC_GITHUB_TOKEN,
  gitlabToken: process.env.GIC_GITLAB_TOKEN,
  gitlabUrl: process.env.GIC_GITLAB_URL,
  gitlabSources: parseGitLabSources(process.env.GIC_GITLAB_SOURCES),
  sources: parseSources(process.env.GIC_SOURCES),
  includeOrgRepos: process.env.GIC_INCLUDE_ORG_REPOS !== "false",
  cache,
});
const seconds = ((performance.now() - started) / 1000).toFixed(1);

await mkdir(".out", { recursive: true });
await Bun.write(cacheFile, `${JSON.stringify(next, null, 2)}\n`);
await Bun.write(".out/activity.json", `${JSON.stringify(activity, null, 2)}\n`);

const dates = Object.keys(activity.days);
console.log(`Fetched in ${seconds}s (${cache ? "incremental" : "full"}).`);
console.log(`Days with activity: ${dates.length}, from ${dates[0]} to ${dates.at(-1)}`);
console.log(`GitLab projects counted once as mirrors of GitHub repos: ${mirrored}`);
console.table([
  ...activity.hosts.map((host) => ({
    source: host.source?.label ?? host.host,
    account: host.login,
    ...Object.fromEntries(Object.entries(host.totals).map(([key, value]) => [key,
      host.source?.capabilities && !host.source.capabilities.totals.some((stat) => stat === key) ? "not reported" : value,
    ])),
    ...prefix("repos", host.source?.capabilities?.repos === false ? { public: "not reported", private: "not reported" } : host.repos),
  })),
  { source: "combined (reporting sources)", account: "", ...Object.fromEntries(Object.entries(activity.totals).map(([key, value]) => [key,
    activity.hosts.some((host) => !host.source?.capabilities || host.source.capabilities.totals.some((stat) => stat === key)) ? value : "not reported",
  ])) },
]);
const totalWeight = Object.values(activity.languages).reduce((sum, stat) => sum + stat.weight, 0);
const totalSize = Object.values(activity.languages).reduce((sum, stat) => sum + stat.size, 0);
const languages = Object.entries(activity.languages)
  .sort(([, a], [, b]) => b.weight - a.weight)
  .slice(0, 10)
  .map(([name, stat]) => ({
    name,
    "per repo %": ((stat.weight / totalWeight) * 100).toFixed(1),
    "by size %": ((stat.size / totalSize) * 100).toFixed(1),
    repos: stat.repos,
  }));
console.table(languages);

function prefix(name: string, record: Record<string, number | string>) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [`${name}.${key}`, value]));
}
