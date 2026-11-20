import { combine } from "./combine.ts";
import { fetchGitHub, type GitHubCache } from "./github.ts";
import { HttpError, type HttpOptions } from "./http.ts";
import type { CombinedActivity, HostActivity } from "./model.ts";
import { manualActivity, validateManualContribution, type ManualContributionDocument } from "./manual.ts";
import { SensitiveNames } from "./privacy.ts";
import { ProviderError, providerCacheKey, type ProviderRegistry, type ServerSourceConfig } from "./provider.ts";
import { DEFAULT_PROVIDERS, serverHttpOptions } from "./providers.ts";
import { resolveSources } from "./server-sources.ts";
import { normalizeGitLabSources, type GitLabSourceConfig } from "./sources.ts";

export const CACHE_VERSION = 3;

export interface SourceCache {
  provider: string;
  version: number;
  /** Provider-owned JSON payload. It never contains configuration or credentials. */
  data: unknown;
}

export interface Cache {
  version: typeof CACHE_VERSION;
  github?: GitHubCache;
  /** Independent buckets, including temporarily disabled providers and servers. */
  sources?: Record<string, SourceCache>;
}

export interface CollectOptions extends HttpOptions {
  githubToken?: string;
  gitlabToken?: string;
  gitlabUrl?: string;
  /** Cannot be combined with gitlabToken or sources. */
  gitlabSources?: GitLabSourceConfig[];
  /** Unified server list. Omitted provider IDs are detected through the registry. */
  sources?: ServerSourceConfig[];
  /** Complete local snapshots; never added incrementally to the API cache. */
  manualSources?: ManualContributionDocument[];
  includeOrgRepos?: boolean;
  excludeRepos?: string[];
  gitlabMirrors?: string[];
  detectWordPress?: boolean;
  cache?: Cache;
  now?: Date;
}

export interface CollectDeps {
  /** Dependency injection also demonstrates adding adapters without collector changes. */
  providers?: ProviderRegistry;
}

export interface Collected {
  activity: CombinedActivity;
  mirrored: number;
  cache: Cache;
  /** Names that must never be written out. Kept in memory only. */
  sensitive: SensitiveNames;
  /** Resolved IDs in configured-server order; allows showcase selection without rediscovery. */
  sourceProviders?: string[];
}

