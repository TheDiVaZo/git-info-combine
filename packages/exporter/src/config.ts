import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { ExportError } from "./errors.ts";

export interface ExportRepository {
  path: string;
  emails?: string[];
  index: number;
}

export interface ExportSource {
  id: string;
  name: string;
  color?: string;
  repositories: ExportRepository[];
}

export interface ExportConfig {
  timezone: string;
  sources: ExportSource[];
}

const SOURCE_FIELDS = ["source-name", "source-id", "author-emails", "color"];
const ID = /^[a-z0-9][a-z0-9_-]*$/;
const RESERVED_ID = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function object(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExportError(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new ExportError(`${label} has an unsupported field.`);
  return record;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ExportError(`${label} must be non-empty single-line text.`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

export function authorEmails(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ExportError(`${label} must be a non-empty email array.`);
  return [...new Set(value.map((item) => {
    const email = text(item, label);
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new ExportError(`${label} must contain complete email addresses.`);
    return email;
  }))];
}

function color(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const raw = text(value, label).replace(/^#/, "");
  if (!/^(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(raw)) throw new ExportError(`${label} must be a hex color.`);
  return `#${raw.toLowerCase()}`;
}

function sourceId(value: unknown, label: string): string | undefined {
  const id = optionalText(value, label);
  if (id !== undefined && (!ID.test(id) || RESERVED_ID.test(id))) throw new ExportError(`${label} must be a safe lowercase source identifier.`);
  return id;
}

function derivedId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (slug && !RESERVED_ID.test(slug)) return slug;
  return `source-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

export function parseExportConfig(value: unknown, configPath: string): ExportConfig {
  const config = object(value, [...SOURCE_FIELDS, "repo-folders", "timezone"], "Configuration");
  const name = text(config["source-name"], "source-name");
  const id = sourceId(config["source-id"], "source-id");
  const defaultColor = color(config.color, "color");
  const defaultEmails = config["author-emails"] === undefined ? undefined : authorEmails(config["author-emails"], "author-emails");
  const timezone = text(config.timezone, "timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new ExportError("timezone must identify a supported IANA time zone.");
  }
  const folders = config["repo-folders"];
  if (!Array.isArray(folders) || folders.length === 0) throw new ExportError("repo-folders must be a non-empty array.");

  const groups = new Map<string, { ids: Set<string>; colors: Set<string>; repositories: ExportRepository[] }>();
  folders.forEach((folder, index) => {
    const label = `Repository ${index + 1}`;
    const entry = typeof folder === "string" ? { path: folder } : object(folder, ["path", ...SOURCE_FIELDS], label);
    const path = text(entry.path, `${label} path`);
    const sourceName = optionalText(entry["source-name"], `${label} source-name`) ?? name;
    const explicitId = sourceId(entry["source-id"], `${label} source-id`) ?? (sourceName === name ? id : undefined);
    const sourceColor = color(entry.color, `${label} color`) ?? defaultColor;
    const emails = entry["author-emails"] === undefined ? defaultEmails : authorEmails(entry["author-emails"], `${label} author-emails`);
    let group = groups.get(sourceName);
    if (!group) {
      group = { ids: new Set(), colors: new Set(), repositories: [] };
      groups.set(sourceName, group);
    }
    if (explicitId) group.ids.add(explicitId);
    if (sourceColor) group.colors.add(sourceColor);
    group.repositories.push({ path: resolve(dirname(configPath), path), emails, index: index + 1 });
  });

  const usedIds = new Set<string>();
  const sources = [...groups].map(([name, group]): ExportSource => {
    if (group.ids.size > 1 || group.colors.size > 1) throw new ExportError("Repositories grouped under one source-name have conflicting source-id or color settings.");
    const id = [...group.ids][0] ?? derivedId(name);
    if (usedIds.has(id)) throw new ExportError("Different source names resolve to the same source-id; configure distinct explicit identifiers.");
    usedIds.add(id);
    return { id, name, color: [...group.colors][0], repositories: group.repositories };
  });
  sources.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { timezone, sources };
}
