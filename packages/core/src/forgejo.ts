import { HttpError, request, type HttpOptions } from "./http.ts";
import { addDays, emptyTotals, toDateKey, type DateKey, type HostActivity } from "./model.ts";
import { opaqueId, SensitiveNames } from "./privacy.ts";
import { ProviderError } from "./provider.ts";

export interface ForgejoCache {
  /** Opaque identity: the configured server address never enters public output. */
  instance: string;
  userId: number;
  days: Record<DateKey, number>;
}

export interface ForgejoOptions extends HttpOptions {
  token: string;
  baseUrl: string;
  cache?: ForgejoCache;
  now?: Date;
}

export interface ForgejoResult {
  activity: HostActivity;
  cache: ForgejoCache;
  sensitive: SensitiveNames;
}

type Operation = "detection" | "account" | "heatmap";

function baseAddress(value: string): string {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    return parsed.href.replace(/\/+$/, "");
  } catch {
    throw new Error("Forgejo requires an HTTP or HTTPS base URL without credentials, query or fragment.");
  }
}

export function forgejoInstanceId(baseUrl: string): string {
  return opaqueId("forgejo-instance", baseAddress(baseUrl).toLowerCase());
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  operation: Operation,
  options: HttpOptions,
  token?: string,
): Promise<{ response: Response; body: unknown }> {
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await request(`${baseUrl}${path}`, {
      headers: { "user-agent": "git-info-combine", accept: "application/json", ...(token === undefined ? {} : { authorization: `token ${token}` }) },
      redirect: "error",
      signal,
    }, options);
  } catch (error) {
    if (error instanceof HttpError) throw new ProviderError(operation, "http", error.status);
    if (signal.aborted) throw new ProviderError(operation, "timeout");
    throw new ProviderError(operation, "network");
  }
  if (response.status !== 200) throw new ProviderError(operation, "http", response.status);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new ProviderError(operation, "response");
  }
  try {
    return { response, body: await response.json() };
  } catch {
    throw new ProviderError(operation, signal.aborted ? "timeout" : "response");
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Forgejo has a dedicated endpoint; a generic Gitea version response is insufficient. */
export async function detectForgejo(options: Pick<ForgejoOptions, "baseUrl"> & HttpOptions): Promise<boolean> {
  try {
    const { body } = await jsonRequest(baseAddress(options.baseUrl), "/api/forgejo/v1/version", "detection", options);
    return object(body) && typeof body.version === "string" && body.version.trim().length > 0;
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return false;
    throw error;
  }
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && toDateKey(date) === value;
}

function cachedDays(cache: unknown, instance: string, userId: number): Record<DateKey, number> {
  if (cache === undefined) return {};
  if (!object(cache)) throw new ProviderError("cache", "validation");
  // A different account or server must never inherit previous activity.
  if (cache.instance !== instance || cache.userId !== userId) return {};
  if (!object(cache.days)) throw new ProviderError("cache", "validation");
  let total = 0;
  const days: Record<DateKey, number> = {};
  for (const [date, count] of Object.entries(cache.days)) {
    if (!validDay(date) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new ProviderError("cache", "validation");
    total += count;
    if (!Number.isSafeInteger(total)) throw new ProviderError("cache", "validation");
    days[date] = count;
  }
  return days;
}

/** Native Forgejo calendar events, not repository commit counts. */
export async function fetchForgejo(options: ForgejoOptions): Promise<ForgejoResult> {
  const baseUrl = baseAddress(options.baseUrl);
  if (typeof options.token !== "string" || !options.token.trim() || /[\r\n]/.test(options.token)) throw new Error("Forgejo requires a non-empty single-line token.");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Forgejo collection time must be a valid date.");
  const account = (await jsonRequest(baseUrl, "/api/v1/user", "account", options, options.token)).body;
  if (!object(account) || typeof account.id !== "number" || !Number.isSafeInteger(account.id) || account.id <= 0 || typeof account.login !== "string" || !account.login.trim() || [".", ".."].includes(account.login) || /[\u0000-\u001f\u007f]/.test(account.login)) {
    throw new ProviderError("account", "response");
  }
  const sensitive = new SensitiveNames();
  // Account fields are used only for request routing and never copied to output.
  sensitive.add(new URL(baseUrl).hostname, options.token);
  const { response, body } = await jsonRequest(baseUrl, `/api/v1/users/${encodeURIComponent(account.login)}/heatmap`, "heatmap", options, options.token);
  if (!Array.isArray(body)) throw new ProviderError("heatmap", "response");

  const serverTime = Date.parse(response.headers.get("date") ?? "");
  const fetchedAt = Number.isFinite(serverTime) ? new Date(serverTime) : now;
  const today = toDateKey(fetchedAt);
  if (!validDay(today)) throw new ProviderError("heatmap", "response");
  // The API retains 371*86400 seconds before grouping into 900-second buckets.
  // Its oldest UTC date may be incomplete; keep previously saved complete days.
  const completeWindowStart = addDays(today, -370);
  const instance = forgejoInstanceId(baseUrl);
  const previous = cachedDays(options.cache, instance, account.id);
  const days = Object.fromEntries(Object.entries(previous).filter(([date]) => date < completeWindowStart));
  const buckets = new Set<number>();
  for (const entry of body) {
    if (!object(entry) || typeof entry.timestamp !== "number" || !Number.isSafeInteger(entry.timestamp) || typeof entry.contributions !== "number" || !Number.isSafeInteger(entry.contributions) || entry.contributions < 0) {
      throw new ProviderError("heatmap", "response");
    }
    const date = new Date(entry.timestamp * 1000);
    if (!Number.isFinite(date.getTime()) || !validDay(toDateKey(date))) throw new ProviderError("heatmap", "response");
    if (buckets.has(entry.timestamp)) throw new ProviderError("heatmap", "response");
    buckets.add(entry.timestamp);
    const day = toDateKey(date);
    if (day > today) throw new ProviderError("heatmap", "response");
    if (day < completeWindowStart) continue;
    const count = (days[day] ?? 0) + entry.contributions;
    if (!Number.isSafeInteger(count)) throw new ProviderError("heatmap", "response");
    if (count > 0) days[day] = count;
  }
  const sorted = Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)));
  const total = Object.values(sorted).reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total)) throw new ProviderError("heatmap", "response");
  const activity: HostActivity = {
    host: "forgejo",
    login: "",
    days: sorted,
    totals: { ...emptyTotals(), contributions: total },
    languages: {},
    repos: { public: 0, private: 0 },
  };
  const cache: ForgejoCache = { instance, userId: account.id, days: sorted };
  sensitive.assertAbsent(activity, "the Forgejo activity data");
  sensitive.assertAbsent(cache, "the Forgejo cache");
  return { activity, cache, sensitive };
}
