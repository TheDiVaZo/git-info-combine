import type { Host, HostActivity } from "../model.ts";
import { DEFAULT_HOST_COLORS, escapeXml, HOST_LABELS, hexColor } from "./svg.ts";

export type HostColors = Partial<Record<Host, string>>;

export function hostColor(host: Host, colors: HostColors = {}): string {
  const custom = colors[host];
  return custom ? hexColor(custom, `${HOST_LABELS[host]} colour`) : DEFAULT_HOST_COLORS[host];
}

/** A row of coloured dots naming each host, for card footers. */
export function hostLegend(hosts: Host[], colors: HostColors, x: number, y: number): { svg: string; width: number } {
  let offset = 0;
  const items = hosts.map((host) => {
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
  /** Keep metric values visible even when the source label has to be shortened. */
  suffix?: string;
}

export function resolveSources(hosts: HostActivity[], colors: HostColors = {}): RenderSource[] {
  return hosts.map(({ host, source }) => {
    if (!source) return { id: host, label: HOST_LABELS[host], color: hostColor(host, colors) };
    let color: string;
    try {
      color = hexColor(source.color);
    } catch {
      throw new Error("Invalid source colour: use a hex colour such as #2f80ed.");
    }
    return { id: source.id, label: source.label, color };
  });
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
