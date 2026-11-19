import { createHash } from "node:crypto";
import { emptyTotals, type HostActivity } from "./model.ts";

export interface ManualContributionDocument {
  schemaVersion: 1;
  source: {
    id: string;
    name: string;
    type: "manual";
    metric: "commits";
    color?: string;
  };
  timezone: string;
  days: Record<string, number>;
}

function invalid(field: string): never {
  throw new Error(`Invalid manual contributions: ${field}.`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, supported: string[], field: string): void {
  if (Object.keys(value).some((key) => !supported.includes(key))) invalid(`${field} contains unsupported fields`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[^\u0020-\u007e\u0080-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) {
    invalid(`${field} must be non-empty single-line Unicode text`);
  }
  return value.trim();
}

/** The public export contract is shared by the exporter and the Action. */
export function validateManualContribution(value: unknown): ManualContributionDocument {
  const document = object(value, "document");
  fields(document, ["schemaVersion", "source", "timezone", "days"], "document");
  if (document.schemaVersion !== 1) invalid("schemaVersion must be 1");
  const source = object(document.source, "source");
  fields(source, ["id", "name", "type", "metric", "color"], "source");
  const id = text(source.id, "source.id");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) {
    invalid("source.id must be a safe lowercase filename identifier");
  }
  const name = text(source.name, "source.name");
  if (source.type !== "manual") invalid("source.type must be manual");
  if (source.metric !== "commits") invalid("source.metric must be commits");
  let color: string | undefined;
  if (source.color !== undefined) {
    color = text(source.color, "source.color");
    if (!/^#?(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) invalid("source.color must be a hex color");
    color = `#${color.replace(/^#/, "").toLowerCase()}`;
  }
  const timezone = text(document.timezone, "timezone");
  if (!/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(timezone)) invalid("timezone must be an IANA time zone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    invalid("timezone must be an IANA time zone");
  }
  const inputDays = object(document.days, "days");
  const days: Record<string, number> = {};
  let total = 0;
  for (const date of Object.keys(inputDays).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) invalid("days must use YYYY-MM-DD dates");
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) invalid("days contains an invalid calendar date");
    const count = inputDays[date];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) invalid("daily counts must be non-negative safe integers");
    total += count;
    if (!Number.isSafeInteger(total)) invalid("the total count exceeds the safe integer range");
    days[date] = count;
  }
  return {
    schemaVersion: 1,
    source: { id, name, type: "manual", metric: "commits", ...(color === undefined ? {} : { color }) },
    timezone,
    days,
  };
}

export function parseManualContribution(text: string): ManualContributionDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid("document must be valid JSON");
  }
  return validateManualContribution(value);
}

export function manualSourceColor(id: string): string {
  const palette = ["#a855f7", "#2f80ed", "#d29922", "#39c5cf", "#db61a2", "#ff7b72"];
  return palette[createHash("sha256").update(id).digest()[0]! % palette.length]!;
}

export function manualActivity(document: ManualContributionDocument): HostActivity {
  const total = Object.values(document.days).reduce((sum, count) => sum + count, 0);
  return {
    host: "manual",
    source: {
      id: `manual:${document.source.id}`,
      label: document.source.name,
      color: document.source.color ?? manualSourceColor(document.source.id),
      metric: "commits",
      timezone: document.timezone,
    },
    login: "",
    days: document.days,
    totals: { ...emptyTotals(), contributions: total, commits: total },
    languages: {},
    repos: { public: 0, private: 0 },
  };
}
