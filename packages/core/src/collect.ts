import { combine } from "./combine.ts";
import { fetchGitHub, type GitHubCache } from "./github.ts";
import { fetchGitLab, type GitLabCache } from "./gitlab.ts";
import { HttpError, type HttpOptions } from "./http.ts";
import type { CombinedActivity, HostActivity } from "./model.ts";
import { SensitiveNames } from "./privacy.ts";
import { gitlabInstanceId, normalizeGitLabSources, type GitLabSourceConfig } from "./sources.ts";

export const CACHE_VERSION = 2;

export interface Cache {
  version: typeof CACHE_VERSION;
  github?: GitHubCache;
  /** Independent buckets, including temporarily disabled instances. */
  gitlabs?: Record<string, GitLabCache>;
}

export interface CollectOptions extends HttpOptions {
  githubToken?: string;
  gitlabToken?: string;
  gitlabUrl?: string;
  /** Cannot be combined with gitlabToken. */
  gitlabSources?: GitLabSourceConfig[];
  /** See GitHubOptions.includeOrgRepos. */
  includeOrgRepos?: boolean;
  /** Repos or projects to leave out of languages and stars, on any host. */
  excludeRepos?: string[];
  /** GitLab project paths that mirror GitHub repos, on top of the ones spotted automatically. */
  gitlabMirrors?: string[];
  /** Count a repo that bundles WordPress core as one PHP repo. Defaults to true. */
  detectWordPress?: boolean;
  cache?: Cache;
  now?: Date;
}

export interface Collected {
  activity: CombinedActivity;
  /** GitLab projects counted once because they mirror a GitHub repo. */
  mirrored: number;
  cache: Cache;
  /** Names that must never be written out. Kept in memory only. */
  sensitive: SensitiveNames;
}

/** Fetches every configured host, combines the results and checks no private name got through. */
export async function collect(options: CollectOptions): Promise<Collected> {
  if (options.gitlabToken && options.gitlabSources !== undefined) {
    throw new Error("Use either gitlab-token or gitlab-sources, not both.");
  }
  const sources = options.gitlabSources === undefined ? undefined : normalizeGitLabSources(options.gitlabSources);
  if (!options.githubToken && !options.gitlabToken && !sources?.length) {
    throw new Error("Set at least one of github-token, gitlab-token and gitlab-sources.");
  }
  const hosts: HostActivity[] = [];
  let mirrored = 0;
  const cache: Cache = {
    version: CACHE_VERSION,
    ...(options.cache?.github ? { github: options.cache.github } : {}),
    ...(options.cache?.gitlabs ? { gitlabs: { ...options.cache.gitlabs } } : {}),
  };
  const sensitive = new SensitiveNames();
  const credentials = new SensitiveNames();
  credentials.add(options.githubToken, options.gitlabToken, ...(sources ?? []).map((source) => source.token));
  let githubHeads: Set<string> | undefined;

  if (options.githubToken) {
    const result = await fetchGitHub({ ...options, token: options.githubToken, cache: options.cache?.github });
    hosts.push(result.activity);
    cache.github = result.cache;
    sensitive.merge(result.sensitive);
    githubHeads = result.heads;
  }

  const configured = sources ?? (options.gitlabToken ? [{
    token: options.gitlabToken,
    url: options.gitlabUrl ?? "https://gitlab.com",
  }] : []);
  for (const [index, source] of configured.entries()) {
    const instance = gitlabInstanceId(source.url);
    const display = sources?.[index];
    try {
      const result = await fetchGitLab({
        ...options,
        token: source.token,
        baseUrl: source.url,
        cache: options.cache?.gitlabs?.[instance],
        githubHeads,
        mirrors: [...(options.gitlabMirrors ?? []), ...(display?.mirrors ?? [])],
      });
      hosts.push(display ? {
        ...result.activity,
        source: { id: instance, label: display.label, color: display.color },
      } : result.activity);
      mirrored += result.mirrored;
      (cache.gitlabs ??= {})[instance] = result.cache;
      sensitive.merge(result.sensitive);
    } catch (error) {
      // Network errors and malformed API bodies can quote URLs, tokens or private names.
      const message = `GitLab source ${index + 1} failed`;
      if (error instanceof HttpError) throw new HttpError(error.status, `${message} with HTTP ${error.status}.`);
      throw new Error(`${message}. Check its connection, token and API response.`);
    }
  }

  const activity = combine(hosts, options.now);
  sensitive.assertAbsent(activity, "the activity data");
  sensitive.assertAbsent(cache, "the cache");
  credentials.assertAbsent(activity, "the activity data");
  credentials.assertAbsent(cache, "the cache");
  return { activity, mirrored, cache, sensitive };
}

/** Migrates v1 without discarding historical events that GitLab may no longer serve. */
export function parseCache(text: string | null | undefined): Cache | undefined {
  if (!text) return undefined;
  try {
    const cache = JSON.parse(text) as Cache | { version: 1; github?: GitHubCache; gitlab?: GitLabCache };
    if (cache?.version === CACHE_VERSION) return cache;
    if (cache?.version !== 1) return undefined;
    if (cache.gitlab && typeof cache.gitlab.instance !== "string") return undefined;
    return {
      version: CACHE_VERSION,
      ...(cache.github ? { github: cache.github } : {}),
      ...(cache.gitlab ? { gitlabs: { [cache.gitlab.instance]: cache.gitlab } } : {}),
    };
  } catch {
    return undefined;
  }
}
