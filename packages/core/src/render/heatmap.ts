import { addDays, toDateKey, type CombinedActivity, type DateKey } from "../model.ts";
import { activityDescription, activityUnit, hostLegend, resolveSources, sourceLegend, type HostColors } from "./hosts.ts";
import { escapeXml, formatNumber, renderFrame, titleOffset, type CardOptions } from "./svg.ts";

export interface HeatmapCardOptions extends CardOptions {
  /** `last-year` (the default) shows 53 weeks; `all` shows every calendar year, newest first. */
  range?: "last-year" | "all";
  /**
   * `hosts` (the default) splits each day's square by host colour; `single`
   * uses one colour, the theme's icon colour.
   */
  mode?: "hosts" | "single";
  hostColors?: HostColors;
}

const CELL = 10;
const STEP = 13;
/** Space for the weekday labels, left of the grid. */
const LABELS = 30;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const OPACITY = [0, 0.4, 0.6, 0.8, 1];

interface Day {
  total: number;
  bySource: [string, number][];
}

export function renderHeatmapCard(activity: CombinedActivity, options: HeatmapCardOptions = {}): string {
  const today = toDateKey(activity.generatedAt);
  const range = options.range ?? "last-year";
  const mode = options.mode ?? "hosts";
  const hosts = activity.hosts.map((h) => h.host);
  const sources = resolveSources(activity.hosts, options.hostColors);
  const hasLocal = sources.some((source) => source.origin === "local");
  const activityUnits = sources.some((source) => source.metric !== "contributions");
  const detailed = sources.some((source) => source.detailed);
  const sourceAware = hasLocal || activity.hosts.some((h) => h.source);
  const colors = Object.fromEntries(sources.map((source) => [source.id, source.color]));
  const single = "var(--icon)";
  const unit = activityUnits ? "activity units" : "contributions";

  const tooltip = (date: DateKey, total: number): string => {
    if (!detailed) return "";
    const parts = activity.hosts.map((host, index) => {
      const source = sources[index]!;
      const timezone = source.timezone ? ` (${source.timezone})` : "";
      return `${source.label}: ${formatNumber(host.days[date] ?? 0, "long")} ${activityUnit(source)}${timezone}`;
    });
    return `<title>${escapeXml(`${date}: ${formatNumber(total, "long")} ${unit}. ${parts.join("; ")}.`)}</title>`;
  };

  const days = (date: DateKey): Day => {
    const bySource = activity.hosts
      .map((h, index) => [sources[index]!.id, h.days[date] ?? 0] as [string, number])
      .filter(([, count]) => count > 0);
    return { total: bySource.reduce((sum, [, count]) => sum + count, 0), bySource };
  };

  const blocks: { start: DateKey; end: DateKey; label?: string }[] = [];
  if (range === "all") {
    const first = Object.keys(activity.days)[0] ?? today;
    for (let year = Number(today.slice(0, 4)); year >= Number(first.slice(0, 4)); year--) {
      blocks.push({ start: `${year}-01-01`, end: year === Number(today.slice(0, 4)) ? today : `${year}-12-31`, label: String(year) });
    }
  } else {
    blocks.push({ start: addDays(today, -364), end: today });
  }

  const thresholds = levels(blocks.flatMap((block) => datesBetween(block.start, block.end).map((d) => days(d).total)));
  const level = (count: number) => (count === 0 ? 0 : 1 + thresholds.filter((t) => count > t).length);

  const top = titleOffset(options);
  const blockHeight = 15 + 7 * STEP + 10;
  // A card wider than the grid centres it, labels included.
  const columns = Math.max(...blocks.map((block) => weeksBetween(sundayOnOrBefore(block.start), block.end)));
  const natural = 25 + LABELS + columns * STEP + 25;
  const LEFT = 25 + LABELS + Math.max(0, Math.floor(((options.width ?? 0) - natural) / 2));
  const body: string[] = [];
  let total = 0;
  let width = 0;

  blocks.forEach((block, b) => {
    const y0 = b * (blockHeight + (block.label ? 20 : 0)) + (block.label ? 20 : 0);
    const gridStart = sundayOnOrBefore(block.start);
    const empty: string[] = [];
    const filled: string[] = [];
    let lastMonth = -1;
    let blockTotal = 0;
    let columns = 0;

    for (let date = gridStart, i = 0; date <= block.end; date = addDays(date, 1), i++) {
      const column = Math.floor(i / 7);
      const row = i % 7;
      columns = column + 1;
      if (date < block.start) continue;
      const x = LEFT + column * STEP;
      const y = y0 + 15 + row * STEP;

      const month = Number(date.slice(5, 7)) - 1;
      if (month !== lastMonth && row === 0) {
        if (lastMonth !== -1 || Number(date.slice(8)) <= 7) body.push(`<text class="small" x="${x}" y="${y0 + 8}">${MONTHS[month]}</text>`);
        lastMonth = month;
      }

      const day = days(date);
      blockTotal += day.total;
      const details = tooltip(date, day.total);
      if (day.total === 0) {
        if (detailed) {
          filled.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" fill="var(--text)" fill-opacity="0.12">${details}</rect>`);
        } else {
          empty.push(`M${x} ${y}h${CELL}v${CELL}h-${CELL}z`);
        }
        continue;
      }
      const opacity = OPACITY[level(day.total)];
      if (mode === "single" || day.bySource.length === 1) {
        const fill = mode === "single" ? single : colors[day.bySource[0]![0]];
        const rect = `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}" fill-opacity="${opacity}"`;
        filled.push(details ? `${rect}>${details}</rect>` : `${rect}/>`);
      } else {
        // Round cumulative boundaries so small segments never accumulate past the cell.
        let offset = 0;
        let cumulative = 0;
        const parts = day.bySource.map(([source, count], index) => {
          cumulative += count;
          const boundary = index === day.bySource.length - 1 ? CELL : Math.round((cumulative / day.total) * CELL * 10) / 10;
          const height = boundary - offset;
          const part = `<rect x="${x}" y="${(y + offset).toFixed(1)}" width="${CELL}" height="${height.toFixed(1)}" fill="${colors[source]}"/>`;
          offset = boundary;
          return part;
        });
        filled.push(`<g fill-opacity="${opacity}">${details}${parts.join("")}</g>`);
      }
    }

    total += blockTotal;
    width = Math.max(width, options.width ?? 0, LEFT + columns * STEP + 25);
    if (block.label) {
      body.push(`<text class="text bold" x="25" y="${y0 - 6}">${block.label}</text>`);
      body.push(`<text class="small" x="${25 + 45}" y="${y0 - 6}">${formatNumber(blockTotal, "long")} ${unit}</text>`);
    }
    for (const [row, name] of [[1, "Mon"], [3, "Wed"], [5, "Fri"]] as const) {
      body.push(`<text class="small" x="${LEFT - LABELS}" y="${y0 + 15 + row * STEP + 9}">${name}</text>`);
    }
    if (!detailed) body.push(`<path d="${empty.join("")}" fill="var(--text)" fill-opacity="0.12"/>`);
    body.push(...filled);
  });

  const legendY = blocks.length * blockHeight + blocks.filter((block) => block.label).length * 20 + 10;
  const scaleX = width - 25 - 5 * STEP - 70;
  let scaleY = legendY;
  if (mode === "hosts" || detailed) {
    if (sourceAware) {
      const legend = sourceLegend(sources, 25, legendY, width - 50);
      body.push(legend.svg);
      if (legend.height > 22 || legend.width > scaleX - 25 - 14) scaleY += legend.height;
    } else {
      body.push(hostLegend(hosts, options.hostColors ?? {}, 25, legendY).svg);
    }
  }
  body.push(`<text class="small" x="${scaleX}" y="${scaleY}">Less</text>`);
  OPACITY.forEach((opacity, i) => {
    const x = scaleX + 32 + i * STEP;
    body.push(
      i === 0
        ? `<rect x="${x}" y="${scaleY - 9}" width="${CELL}" height="${CELL}" rx="2" fill="var(--text)" fill-opacity="0.12"/>`
        : `<rect x="${x}" y="${scaleY - 9}" width="${CELL}" height="${CELL}" rx="2" fill="${mode === "single" ? single : "var(--text)"}" fill-opacity="${opacity}"/>`,
    );
  });
  body.push(`<text class="small" x="${scaleX + 32 + 5 * STEP + 3}" y="${scaleY}">More</text>`);

  const since = blocks.at(-1)!.start.slice(0, 4);
  const title =
    range === "all"
      ? `${formatNumber(total, "long")} ${unit} since ${since}`
      : `${formatNumber(total, "long")} ${unit} in the last year`;
  const hostNames = sources.map((source) => source.label).join(" and ");

  return renderFrame({
    ...options,
    width,
    height: top + scaleY + 20,
    title,
    description: `${activityUnits ? "Activity" : "Contribution"} calendar combining ${hostNames}: ${title}.${activityDescription(sources)}`,
    body: body.join(""),
  });
}

/** GitHub-style levels: quartiles of the days that have any activity. */
function levels(counts: number[]): number[] {
  const active = counts.filter((count) => count > 0).sort((a, b) => a - b);
  if (active.length === 0) return [0, 0, 0];
  return [0.25, 0.5, 0.75].map((q) => active[Math.min(active.length - 1, Math.floor(q * active.length))]!);
}

function datesBetween(start: DateKey, end: DateKey): DateKey[] {
  const dates: DateKey[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function weeksBetween(start: DateKey, end: DateKey): number {
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
  return Math.floor(days / 7) + 1;
}

function sundayOnOrBefore(date: DateKey): DateKey {
  return addDays(date, -new Date(`${date}T00:00:00Z`).getUTCDay());
}
