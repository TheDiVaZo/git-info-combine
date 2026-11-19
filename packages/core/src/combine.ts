import { emptyTotals, type CombinedActivity, type DateKey, type HostActivity, type LanguageStat, type Totals } from "./model.ts";

/** Adds up activity across hosts. Each host's own numbers are kept for per-host colours. */
export function combine(hosts: HostActivity[], now = new Date()): CombinedActivity {
  const days: Record<DateKey, number> = {};
  const totals = emptyTotals();
  const languages: Record<string, LanguageStat> = {};

  for (const host of hosts) {
    for (const [date, count] of Object.entries(host.days)) days[date] = addCount(days[date] ?? 0, count);
    for (const key of Object.keys(totals) as (keyof Totals)[]) totals[key] = addCount(totals[key], host.totals[key]);
    for (const [name, stat] of Object.entries(host.languages)) {
      const combined = (languages[name] ??= { size: 0, weight: 0, repos: 0, color: null });
      combined.size += stat.size;
      combined.weight += stat.weight;
      combined.repos += stat.repos;
      combined.color ??= stat.color;
    }
  }

  return { generatedAt: now.toISOString(), hosts, days: sortKeys(days), totals, languages };
}

function addCount(current: number, count: number): number {
  const total = current + count;
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total)) {
    throw new Error("Activity counts must stay within the non-negative safe integer range.");
  }
  return total;
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}
