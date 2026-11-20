import { emptyTotals, type ActivityHost, type Host, type HostActivity, type SourceCapabilities, type Totals } from "../model.ts";
import { DEFAULT_HOST_COLORS, escapeXml, HOST_LABELS, hexColor, wrapText } from "./svg.ts";

export type HostColors = Partial<Record<Host, string>>;

function isLegacyHost(host: string): host is Host | "manual" {
  return host === "github" || host === "gitlab" || host === "manual";
}

export function hostColor(host: ActivityHost, colors: HostColors = {}): string {
  if (!isLegacyHost(host)) throw new Error("Activity from a registered provider requires source presentation metadata.");
  const custom = host === "manual" ? undefined : colors[host];
  return custom ? hexColor(custom, `${HOST_LABELS[host]} colour`) : DEFAULT_HOST_COLORS[host];
}

/** A row of coloured dots naming each host, for card footers. */
export function hostLegend(hosts: ActivityHost[], colors: HostColors, x: number, y: number): { svg: string; width: number } {
  let offset = 0;
  const items = hosts.map((host) => {
    if (!isLegacyHost(host)) throw new Error("Activity from a registered provider requires source presentation metadata.");
    const label = HOST_LABELS[host];
    const item = `<circle cx="${x + offset + 5}" cy="${y - 4}" r="5" fill="${hostColor(host, colors)}"/><text class="small" x="${x + offset + 15}" y="${y}">${escapeXml(label)}</text>`;
    offset += 15 + label.length * 7 + 14;
    return item;
  });
  return { svg: items.join(""), width: offset };
}

/** Public presentation metadata; credentials and server URLs never enter rendering. */
export interface RenderSource {
  id: string;
  label: string;
  color: string;
  metric: "commits" | "contributions";
  origin: "api" | "local";
  capabilities: SourceCapabilities;
  timezone?: string;
  /** Rich metadata enables daily descriptions, also in single-source summed cards. */
  detailed: boolean;
  /** Keep metric values visible even when the source label has to be shortened. */
  suffix?: string;
}

export function resolveSources(hosts: HostActivity[], colors: HostColors = {}): RenderSource[] {
  return hosts.map(({ host, source }) => {
    const legacy = isLegacyHost(host);
    if (!legacy && (!source || !source.origin || !source.metric || !source.capabilities)) {
      throw new Error("Activity from a registered provider requires complete source metadata.");
    }
    if (source && [source.id, source.label, source.color].some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("Invalid source presentation metadata.");
    }
    const origin = source?.origin ?? (host === "manual" ? "local" : "api");
    const metric = source?.metric ?? (host === "manual" ? "commits" : "contributions");
    if (!["api", "local"].includes(origin) || !["commits", "contributions"].includes(metric)) {
      throw new Error("Invalid source activity metadata.");
    }
    const capabilities = source?.capabilities ?? {
      totals: host === "manual" ? ["contributions", "commits"] as (keyof Totals)[] : Object.keys(emptyTotals()) as (keyof Totals)[],
      languages: host !== "manual",
      repos: host !== "manual",
    };
    if (!Array.isArray(capabilities.totals) || capabilities.totals.some((key) => !Object.hasOwn(emptyTotals(), key))
      || typeof capabilities.languages !== "boolean" || typeof capabilities.repos !== "boolean") {
      throw new Error("Invalid source capabilities.");
    }
    const metadata = { origin, metric, capabilities, timezone: source?.timezone, detailed: origin === "local" || source?.origin !== undefined || source?.capabilities !== undefined };
    if (!source) {
      if (!legacy) throw new Error("Activity from a registered provider requires source presentation metadata.");
      return { id: host, label: HOST_LABELS[host], color: hostColor(host, colors), ...metadata };
    }
    let color: string;
    try {
      color = hexColor(source.color);
    } catch {
      throw new Error("Invalid source colour: use a hex colour such as #2f80ed.");
    }
    return { id: source.id, label: source.label, color, ...metadata };
  });
}

