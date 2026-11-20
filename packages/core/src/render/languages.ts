import type { CombinedActivity, LanguageStat } from "../model.ts";
import { availabilityNote, resolveSources } from "./hosts.ts";
import { LANGUAGE_COLORS } from "./language-colors.ts";
import { escapeXml, renderFrame, titleOffset, type CardOptions } from "./svg.ts";

export interface LanguagesCardOptions extends CardOptions {
  layout?: "normal" | "compact";
  /** How many languages to show. Defaults to 5 (normal) or 6 (compact). */
  count?: number;
  /** Language names to leave out. */
  hide?: string[];
  /**
   * `repo` (the default) counts every repo once, split by its languages.
   * `size` weighs languages by bytes, so big repos dominate.
   */
  weighting?: "repo" | "size";
}

export interface LanguageShare {
  name: string;
  color: string;
  /** Share of the shown languages, 0–100. */
  percent: number;
}

/** The top languages, as shares of the languages shown, like GitHub Stats Extended. */
export function topLanguages(
  activity: CombinedActivity,
  count: number,
  hide: string[] = [],
  weighting: "repo" | "size" = "repo",
): LanguageShare[] {
  const sources = resolveSources(activity.hosts);
  let languages = activity.languages;
  if (sources.some((source) => !source.capabilities.languages)) {
    languages = {};
    activity.hosts.forEach((host, index) => {
      if (!sources[index]!.capabilities.languages) return;
      for (const [name, value] of Object.entries(host.languages)) {
        const total: LanguageStat = languages[name] ??= { size: 0, weight: 0, repos: 0, color: value.color };
        total.size += value.size;
        total.weight += value.weight;
        total.repos += value.repos;
        total.color ??= value.color;
      }
    });
  }
  const hidden = new Set(hide.map((name) => name.trim().toLowerCase()));
  const value = (stat: { size: number; weight: number }) => (weighting === "size" ? stat.size : stat.weight);
  const top = Object.entries(languages)
    .filter(([name, stat]) => !hidden.has(name.toLowerCase()) && value(stat) > 0)
    .sort(([, a], [, b]) => value(b) - value(a))
    .slice(0, count);
  const total = top.reduce((sum, [, stat]) => sum + value(stat), 0);
  return top.map(([name, stat]) => ({
    name,
    color: stat.color ?? LANGUAGE_COLORS[name] ?? "#858585",
    percent: total ? (value(stat) / total) * 100 : 0,
  }));
}

export function renderLanguagesCard(activity: CombinedActivity, options: LanguagesCardOptions = {}): string {
  const WIDTH = options.width ?? 300;
  const BAR_WIDTH = WIDTH - 50;
  const layout = options.layout ?? "normal";
  const sources = resolveSources(activity.hosts);
  const unavailable = sources.filter((source) => !source.capabilities.languages);
  const noneReport = sources.length > 0 && unavailable.length === sources.length;
  const languages = topLanguages(activity, options.count ?? (layout === "compact" ? 6 : 5), options.hide, options.weighting);
  const top = titleOffset(options);

  let body: string;
  let height: number;
  if (languages.length === 0) {
    body = `<text class="small" x="25" y="0">${noneReport ? "Languages not reported." : "No languages found."}</text>`;
    height = top + 30;
  } else if (layout === "compact") {
    let x = 0;
    const segments = languages.map((language) => {
      const width = (language.percent / 100) * BAR_WIDTH;
      const segment = `<rect x="${x.toFixed(2)}" y="0" width="${width.toFixed(2)}" height="8" fill="${language.color}"/>`;
      x += width;
      return segment;
    });
    const legend = languages.map((language, i) => {
      const lx = 25 + (i % 2) * (BAR_WIDTH / 2 + 25);
      const ly = 28 + Math.floor(i / 2) * 25;
      return `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${language.color}"/><text class="small" x="${lx + 15}" y="${ly}">${escapeXml(language.name)} ${language.percent.toFixed(2)}%</text>`;
    });
    body =
      `<clipPath id="bar"><rect x="0" y="0" width="${BAR_WIDTH}" height="8" rx="4"/></clipPath>` +
      `<g transform="translate(25 -8)"><g clip-path="url(#bar)">${segments.join("")}</g></g>` +
      legend.join("");
    height = top + 18 + Math.ceil(languages.length / 2) * 25;
  } else {
    body = languages
      .map((language, i) => {
        const y = i * 40;
        const filled = Math.max((language.percent / 100) * BAR_WIDTH, 2);
        return (
          `<text class="small" x="25" y="${y}">${escapeXml(language.name)}</text>` +
          `<text class="small" x="${WIDTH - 25}" y="${y}" text-anchor="end">${language.percent.toFixed(2)}%</text>` +
          `<rect x="25" y="${y + 8}" width="${BAR_WIDTH}" height="8" rx="4" fill="var(--text)" fill-opacity="0.15"/>` +
          `<rect x="25" y="${y + 8}" width="${filled.toFixed(2)}" height="8" rx="4" fill="${language.color}"/>`
        );
      })
      .join("");
    height = top + languages.length * 40 - 5;
  }

  const note = availabilityNote(unavailable.length && !noneReport ? "Languages include reporting sources only." : "", 25, height - top + 5, BAR_WIDTH);
  body += note.svg;
  height += note.height;
  return renderFrame({
    ...options,
    width: WIDTH,
    height,
    title: "Most Used Languages",
    description: (languages.map((l) => `${l.name} ${l.percent.toFixed(2)}%`).join(", ") || (noneReport ? "Languages not reported." : "No languages found."))
      + (unavailable.length ? ` Sources without language statistics: ${unavailable.map((source) => source.label).join(", ")}.` : ""),
    body,
  });
}
