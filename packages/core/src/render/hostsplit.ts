import type { CombinedActivity, Totals } from "../model.ts";
import { activityDescription, availabilityNote, reportedTotal, resolveSources, sourceLegend, type HostColors } from "./hosts.ts";
import { escapeXml, formatNumber, renderFrame, titleOffset, type CardOptions } from "./svg.ts";

export interface HostSplitCardOptions extends CardOptions {
  hostColors?: HostColors;
}

const METRICS: { key: keyof Totals; label: string }[] = [
  { key: "commits", label: "Commits" },
  { key: "pullRequests", label: "PRs / MRs" },
  { key: "issues", label: "Issues" },
];

/**
 * How activity splits between the hosts: a donut of contributions, then a
 * split bar for commits, PRs/MRs and issues.
 */
export function renderHostSplitCard(activity: CombinedActivity, options: HostSplitCardOptions = {}): string {
  const width = options.width ?? 300;
  const top = titleOffset(options);
  const sources = resolveSources(activity.hosts, options.hostColors);
  const hasLocal = sources.some((source) => source.origin === "local");
  const sourceAware = hasLocal || activity.hosts.some((host) => host.source);
  const unit = sources.some((source) => source.metric !== "contributions") ? "activity" : "contributions";
  const reported = (key: keyof Totals) => reportedTotal(activity.hosts, sources, key);
  const share = (key: keyof Totals) => {
    const total = reported(key);
    return activity.hosts.map((host, index) => {
      const source = sources[index]!;
      const value = source.capabilities.totals.includes(key) ? host.totals[key] : undefined;
      return { source, value, percent: total && value !== undefined ? (value / total) * 100 : 0 };
    });
  };
  const valueText = (value: number | undefined) => value === undefined ? "—" : formatNumber(value);

  const body: string[] = [];

  // New source legends go below the donut so their height is not constrained.
  const radius = 40;
  const cx = sourceAware ? width / 2 : 25 + radius + 7;
  const cy = radius - 6;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  body.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="var(--text)" stroke-opacity="0.15" stroke-width="14"/>`);
  for (const part of share("contributions")) {
    const length = (part.percent / 100) * circumference;
    if (length <= 0) continue;
    body.push(
      `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${part.source.color}" stroke-width="14" stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`,
    );
    offset += length;
  }
  body.push(
    `<text class="text bold" x="${cx}" y="${cy - 1}" text-anchor="middle">${valueText(reported("contributions"))}</text>`,
    `<text class="small" x="${cx}" y="${cy + 13}" text-anchor="middle" style="font-size:9px">${unit}</text>`,
  );
  let metricY = 2 * radius + 24;
  if (sourceAware) {
    const legend = sourceLegend(
      share("contributions").map((part) => ({ ...part.source, suffix: part.value === undefined ? ": —" : ` ${part.percent.toFixed(0)}%` })),
      25,
      metricY,
      width - 50,
    );
    body.push(legend.svg);
    metricY += legend.height + 16;
  } else {
    share("contributions").forEach((part, i) => {
      const lx = cx + radius + 22;
      const ly = cy - 8 + i * 22;
      body.push(
        `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${part.source.color}"/>`,
        `<text class="small" x="${lx + 15}" y="${ly}"><tspan class="bold">${escapeXml(part.source.label)}</tspan> ${part.percent.toFixed(0)}%</text>`,
      );
    });
  }

  // A split bar per metric.
  const barWidth = width - 50;
  METRICS.forEach(({ key, label }) => {
    const y = metricY;
    const parts = share(key);
    body.push(
      `<text class="small" x="25" y="${y}">${label}</text>`,
      `<text class="small" x="${width - 25}" y="${y}" text-anchor="end">${sourceAware ? valueText(reported(key)) : parts.map((p) => valueText(p.value)).join(" · ")}</text>`,
      `<clipPath id="split-${key}"><rect x="25" y="${y + 8}" width="${barWidth}" height="8" rx="4"/></clipPath>`,
      `<rect x="25" y="${y + 8}" width="${barWidth}" height="8" rx="4" fill="var(--text)" fill-opacity="0.15"/>`,
    );
    let x = 25;
    const segments = parts.map((part) => {
      const w = (part.percent / 100) * barWidth;
      const rect = `<rect x="${x.toFixed(2)}" y="${y + 8}" width="${w.toFixed(2)}" height="8" fill="${part.source.color}"/>`;
      x += w;
      return rect;
    });
    body.push(`<g clip-path="url(#split-${key})">${segments.join("")}</g>`);
    if (sourceAware) {
      const legend = sourceLegend(parts.map((part) => ({ ...part.source, suffix: `: ${valueText(part.value)}` })), 25, y + 36, barWidth);
      body.push(legend.svg);
      metricY += 36 + legend.height + 16;
    } else {
      metricY += 40;
    }
  });

  const partial = sources.some((source) => METRICS.some(({ key }) => !source.capabilities.totals.includes(key)));
  const note = availabilityNote(partial ? "— = not reported. Totals include reporting sources only." : "", 25, metricY, barWidth);
  body.push(note.svg);
  const height = top + metricY - 5 + note.height;
  const description = [
    ...share("contributions").map((p) => p.value === undefined ? `${p.source.label}: ${unit} not reported` : `${p.source.label} ${p.percent.toFixed(0)}% of ${unit}`),
    ...METRICS.map(({ key, label }) => `${label}: ${share(key).map((p) => `${p.source.label} ${p.value ?? "not reported"}`).join(", ")}`),
  ].join(". ") + activityDescription(sources);

  return renderFrame({
    ...options,
    width,
    height,
    title: sourceAware || sources.length > 1 ? "Activity by Host" : `Activity on ${sources[0]?.label ?? "GitHub"}`,
    description,
    body: body.join(""),
  });
}
