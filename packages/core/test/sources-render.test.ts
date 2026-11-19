import { describe, expect, test } from "bun:test";
import { combine } from "../src/combine.ts";
import { emptyTotals, type HostActivity } from "../src/model.ts";
import { resolveSources, sourceLegend } from "../src/render/hosts.ts";
import {
  escapeXml,
  renderHeatmapCard,
  renderHostSplitCard,
  renderLayout,
  renderStatsCard,
  svgHeight,
  svgWidth,
} from "../src/render/index.ts";
import { NOW } from "./fixtures.ts";

const COLORS = ["#fc6d26", "#2f80ed", "#a371f7", "#d29922", "#39c5cf", "#db61a2", "#8b949e", "#ff7b72"];
const gitlab = (index: number, contributions = index + 1, label = `GitLab ${index + 1}`): HostActivity => ({
  host: "gitlab",
  login: "octo",
  source: { id: `opaque-${index}`, label, color: COLORS[index % COLORS.length]! },
  days: { "2026-10-01": contributions },
  totals: { ...emptyTotals(), contributions, commits: contributions * 2, pullRequests: contributions, contributedTo: 1 },
  languages: {},
  repos: { public: 1, private: 0 },
});
const github: HostActivity = { ...gitlab(0, 1), host: "github", source: undefined };
const activity = combine([github, gitlab(0, 2, "Work"), gitlab(1, 3, "Personal")], NOW);
const renderers = [renderHeatmapCard, renderStatsCard, renderHostSplitCard];