export function activityUnit(source: RenderSource): string {
  return `${source.origin === "local" ? "local" : "API"} ${source.metric}`;
}

/** Explain source metrics without implying that unreported values were measured. */
export function activityDescription(sources: RenderSource[]): string {
  if (!sources.some((source) => source.detailed)) return "";
  const descriptions = sources.map((source) => {
    const timezone = source.timezone ? ` (${source.timezone})` : "";
    return `${source.label}: ${activityUnit(source)}${timezone}`;
  });
  const localSources = sources.filter((source) => source.origin === "local");
  const local = localSources.length && localSources.every((source) => source.metric === "commits"
    && source.capabilities.totals.every((key) => key === "commits" || key === "contributions")
    && !source.capabilities.languages && !source.capabilities.repos)
    ? " Local sources report commits only; other metrics are not reported." : "";
  const calendarOnly = sources.filter((source) => source.capabilities.totals.length === 1 && source.capabilities.totals[0] === "contributions"
    && !source.capabilities.languages && !source.capabilities.repos);
  const limited = calendarOnly.length ? ` ${calendarOnly.map((source) => source.label).join(", ")}: calendar activity only; other metrics are not reported.` : "";
  return ` Activity units: ${descriptions.join("; ")}. Source counting rules and date boundaries may differ.${local}${limited}`;
}

/** A missing value is different from a measured zero. */
export function reportedTotal(hosts: HostActivity[], sources: RenderSource[], key: keyof Totals): number | undefined {
  if (!sources.some((source) => source.capabilities.totals.includes(key))) return undefined;
  return hosts.reduce((total, host, index) => total + (sources[index]!.capabilities.totals.includes(key) ? host.totals[key] : 0), 0);
}

export function availabilityNote(message: string, x: number, y: number, width: number): { svg: string; height: number } {
  if (!message) return { svg: "", height: 0 };
  const lines = wrapText(message, Math.max(8, Math.floor(width / 7)), 6);
  return {
    svg: `<g><title>${escapeXml(message)}</title>${lines.map((line, index) => `<text class="small" x="${x}" y="${y + index * 16}">${escapeXml(line)}</text>`).join("")}</g>`,
    height: lines.length * 16 + 8,
  };
}

/** Conservative widths for the 12px legend font, including wide Unicode characters. */
function textWidth(text: string): number {
  return Array.from(text).reduce((width, char) => width + (char.codePointAt(0)! >= 0x2e80 ? 12 : /[MW@]/.test(char) ? 10 : 7), 0);
}

function shorten(text: string, width: number): string {
  if (textWidth(text) <= width) return text;
  const chars = Array.from(text);
  while (chars.length && textWidth(`${chars.join("")}…`) > width) chars.pop();
  return `${chars.join("")}…`;
}

/** A wrapping legend. `y` is the first baseline; height includes a 22px band per row. */
export function sourceLegend(sources: RenderSource[], x: number, y: number, availableWidth: number): { svg: string; width: number; height: number } {
  const width = Math.max(29, availableWidth);
  let offset = 0;
  let row = 0;
  let usedWidth = 0;
  const items = sources.map((source) => {
    const suffix = source.suffix ?? "";
    const label = shorten(source.label, Math.max(7, width - 15 - textWidth(suffix)));
    const text = `${label}${suffix}`;
    const itemWidth = 15 + textWidth(text);
    if (offset > 0 && offset + itemWidth > width) {
      row++;
      offset = 0;
    }
    const baseline = y + row * 22;
    const item = `<g><title>${escapeXml(source.label + suffix)}</title><circle cx="${x + offset + 5}" cy="${baseline - 4}" r="5" fill="${source.color}"/><text class="small" x="${x + offset + 15}" y="${baseline}">${escapeXml(text)}</text></g>`;
    usedWidth = Math.max(usedWidth, offset + itemWidth);
    offset += itemWidth + 14;
    return item;
  });
  return { svg: items.join(""), width: usedWidth, height: sources.length ? (row + 1) * 22 : 0 };
}
