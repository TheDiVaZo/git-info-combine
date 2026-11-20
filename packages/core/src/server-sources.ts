import { HttpError, type HttpOptions } from "./http.ts";
import { ProviderError, type ProviderRegistry, type ResolvedServerSource, type ServerSourceConfig } from "./provider.ts";
import { DEFAULT_PROVIDERS, serverHttpOptions } from "./providers.ts";

/** Common input validation never includes supplied values in errors. */
export function normalizeSources(input: ServerSourceConfig[], providers: ProviderRegistry = DEFAULT_PROVIDERS): ServerSourceConfig[] {
  if (!Array.isArray(input)) throw new Error("Input sources must be a JSON array.");
  const ids = new Set<string>();
  const explicitInstances = new Set<string>();
  return input.map((item, index) => {
    const fail = (field: string, rule: string): never => { throw new Error(`Input sources[${index}].${field} ${rule}.`); };
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("source", "must be an object");
    if (Object.keys(item).some((key) => !["provider", "id", "url", "token", "label", "color", "options"].includes(key))) fail("source", "contains unsupported fields");
    const text = (field: "provider" | "id" | "url" | "token" | "label" | "color"): string => {
      const value = item[field];
      if (typeof value !== "string" || !value.trim()) fail(field, "must be a non-empty string");
      return value!.trim();
    };
    const id = text("id");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) fail("id", "must be a safe identifier");
    if (ids.has(id)) fail("id", "must be unique");
    ids.add(id);
    const token = text("token");
    if (/[\u0000-\u001f\u007f]/.test(token)) fail("token", "must be a single line");
    const label = text("label");
    if (/[^\u0020-\u007e\u0080-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(label)) fail("label", "must be single-line Unicode text");
    let color = text("color");
    if (!/^#?(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) fail("color", "must be a hex color");
    color = `#${color.replace(/^#/, "")}`;
    const rawUrl = text("url");
    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch { return fail("url", "must be an absolute HTTP or HTTPS base URL"); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail("url", "must be an HTTP or HTTPS base URL without credentials, query or fragment");
    }
    // GitLab's established cache identity hashes the configured spelling, including explicit ports.
    const url = rawUrl.replace(/\/+$/, "");
    const provider = item.provider === undefined ? undefined : text("provider");
    if (provider !== undefined && !providers.has(provider)) fail("provider", "is not registered");
    if (item.options !== undefined && (!item.options || typeof item.options !== "object" || Array.isArray(item.options))) fail("options", "must be an object");
    let options = item.options;
    if (provider !== undefined) {
      const key = `${provider}:${parsed.href.replace(/\/+$/, "").toLowerCase()}`;
      if (explicitInstances.has(key)) fail("url", "must identify a different server for this provider");
      explicitInstances.add(key);
      try { options = providers.get(provider)!.normalizeOptions(options); } catch { fail("options", "is invalid for this provider"); }
    }
    return { id, url, token, label, color, ...(provider === undefined ? {} : { provider }), ...(options === undefined ? {} : { options }) };
  });
}

export function parseSources(text: string | undefined, providers: ProviderRegistry = DEFAULT_PROVIDERS): ServerSourceConfig[] | undefined {
  if (!text?.trim()) return undefined;
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new Error("Input sources must be a JSON array."); }
  return normalizeSources(input as ServerSourceConfig[], providers);
}

/** Resolve all sources before fetching activity; explicit selections never fall back. */
export async function resolveSources(input: ServerSourceConfig[], options: HttpOptions = {}, providers: ProviderRegistry = DEFAULT_PROVIDERS): Promise<ResolvedServerSource[]> {
  const sources = normalizeSources(input, providers);
  const instances = new Set<string>();
  const resolved: ResolvedServerSource[] = [];
  for (const [index, source] of sources.entries()) {
    let id = source.provider;
    if (id === undefined) {
      const probes = await Promise.allSettled([...providers.values()].map(async (provider) => ({
        id: provider.id,
        matches: await provider.detect(source, serverHttpOptions(source.url, options)),
      })));
      const matches = probes.flatMap((probe) => probe.status === "fulfilled" && probe.value.matches ? [probe.value.id] : []);
      if (matches.length > 1) throw new Error(`Source ${index + 1} matches multiple providers. Set provider explicitly.`);
      if (matches.length === 0) {
        const statuses = [...new Set(probes.flatMap((probe) => probe.status === "rejected"
          && (probe.reason instanceof HttpError || probe.reason instanceof ProviderError) && probe.reason.status !== undefined ? [probe.reason.status] : []))];
        const detail = statuses.length ? ` Probe HTTP statuses: ${statuses.join(", ")}.` : " The API was unavailable or did not return recognizable JSON.";
        throw new Error(`Source ${index + 1} provider could not be detected.${detail} Check the connection and token, or set provider explicitly.`);
      }
      id = matches[0]!;
    }
    const provider = providers.get(id)!;
    let providerOptions: unknown;
    try { providerOptions = provider.normalizeOptions(source.options); } catch {
      throw new Error(`Input sources[${index}].options is invalid for the selected provider.`);
    }
    const key = `${id}:${new URL(source.url).href.replace(/\/+$/, "").toLowerCase()}`;
    if (instances.has(key)) throw new Error(`Input sources[${index}].url must identify a different server for the selected provider.`);
    instances.add(key);
    const { options: _inputOptions, ...common } = source;
    resolved.push({ ...common, provider: id, ...(providerOptions === undefined ? {} : { options: providerOptions }) });
  }
  return resolved;
}