describe("source-aware cards", () => {
  test("each server retains its label and colour, including alongside legacy GitHub", () => {
    for (const render of renderers) {
      const svg = render(activity, { hostColors: { github: "#123456", gitlab: "#654321" } });
      for (const label of ["GitHub", "Work", "Personal"]) expect(svg).toContain(label);
      for (const color of ["#123456", "#fc6d26", "#2f80ed"]) expect(svg).toContain(color);
      expect(svg).not.toContain("#654321");
    }
    const heatmap = renderHeatmapCard(activity);
    const segments = heatmap.match(/<g fill-opacity="[\d.]+">(<rect[^]*?)<\/g>/)![1]!;
    const heights = [...segments.matchAll(/height="([\d.]+)"/g)].map((match) => Number(match[1]));
    expect(heights).toEqual([1.7, 3.3, 5]);
    expect(renderHostSplitCard(activity)).toContain("Work 33% of contributions");
    expect(renderHostSplitCard(activity)).toContain("Personal 50% of contributions");
  });

  test("single-colour heatmaps keep their existing behaviour", () => {
    const svg = renderHeatmapCard(activity, { mode: "single" });
    expect(svg).toContain('fill="var(--icon)"');
    expect(svg).not.toContain(COLORS[0]!);
    expect(svg).not.toContain("<title>Work</title>");
  });

  test("many small shares never overflow or produce a negative heatmap segment", () => {
    const many = combine(Array.from({ length: 120 }, (_, index) => gitlab(index, 1)), NOW);
    const svg = renderHeatmapCard(many);
    const segments = svg.match(/<g fill-opacity="[\d.]+">(<rect[^]*?)<\/g>/)![1]!;
    const heights = [...segments.matchAll(/height="(-?[\d.]+)"/g)].map((match) => Number(match[1]));
    expect(heights).toHaveLength(120);
    expect(heights.every((height) => height >= 0)).toBe(true);
    expect(heights.reduce((sum, height) => sum + height, 0)).toBeCloseTo(10, 10);
  });

  test("legends wrap and retain complete safe labels when their visible text is shortened", () => {
    const label = 'Рабочий <script>&"\' ' + "LongSource".repeat(12);
    const many = combine(Array.from({ length: 8 }, (_, index) => gitlab(index, index + 1, `${label} ${index}`)), NOW);
    const one = combine([gitlab(0, 1, "Work")], NOW);
    for (const render of renderers) {
      const svg = render(many);
      expect(svgHeight(svg)).toBeGreaterThan(svgHeight(render(one)));
      expect(svg).not.toContain("<script>");
      expect(svg).toContain(escapeXml(`${label} 0`));
      expect(svg).toContain("…");
    }
    const legend = sourceLegend(resolveSources(many.hosts), 25, 20, 250);
    expect(legend.width).toBeLessThanOrEqual(250);
    expect(legend.height).toBe(8 * 22);
    const svg = renderHeatmapCard(many);
    const lastSourceY = Math.max(...[...svg.matchAll(/<text class="small" x="[\d.]+" y="([\d.]+)">[^<]*…<\/text>/g)].map((match) => Number(match[1])));
    const scaleY = Number(svg.match(/<text class="small" x="[\d.]+" y="([\d.]+)">Less<\/text>/)![1]);
    expect(scaleY).toBeGreaterThan(lastSourceY);
  });

  test("a growing footer and minHeight do not move the rank into the legend", () => {
    const short = combine([gitlab(0)], NOW);
    const many = combine(Array.from({ length: 8 }, (_, index) => gitlab(index, 1, `Long source number ${index}`)), NOW);
    const rankPosition = (svg: string) => svg.match(/<g transform="translate\(([\d.]+) ([\d.]+)\)"><circle r="40"/)!.slice(1).map(Number);
    const shortSvg = renderStatsCard(short);
    const manySvg = renderStatsCard(many);
    expect(rankPosition(manySvg)).toEqual(rankPosition(shortSvg));
    expect(rankPosition(renderStatsCard(many, { minHeight: 1000 }))).toEqual(rankPosition(manySvg));
    const firstLegendY = Number(manySvg.match(/<g><title>[^<]*<\/title><circle cx="[\d.]+" cy="([\d.]+)"/)![1]) + 4;
    expect(rankPosition(manySvg)[1]! + 43).toBeLessThan(firstLegendY - 10);
    expect(renderStatsCard(many, { showHosts: false })).not.toContain("<title>Long source");
  });

  test("zero activity stays finite and keeps every source visible", () => {
    const zero = combine([gitlab(0, 0, "Work"), gitlab(1, 0, "Personal")], NOW);
    for (const render of renderers) {
      const svg = render(zero);
      expect(svg).not.toMatch(/NaN|Infinity|height="-/);
      expect(svg).toContain("Work");
      expect(svg).toContain("Personal");
    }
    expect(renderHostSplitCard(zero)).toContain("Work 0% of contributions");
    expect(renderHostSplitCard(zero)).toContain("Personal: 0");
  });

  test("metric values survive truncation and remain below the contribution legend", () => {
    const many = combine(Array.from({ length: 8 }, (_, index) => gitlab(index, 5000, "Very long company nickname".repeat(5))), NOW);
    const svg = renderHostSplitCard(many, { width: 260 });
    expect(svg).toContain("…: 10k</text>");
    const percentages = [...svg.matchAll(/<text class="small" x="[\d.]+" y="([\d.]+)">[^<]*%<\/text>/g)].map((match) => Number(match[1]));
    const commitsY = Number(svg.match(/<text class="small" x="25" y="([\d.]+)">Commits<\/text>/)![1]);
    expect(commitsY).toBeGreaterThan(Math.max(...percentages) + 14);
  });

  test("narrow layouts measure wrapped footers and leave the next row below them", () => {
    const many = combine(Array.from({ length: 8 }, (_, index) => gitlab(index, 1, `Work server ${index + 1} with a long name`)), NOW);
    const stats = (extra: object) => renderStatsCard(many, extra);
    const hosts = (extra: object) => renderHostSplitCard(many, extra);
    const layout = renderLayout([[stats, hosts], [stats]], { width: 650, gap: 10 });
    const nested = [...layout.combined.matchAll(/<svg x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)].map((match) => match.slice(1).map(Number));
    expect(svgWidth(layout.combined)).toBe(650);
    expect(nested[0]![3]).toBe(nested[1]![3]);
    expect(nested[1]![0]! + nested[1]![2]!).toBe(650);
    expect(nested[2]![1]).toBe(nested[0]![3]! + 10);
    expect(svgHeight(layout.combined)).toBe(nested[2]![1]! + nested[2]![3]!);
    const narrow = renderStatsCard(many, { width: nested[0]![2] });
    const rank = narrow.match(/<g transform="translate\(([\d.]+) ([\d.]+)\)"><circle r="40"/)!;
    expect(Number(rank[1])).toBe(nested[0]![2]! / 2);
    expect(Number(rank[2]) - 43).toBeGreaterThan(125);
  });

  test.each(["light_github", "dark"])("source cards remain stable in the %s theme", (theme) => {
    expect(renderStatsCard(activity, { theme })).toMatchSnapshot();
    expect(renderHostSplitCard(activity, { theme })).toMatchSnapshot();
  });
});
