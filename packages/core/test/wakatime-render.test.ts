import { describe, expect, test } from "bun:test";
import { renderWakaTimeCard } from "../src/render/wakatime.ts";
import type { WakaTimeStats } from "../src/wakatime.ts";

describe("WakaTime readiness in rendered cards", () => {
  for (const layout of ["normal", "compact"] as const) {
    for (const theme of ["light_github", "dark_github"]) {
      test(`${layout} ${theme} shows the requested period without pending totals or languages`, () => {
        for (const total of ["0 secs", "987 hrs of stale activity"]) {
          const stats: WakaTimeStats = {
            range: "last_30_days",
            ready: false,
            total,
            languages: [{ name: "StaleLanguage", percent: 75, text: "654 hrs of stale language activity" }],
          };
          const svg = renderWakaTimeCard(stats, { layout, theme });

          expect(svg).toContain("Stats for the last 30 days");
          expect(svg).toContain("WakaTime is still calculating these stats.");
          expect(svg).not.toContain(total);
          expect(svg).not.toContain("StaleLanguage");
          expect(svg).not.toContain("654 hrs");
          expect(svg).not.toContain("No coding activity yet.");
          expect(svg).not.toContain("waka-bar");
          expect(svg.match(/<desc\b[^>]*>(.*?)<\/desc>/s)?.[1])
            .toBe("Stats for the last 30 days. WakaTime is still calculating these stats.");
        }
      });

      test(`${layout} ${theme} preserves a genuine ready zero`, () => {
        const svg = renderWakaTimeCard({ range: "last_30_days", ready: true, total: "0 secs", languages: [] }, { layout, theme });

        expect(svg).toContain("0 secs in the last 30 days");
        expect(svg).toContain("No coding activity yet.");
        expect(svg).not.toContain("still calculating");
      });

      test(`${layout} ${theme} retains ready language values`, () => {
        const svg = renderWakaTimeCard({
          range: "last_30_days",
          ready: true,
          total: "12 hrs",
          languages: [{ name: "TypeScript", percent: 100, text: "12 hrs" }],
        }, { layout, theme });

        expect(svg).toContain("12 hrs in the last 30 days");
        expect(svg).toContain("TypeScript");
        expect(svg).not.toContain("still calculating");
      });
    }
  }

  test("describes the all-time pending period without suggesting a total", () => {
    const svg = renderWakaTimeCard({ range: "all_time", ready: false, total: "0 secs", languages: [] });

    expect(svg).toContain("Stats for all time");
    expect(svg).not.toContain("for the all time");
    expect(svg).not.toContain("0 secs");
  });
});
