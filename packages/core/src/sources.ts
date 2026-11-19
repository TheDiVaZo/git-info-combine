import { opaqueId } from "./privacy.ts";

/** One GitLab server. Only its label and colour are intended for public output. */
export interface GitLabSourceConfig {
  id: string;
  url: string;
  token: string;
  label: string;
  color: string;
  mirrors?: string[];
}

/** Keep this calculation compatible with the original single-instance cache. */
export function gitlabInstanceId(url = "https://gitlab.com"): string {
  return opaqueId("gitlab-instance", url.replace(/\/+$/, "").toLowerCase());
}

/** JSON errors must not quote the input: it contains access tokens. */
export function parseGitLabSources(text: string | undefined): GitLabSourceConfig[] | undefined {
  if (!text?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Input gitlab-sources must be a JSON array.");
  }
  return normalizeGitLabSources(parsed as GitLabSourceConfig[]);
}

/** Shared by the Action, local script and typed callers of collect(). */
export function normalizeGitLabSources(sources: GitLabSourceConfig[]): GitLabSourceConfig[] {
  if (!Array.isArray(sources)) throw new Error("Input gitlab-sources must be a JSON array.");
  const ids = new Set<string>();
  const urls = new Set<string>();
  return sources.map((source, index) => {
    const fieldError = (field: string, requirement: string): never => {
      throw new Error(`Input gitlab-sources[${index}].${field} ${requirement}.`);
    };
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error(`Input gitlab-sources[${index}] must be an object.`);
    }
    const text = (field: "id" | "url" | "token" | "label" | "color"): string => {
      const value = source[field];
      if (typeof value !== "string" || !value.trim()) fieldError(field, "must be a non-empty string");
      return value.trim();
    };
    const id = text("id");
    const label = text("label");
    const token = text("token");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) fieldError("id", "must contain only letters, numbers, hyphens and underscores");
    if (/[\r\n\u0000-\u001f\u007f]/.test(label)) fieldError("label", "must be a single line of text");
    if (/[\r\n]/.test(token)) fieldError("token", "must be a single line");
    let color = text("color");
    if (!/^#?(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) fieldError("color", "must be a hex color");
    if (!color.startsWith("#")) color = `#${color}`;

    const url = text("url").replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fieldError("url", "must be an absolute HTTP or HTTPS URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      fieldError("url", "must be an HTTP or HTTPS base URL without credentials, a query or a fragment");
    }
    const canonical = parsed.href.replace(/\/+$/, "").toLowerCase();
    if (ids.has(id)) fieldError("id", "must be unique");
    if (urls.has(canonical)) fieldError("url", "must identify a different server");
    ids.add(id);
    urls.add(canonical);

    let mirrors: string[] | undefined;
    if (source.mirrors !== undefined) {
      if (!Array.isArray(source.mirrors) || source.mirrors.some((path) => typeof path !== "string" || !path.trim())) {
        fieldError("mirrors", "must be an array of non-empty strings");
      }
      mirrors = source.mirrors.map((path) => path.trim());
    }
    return { id, url, token, label, color, ...(mirrors === undefined ? {} : { mirrors }) };
  });
}
