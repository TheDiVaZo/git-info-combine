import { describe, expect, test } from "bun:test";
import { combine } from "../src/combine.ts";
import { emptyTotals, type HostActivity } from "../src/model.ts";
import {
  escapeXml,
  renderHeatmapCard,
  renderHostSplitCard,
  renderLanguagesCard,
  renderLayout,
  renderStatsCard,
  svgHeight,
  svgWidth,
} from "../src/render/index.ts";

const now = new Date("2026-11-20T12:00:00Z");
const manual: HostActivity = {
  host: "manual",
  source: { id: "manual:exbo", label: "EXBO", color: "#a855f7", metric: "commits", timezone: "Europe/Moscow" },
  login: "",
  days: { "2026-11-18": 6, "2026-11-19": 4 },
  totals: { ...emptyTotals(), contributions: 10, commits: 10 },
  languages: {},
  repos: { public: 0, private: 0 },
};
const github: HostActivity = {
  host: "github", login: "octo", days: { "2026-11-18": 2 },
  totals: { ...emptyTotals(), contributions: 2, commits: 1, issues: 1 },
  languages: {}, repos: { public: 1, private: 0 },
};
const gitlab = (id: string, label: string, color: string): HostActivity => ({
  host: "gitlab", login: "octo", source: { id, label, color }, days: { "2026-11-18": 1 },
  totals: { ...emptyTotals(), contributions: 1, commits: 1 }, languages: {}, repos: { public: 1, private: 0 },
});
const mixed = combine([github, gitlab("work", "Work", "#fc6d26"), gitlab("community", "Community", "#2f80ed"), manual], now);

function tooltip(svg: string, date: string): string {
  const found = [...svg.matchAll(/<title>([^<]*)<\/title>/g)].find((match) => match[1]!.startsWith(`${date}:`));
  expect(found).toBeDefined();
  return found![1]!;
}