/** One loop for every server provider; GitHub and reviewed manual files keep their inputs. */
export async function collect(options: CollectOptions, deps: CollectDeps = {}): Promise<Collected> {
  if (options.sources !== undefined && (options.gitlabSources !== undefined || options.gitlabToken)) {
    throw new Error("Use either sources or the legacy gitlab-token/gitlab-sources configuration, not both.");
  }
  if (options.gitlabToken && options.gitlabSources !== undefined) {
    throw new Error("Use either gitlab-token or gitlab-sources, not both.");
  }
  if (options.sources !== undefined && !Array.isArray(options.sources)) throw new Error("Input sources must be a JSON array.");
  const providers = deps.providers ?? DEFAULT_PROVIDERS;
  const legacy = options.gitlabSources === undefined ? undefined : normalizeGitLabSources(options.gitlabSources);
  const unified = options.sources !== undefined;
  const input: ServerSourceConfig[] = options.sources ?? (legacy ?? (options.gitlabToken ? [{
    id: "default", url: options.gitlabUrl ?? "https://gitlab.com", token: options.gitlabToken, label: "GitLab", color: "#fc6d26",
  }] : [])).map((source) => ({
    provider: "gitlab", id: source.id, url: source.url, token: source.token, label: source.label, color: source.color,
    ...("mirrors" in source && source.mirrors !== undefined ? { options: { mirrors: source.mirrors } } : {}),
  }));
  if (options.manualSources !== undefined && !Array.isArray(options.manualSources)) throw new Error("Manual contributions must be an array of documents.");
  const manual = (options.manualSources ?? []).map(validateManualContribution);
  if (new Set(manual.map((document) => document.source.id)).size !== manual.length) throw new Error("Manual contributions contain duplicate source identifiers.");
  if (!options.githubToken && !input.length && !manual.length) {
    if (options.manualSources !== undefined || unified) throw new Error("No automatic or manual activity sources are configured.");
    throw new Error("Set at least one of github-token, gitlab-token and gitlab-sources.");
  }
  const sources = await resolveSources(input, options, providers);
  const previous = normalizeCache(options.cache);
  const cache: Cache = {
    version: CACHE_VERSION,
    ...(previous?.github ? { github: previous.github } : {}),
    ...(previous?.sources ? { sources: { ...previous.sources } } : {}),
  };
  const hosts: HostActivity[] = [];
  let mirrored = 0;
  const sensitive = new SensitiveNames();
  const credentials = new SensitiveNames();
  credentials.add(options.githubToken, ...sources.map((source) => source.token));
  let githubHeads: Set<string> | undefined;
  if (options.githubToken) {
    const result = await fetchGitHub({ ...options, token: options.githubToken, cache: previous?.github });
    hosts.push(result.activity);
    cache.github = result.cache;
    sensitive.merge(result.sensitive);
    githubHeads = result.heads;
  }

  for (const [index, source] of sources.entries()) {
    const provider = providers.get(source.provider)!;
    try {
      const instance = provider.instanceId(source.url);
      if (typeof instance !== "string" || !/^[a-zA-Z0-9_-]+$/.test(instance)) throw new Error("Invalid provider identity.");
      const key = providerCacheKey(provider.id, instance);
      const saved = previous?.sources?.[key];
      const result = await provider.collect(source, {
        ...serverHttpOptions(source.url, options),
        now: options.now,
        excludeRepos: options.excludeRepos,
        gitlabMirrors: options.gitlabMirrors,
        detectWordPress: options.detectWordPress,
        cache: saved?.provider === provider.id && saved.version === provider.cacheVersion ? structuredClone(saved.data) : undefined,
        githubHeads,
      });
      let activity: HostActivity = { ...result.activity, host: provider.id };
      if (unified) {
        activity = { ...activity, source: {
          id: key, label: source.label, color: source.color, metric: provider.metric, origin: "api",
          capabilities: { ...provider.capabilities, totals: [...provider.capabilities.totals] },
          ...(provider.timezone ? { timezone: provider.timezone } : {}),
        } };
      } else if (legacy) {
        activity = { ...activity, source: { id: instance, label: source.label, color: source.color } };
      }
      hosts.push(activity);
      mirrored += result.mirrored ?? 0;
      (cache.sources ??= {})[key] = { provider: provider.id, version: provider.cacheVersion, data: result.cache };
      sensitive.merge(result.sensitive);
    } catch (error) {
      const message = `${provider.name} source ${index + 1} failed`;
      // Adapter errors can contain raw upstream data; publish only known diagnostic fields.
      if (error instanceof ProviderError) {
        const operation = /^[a-z][a-z0-9-]{0,31}$/.test(error.operation) ? error.operation : "API";
        const safe = new ProviderError(operation, error.code, error.status);
        if (error.code === "http" && error.status !== undefined) throw new HttpError(error.status, `${message}: ${safe.message}`);
        throw new Error(`${message}: ${safe.message}`);
      }
      if (error instanceof HttpError) throw new HttpError(error.status, `${message} with HTTP ${error.status}.`);
      throw new Error(`${message}. Check its connection, token and API response.`);
    }
  }

  hosts.push(...manual.map(manualActivity));
  const activity = combine(hosts, options.now);
  sensitive.assertAbsent(activity, "the activity data");
  sensitive.assertAbsent(cache, "the cache");
  credentials.assertAbsent(activity, "the activity data");
  credentials.assertAbsent(cache, "the cache");
  return { activity, mirrored, cache, sensitive, sourceProviders: sources.map((source) => source.provider) };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function invalidCache(): never {
  throw new Error("The existing activity cache has an invalid schema. Previous history was not replaced.");
}

function normalizeCache(value: unknown): Cache | undefined {
  if (!record(value)) return undefined;
  if (value.version === CACHE_VERSION) {
    if (value.sources !== undefined && !record(value.sources)) invalidCache();
    for (const [key, bucket] of Object.entries(value.sources ?? {})) {
      if (!record(bucket) || typeof bucket.provider !== "string" || !/^[a-z][a-z0-9_-]*$/.test(bucket.provider)
        || !key.startsWith(`${bucket.provider}:`) || !/^[a-zA-Z0-9_-]+$/.test(key.slice(bucket.provider.length + 1))
        || !Number.isSafeInteger(bucket.version) || (bucket.version as number) < 1 || !("data" in bucket)) invalidCache();
    }
    return value as unknown as Cache;
  }
  if (value.version !== 1 && value.version !== 2) return undefined;
  const sources: Record<string, SourceCache> = {};
  if (value.version === 1 && value.gitlab !== undefined) {
    if (!record(value.gitlab) || typeof value.gitlab.instance !== "string") invalidCache();
    sources[providerCacheKey("gitlab", value.gitlab.instance)] = { provider: "gitlab", version: 1, data: value.gitlab };
  }
  if (value.version === 2 && value.gitlabs !== undefined) {
    if (!record(value.gitlabs)) invalidCache();
    for (const [instance, data] of Object.entries(value.gitlabs)) {
      if (!record(data) || typeof data.instance !== "string" || data.instance !== instance) invalidCache();
      sources[providerCacheKey("gitlab", instance)] = { provider: "gitlab", version: 1, data };
    }
  }
  return { version: CACHE_VERSION, ...(value.github ? { github: value.github as GitHubCache } : {}), ...(Object.keys(sources).length ? { sources } : {}) };
}

/** Migrate every old bucket, including disabled sources and history no longer available upstream. */
export function parseCache(text: string | null | undefined): Cache | undefined {
  if (!text) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  return normalizeCache(value);
}
