import type { HttpOptions } from "./http.ts";
import type { HostActivity, SourceCapabilities } from "./model.ts";
import type { SensitiveNames } from "./privacy.ts";

/** Credentials remain in configuration; only explicit presentation fields become public. */
export interface ServerSourceConfig {
  provider?: string;
  id: string;
  url: string;
  token: string;
  label: string;
  color: string;
  options?: unknown;
}

export interface ResolvedServerSource extends ServerSourceConfig {
  provider: string;
}

export interface ProviderContext extends HttpOptions {
  now?: Date;
  cache?: unknown;
  githubHeads?: Set<string>;
  excludeRepos?: string[];
  gitlabMirrors?: string[];
  detectWordPress?: boolean;
}

export interface ProviderResult {
  activity: HostActivity;
  cache: unknown;
  sensitive: SensitiveNames;
  mirrored?: number;
}

/** One registered API implementation. The orchestration and renderers do not branch on its ID. */
export interface SourceProvider {
  id: string;
  name: string;
  cacheVersion: number;
  capabilities: SourceCapabilities;
  metric: "commits" | "contributions";
  timezone?: string;
  normalizeOptions(value: unknown): unknown;
  instanceId(url: string): string;
  detect(source: ServerSourceConfig, options: HttpOptions): Promise<boolean>;
  collect(source: ResolvedServerSource, context: ProviderContext): Promise<ProviderResult>;
}

export type ProviderRegistry = ReadonlyMap<string, SourceProvider>;

/** Adapter-owned diagnostic codes prevent raw response text from reaching the caller. */
export class ProviderError extends Error {
  constructor(
    readonly operation: string,
    readonly code: "http" | "network" | "timeout" | "response" | "validation",
    readonly status?: number,
  ) {
    const detail = code === "http" ? `failed with HTTP ${status}`
      : code === "network" ? "request failed; check connection, redirects and API access"
      : code === "timeout" ? "request timed out"
      : code === "response" ? "returned invalid or non-JSON API data; check for an HTML login or proxy page"
      : "returned invalid activity data";
    super(`${operation} ${detail}.`);
  }
}

/** Cache keys never contain hostnames or display aliases. */
export function providerCacheKey(provider: string, instance: string): string {
  return `${provider}:${instance}`;
}
