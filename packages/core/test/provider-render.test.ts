import { describe, expect, test } from "bun:test";
import { combine } from "../src/combine.ts";
import { emptyTotals, type HostActivity, type SourceCapabilities } from "../src/model.ts";
import { resolveSources } from "../src/render/hosts.ts";
import {
  escapeXml, renderHeatmapCard, renderHostSplitCard, renderLanguagesCard,
  renderLayout, renderStatsCard, svgHeight, svgWidth, topLanguages,
} from "../src/render/index.ts";

const now = new Date("2026-11-20T12:00:00Z");
const calendarCapabilities: SourceCapabilities = { totals: ["contributions"], languages: false, repos: false };
const provider = (host = "forgejo", label = "Forgejo", color = "#fb923c"): HostActivity => ({
  host, login: "", source: { id: `${host}:instance`, label, color, metric: "contributions", origin: "api", timezone: "UTC", capabilities: calendarCapabilities },
  days: { "2026-11-18": 4 }, totals: { ...emptyTotals(), contributions: 4 }, languages: {}, repos: { public: 0, private: 0 },
});
const github: HostActivity = {
  host: "github", login: "octo", days: { "2026-11-18": 2 },
  totals: { ...emptyTotals(), contributions: 2, commits: 2, stars: 7, issues: 1 },
  languages: { TypeScript: { size: 100, weight: 1, repos: 1, color: "#3178c6" } }, repos: { public: 1, private: 0 },
};
const manual: HostActivity = {
  host: "manual", login: "", source: { id: "manual:work", label: "Local Work", color: "#a855f7", metric: "commits", timezone: "Europe/Moscow" },
  days: { "2026-11-18": 3 }, totals: { ...emptyTotals(), contributions: 3, commits: 3 }, languages: {}, repos: { public: 0, private: 0 },
};