describe("manual source rendering", () => {
  test("manual-only summed heatmap uses the configured green and retains the source legend", () => {
    const svg = renderHeatmapCard(combine([manual], now), { mode: "single", iconColor: "40c463" });
    expect(svg).toContain("--icon:#40c463");
    expect(svg).toContain('fill="var(--icon)"');
    expect(svg).toContain("<title>EXBO</title>");
    expect(svg).toContain('fill="#a855f7"');
    expect(svg).toContain("10 activity units in the last year");
    expect(svg).not.toContain("10 contributions");
    expect(tooltip(svg, "2026-11-18")).toBe("2026-11-18: 6 activity units. EXBO: 6 local commits (Europe/Moscow).");
  });

  test("every day, including zero days, describes all automatic and manual sources", () => {
    const svg = renderHeatmapCard(mixed, { mode: "single", iconColor: "40c463" });
    expect(tooltip(svg, "2026-11-18")).toBe(
      "2026-11-18: 10 activity units. GitHub: 2 API contributions; Work: 1 API contributions; Community: 1 API contributions; EXBO: 6 local commits (Europe/Moscow).",
    );
    expect(tooltip(svg, "2026-11-19")).toContain("GitHub: 0 API contributions");
    expect(tooltip(svg, "2026-11-20")).toContain("0 activity units");
    expect(tooltip(svg, "2026-11-20")).toContain("EXBO: 0 local commits (Europe/Moscow)");
    expect([...svg.matchAll(/<title>\d{4}-\d{2}-\d{2}:/g)]).toHaveLength(365);
    expect(svg).toContain("Source counting rules and date boundaries may differ");
    for (const name of ["GitHub", "Work", "Community", "EXBO"]) expect(svg).toContain(`<title>${name}</title>`);
  });

  test("split cells preserve four independent source shares and the same total", () => {
    const svg = renderHeatmapCard(mixed, { mode: "hosts" });
    const cell = svg.match(/<g fill-opacity="[\d.]+"><title>2026-11-18:[^<]*<\/title>(.*?)<\/g>/)![1]!;
    expect([...cell.matchAll(/height="([\d.]+)"/g)].map((match) => Number(match[1]))).toEqual([2, 1, 1, 6]);
    for (const color of ["#40c463", "#fc6d26", "#2f80ed", "#a855f7"]) expect(cell).toContain(`fill="${color}"`);
    expect(svg).toContain("14 activity units in the last year");
    expect(renderHeatmapCard(mixed, { mode: "single" })).toContain("14 activity units in the last year");
  });

  test("untrusted labels and timezone metadata remain escaped in text, descriptions and tooltips", () => {
    const label = '<script>&"\' Source';
    const activity = combine([{ ...manual, source: { ...manual.source!, label, timezone: '<zone>&"' } }], now);
    for (const render of [renderHeatmapCard, renderHostSplitCard, renderStatsCard]) {
      const svg = render(activity);
      expect(svg).not.toContain("<script>");
      expect(svg).not.toContain("<zone>");
      expect(svg).toContain(escapeXml(label));
      expect(svg).toContain(escapeXml('<zone>&"'));
    }
  });

  test("manual-only stats have a neutral title and do not invent unavailable metrics", () => {
    const activity = combine([manual], now);
    const svg = renderStatsCard(activity);
    expect(svg).toContain("<title id=\"title\">Git Activity Stats</title>");
    expect(svg).not.toContain("&apos;s Git Stats");
    expect(svg).toContain("Total Commits: 10");
    expect(svg).toContain("Total Stars Earned: 0");
    expect(svg).toContain("Local sources report commits only; other metrics are not reported");
    expect(renderStatsCard(activity, { name: "octo" })).toContain("octo&apos;s Git Stats");
    expect(renderLanguagesCard(activity)).not.toContain("TypeScript");
    expect(renderHostSplitCard(activity)).toContain("EXBO 100% of activity");
    expect(renderHostSplitCard(activity)).toContain("EXBO: local commits (Europe/Moscow)");
  });

  test("empty local history is finite and still has a labeled zero-day tooltip", () => {
    const activity = combine([{ ...manual, days: {}, totals: emptyTotals() }], now);
    for (const render of [renderHeatmapCard, renderHostSplitCard, renderStatsCard]) {
      const svg = render(activity);
      expect(svg).not.toMatch(/NaN|Infinity|height="-/);
      expect(svg).toContain("EXBO");
    }
    expect(tooltip(renderHeatmapCard(activity), "2026-11-20")).toContain("EXBO: 0 local commits");
  });

  test("manual source fallbacks are safe for direct render API callers without descriptors", () => {
    const activity = combine([{ ...manual, source: undefined }], now);
    const svg = renderHeatmapCard(activity, { mode: "single" });
    expect(svg).toContain("<title>Manual</title>");
    expect(tooltip(svg, "2026-11-18")).toContain("Manual: 6 local commits");
    expect(renderHostSplitCard(activity)).toContain("Manual 100% of activity");
  });

  test("many local labels wrap without changing layout width or overlapping the following row", () => {
    const activity = combine(Array.from({ length: 8 }, (_, index) => ({
      ...manual,
      source: { ...manual.source!, id: `manual:source-${index}`, label: `Long source name number ${index} for an exported repository group` },
    })), now);
    const renderStats = (extra: object) => renderStatsCard(activity, extra);
    const renderHosts = (extra: object) => renderHostSplitCard(activity, extra);
    const layout = renderLayout([[renderStats, renderHosts], [renderStats]], { width: 650 });
    const nested = [...layout.combined.matchAll(/<svg x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)].map((match) => match.slice(1).map(Number));
    expect(svgWidth(layout.combined)).toBe(650);
    expect(nested[0]![3]).toBe(nested[1]![3]);
    expect(nested[2]![1]).toBe(nested[0]![3]! + 10);
    const summed = renderHeatmapCard(activity, { mode: "single" });
    expect(svgHeight(summed)).toBeGreaterThan(svgHeight(renderHeatmapCard(combine([manual], now), { mode: "single" })));
  });

  test.each(["light_github", "dark_github"])("both %s and split/single rendering keep the source labels", (theme) => {
    for (const mode of ["single", "hosts"] as const) {
      const svg = renderHeatmapCard(mixed, { theme, mode, iconColor: "40c463" });
      expect(svg).toContain("--icon:#40c463");
      expect(svg).toContain("<title>EXBO</title>");
      expect(tooltip(svg, "2026-11-18")).toContain("10 activity units");
    }
  });
});