describe("provider-neutral presentation", () => {
  test("a calendar-only source has a labeled green heatmap and UTC breakdown without manual activity", () => {
    const svg = renderHeatmapCard(combine([provider()], now), { mode: "single", iconColor: "40c463" });
    expect(svg).toContain("--icon:#40c463");
    expect(svg).toContain("<title>Forgejo</title>");
    expect(svg).toContain("4 contributions in the last year");
    expect(svg).toContain("2026-11-18: 4 contributions. Forgejo: 4 API contributions (UTC).");
    expect(svg).toContain("2026-11-20: 0 contributions. Forgejo: 0 API contributions (UTC).");
    expect([...svg.matchAll(/<title>\d{4}-\d{2}-\d{2}:/g)]).toHaveLength(365);
  });

  test("a third provider uses exactly the same rendering behavior through its metadata", () => {
    const activity = combine([provider("future-service", "Future Service", "#abcdef")], now);
    for (const render of [renderHeatmapCard, renderHostSplitCard, renderStatsCard, renderLanguagesCard]) {
      const svg = render(activity);
      expect(svg).toContain("Future Service");
      expect(svg).not.toContain("Forgejo");
      expect(svg).not.toContain("GitHub");
      expect(svg).not.toMatch(/NaN|Infinity|undefined/);
    }
    expect(renderHeatmapCard(activity, { mode: "single" })).toContain("<title>Future Service</title>");
  });

  test("unknown providers require complete descriptors instead of inheriting another host's presentation", () => {
    const base = provider("future-service");
    for (const source of [undefined, { ...base.source!, origin: undefined }, { ...base.source!, capabilities: undefined }, { ...base.source!, metric: undefined }]) {
      const activity = combine([{ ...base, source }], now);
      for (const render of [renderHeatmapCard, renderHostSplitCard, renderStatsCard, renderLanguagesCard]) {
        expect(() => render(activity)).toThrow("requires complete source metadata");
      }
    }
    expect(() => resolveSources([{ ...base, source: { ...base.source!, label: "" } }])).toThrow("Invalid source presentation metadata");
  });

  test("unsupported statistics are missing rather than zeros, and a calendar alone has no rank", () => {
    const activity = combine([provider()], now);
    const stats = renderStatsCard(activity);
    expect(stats).toContain("Total Commits: not reported");
    expect(stats).not.toContain("Total Commits: 0");
    expect(stats).toContain("— = not reported");
    expect(stats).not.toContain("stroke-dashoffset");
    expect(stats).not.toContain(", rank ");
    const hosts = renderHostSplitCard(activity);
    expect(hosts).toContain("Forgejo: —");
    expect(hosts).toContain("Commits: Forgejo not reported");
    expect(hosts).toContain("Forgejo 100% of contributions");
    const languages = renderLanguagesCard(activity);
    expect(languages).toContain("Languages not reported.");
    expect(languages).not.toContain("No languages found.");
  });

  test("mixed metrics use only reporting sources and distinguish commits from calendar activity", () => {
    const gitlab = { ...github, host: "gitlab", source: { id: "gitlab:work", label: "GitLab Work", color: "#fc6d26" } };
    const activity = combine([github, gitlab, provider(), provider("future-service", "Future"), manual], now);
    const heatmap = renderHeatmapCard(activity, { mode: "single" });
    expect(heatmap).toContain("15 activity units in the last year");
    expect(heatmap).toContain("Forgejo: 4 API contributions (UTC)");
    expect(heatmap).toContain("Local Work: 3 local commits (Europe/Moscow)");
    const stats = renderStatsCard(activity);
    expect(stats).toContain("Total Commits: 7");
    expect(stats).toContain("Total Stars Earned: 14");
    expect(stats).toContain("Totals and rank include reporting sources only");
    expect(stats).toContain("stroke-dashoffset");
    expect(renderHostSplitCard(activity)).toContain("Forgejo: —");
    const languages = renderLanguagesCard(activity);
    expect(languages).toContain("TypeScript");
    expect(languages).toContain("Languages include reporting sources only");
  });

  test("capabilities prevent even nonzero unsupported values from entering rendered totals", () => {
    const unexpected = {
      ...provider(), totals: { ...emptyTotals(), contributions: 4, commits: 900, stars: 700 },
      languages: { SecretLanguage: { size: 900, weight: 9, repos: 9, color: null } },
    };
    const activity = combine([github, unexpected], now);
    expect(renderStatsCard(activity)).toContain("Total Commits: 2");
    expect(renderStatsCard(activity)).toContain("Total Stars Earned: 7");
    expect(renderHostSplitCard(activity)).not.toContain("Forgejo 900");
    expect(topLanguages(activity, 5)).toEqual([{ name: "TypeScript", color: "#3178c6", percent: 100 }]);
  });

  test("metric and origin behavior also works for a future local provider", () => {
    const local = provider("future-local", "Local Adapter");
    local.source = { ...local.source!, origin: "local", metric: "commits", capabilities: { totals: ["contributions", "commits"], languages: false, repos: false } };
    local.totals.commits = 4;
    const svg = renderHeatmapCard(combine([local], now), { mode: "single" });
    expect(svg).toContain("4 activity units in the last year");
    expect(svg).toContain("Local Adapter: 4 local commits (UTC)");
    local.source.origin = "api";
    const api = renderHeatmapCard(combine([local], now), { mode: "single" });
    expect(api).toContain("4 activity units in the last year");
    expect(api).toContain("Local Adapter: 4 API commits (UTC)");
    local.source.origin = "local";
    local.source.metric = "contributions";
    local.source.capabilities = calendarCapabilities;
    const localCalendar = renderHeatmapCard(combine([local], now));
    expect(localCalendar).toContain("Local Adapter: 4 local contributions (UTC)");
    expect(localCalendar).not.toContain("Local sources report commits only");
  });

  test("untrusted labels stay escaped in every new descriptor and partial-data note", () => {
    const label = '<script>&"\' Service';
    const activity = combine([github, provider("future-service", label)], now);
    for (const render of [renderHeatmapCard, renderHostSplitCard, renderStatsCard, renderLanguagesCard]) {
      const svg = render(activity);
      expect(svg).toContain(escapeXml(label));
      expect(svg).not.toContain("<script>");
    }
  });

  test("many provider shares fit their cell and wrapped captions fit combined card rows", () => {
    const activity = combine(Array.from({ length: 24 }, (_, index) => provider(`future-${index}`, `Future Service ${index}`)), now);
    const heatmap = renderHeatmapCard(activity);
    const cell = heatmap.match(/<g fill-opacity="[\d.]+"><title>2026-11-18:[^<]*<\/title>(.*?)<\/g>/)![1]!;
    const heights = [...cell.matchAll(/height="([\d.]+)"/g)].map((match) => Number(match[1]));
    expect(heights).toHaveLength(24);
    expect(heights.reduce((a, b) => a + b, 0)).toBeCloseTo(10);
    const layout = renderLayout([
      [(extra) => renderStatsCard(activity, extra), (extra) => renderHostSplitCard(activity, extra)],
      [(extra) => renderLanguagesCard(activity, extra)],
    ], { width: 650 });
    const cards = [...layout.combined.matchAll(/<svg x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)].map((match) => match.slice(1).map(Number));
    expect(svgWidth(layout.combined)).toBe(650);
    expect(cards[0]![3]).toBe(cards[1]![3]);
    expect(cards[2]![1]).toBe(cards[0]![3]! + 10);
    expect(svgHeight(heatmap)).toBeGreaterThan(svgHeight(renderHeatmapCard(combine([provider()], now))));
  });
});
