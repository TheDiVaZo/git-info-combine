import {
  CARD_NAMES,
  parseCards,
  parseGitLabSources,
  STAT_NAMES,
  type CardName,
  type CardOptions,
  type GitLabSourceConfig,
  type HeatmapCardOptions,
  type LanguagesCardOptions,
  type StatName,
  type StatsCardOptions,
  type ShowcaseCardOptions,
  type WakaTimeCardOptions,
  type WakaTimeRange,
  WAKATIME_RANGES,
} from "@git-info-combine/core";

export type GetInput = (name: string) => string;

export interface Config {
  githubToken?: string;
  gitlabToken?: string;
  gitlabUrl?: string;
  gitlabSources?: GitLabSourceConfig[];
  gitlabPrimarySource?: string;
  manualContributionsDir?: string;
  includeOrgRepos: boolean;
  excludeRepos: string[];
  gitlabMirrors: string[];
  detectWordPress: boolean;
  cards: CardName[];
  outputDir: string;
  commit: boolean;
  commitMessage: string;
  /** Give cards that sit in a row the same height. */
  equalHeights: boolean;
  /** Rows of card names to lay out into exact-width images; empty for no layout. */
  layout: string[][];
  layoutWidth: number;
  layoutGap: number;
  stats: StatsCardOptions;
  languages: LanguagesCardOptions;
  heatmap: HeatmapCardOptions;
  wakatime: WakaTimeCardOptions & { apiKey?: string; apiUrl?: string; range: WakaTimeRange };
  pins: string[];
  gists: string[];
  showcase: ShowcaseCardOptions;
}

/** Reads the Action's inputs. At least one automatic or manual source is required. */
export function readConfig(getInput: GetInput): Config {
  const text = (name: string) => getInput(name).trim() || undefined;
  const list = (name: string) =>
    (text(name) ?? "")
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  const bool = (name: string, fallback: boolean) => {
    const value = text(name)?.toLowerCase();
    if (value === undefined) return fallback;
    if (["true", "yes", "1"].includes(value)) return true;
    if (["false", "no", "0"].includes(value)) return false;
    throw new Error(`Input ${name} must be true or false, not "${value}".`);
  };
  const choice = <T extends string>(name: string, options: readonly T[]): T | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    if (!options.includes(value as T)) throw new Error(`Input ${name} must be one of ${options.join(", ")}, not "${value}".`);
    return value as T;
  };
  const number = (name: string) => {
    const value = text(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Input ${name} must be a positive number, not "${value}".`);
    return parsed;
  };

  const githubToken = text("github-token");
  const gitlabToken = text("gitlab-token");
  const gitlabSources = parseGitLabSources(text("gitlab-sources"));
  const manualContributionsDir = text("manual-contributions-dir");
  if (gitlabToken && gitlabSources !== undefined) throw new Error("Use either gitlab-token or gitlab-sources, not both.");
  if (!githubToken && !gitlabToken && !gitlabSources?.length && !manualContributionsDir) {
    throw new Error("Set at least one of github-token, gitlab-token, gitlab-sources or manual-contributions-dir.");
  }
  const cards = parseCards(getInput("cards"));
  const pins = list("pins");
  const gists = list("gists");
  const gitlabPrimarySource = text("gitlab-primary-source");
  primaryGitLabSource({ gitlabSources, gitlabPrimarySource, cards, pins, gists });

  const common: CardOptions = {
    theme: text("theme"),
    hideTitle: bool("hide-title", false),
    hideBorder: bool("hide-border", false),
    borderRadius: number("border-radius"),
    titleColor: text("title-color"),
    iconColor: text("icon-color"),
    textColor: text("text-color"),
    bgColor: text("bg-color"),
    borderColor: text("border-color"),
  };
  const hostColors = { github: text("github-color"), gitlab: text("gitlab-color") };

  const hiddenStats = list("stats-hide");
  for (const stat of hiddenStats) {
    if (!STAT_NAMES.includes(stat as StatName)) {
      throw new Error(`Input stats-hide has an unknown stat "${stat}". Use ${STAT_NAMES.join(", ")}.`);
    }
  }

  return {
    githubToken,
    gitlabToken,
    gitlabUrl: text("gitlab-url"),
    gitlabSources,
    gitlabPrimarySource,
    manualContributionsDir,
    includeOrgRepos: bool("include-org-repos", true),
    excludeRepos: list("exclude-repos"),
    gitlabMirrors: list("gitlab-mirrors"),
    detectWordPress: bool("detect-wordpress", true),
    cards,
    outputDir: text("output-dir") ?? "git-info-combine",
    commit: bool("commit", true),
    commitMessage: text("commit-message") ?? "chore: update git-info-combine cards",
    equalHeights: bool("equal-heights", true),
    layout: parseLayout(getInput("layout")),
    layoutWidth: number("layout-width") ?? 800,
    layoutGap: number("layout-gap") ?? 10,
    stats: {
      ...common,
      name: text("name"),
      hide: hiddenStats as StatName[],
      hideRank: bool("hide-rank", false),
      showHosts: bool("show-hosts", true),
      numberFormat: choice("number-format", ["short", "long"] as const),
      hostColors,
    },
    languages: {
      ...common,
      layout: choice("languages-layout", ["normal", "compact"] as const),
      count: number("languages-count"),
      hide: list("languages-hide"),
      weighting: choice("languages-weighting", ["repo", "size"] as const),
    },
    heatmap: {
      ...common,
      range: choice("heatmap-range", ["last-year", "all"] as const),
      mode: choice("heatmap-mode", ["hosts", "single"] as const),
      hostColors,
    },
    wakatime: {
      ...common,
      apiKey: text("wakatime-api-key"),
      apiUrl: text("wakatime-url"),
      range: choice("wakatime-range", WAKATIME_RANGES) ?? "last_7_days",
      layout: choice("wakatime-layout", ["normal", "compact"] as const),
      count: number("wakatime-count"),
      hide: list("wakatime-hide"),
    },
    pins,
    gists,
    showcase: { ...common, showHost: bool("show-hosts", true), hostColors },
  };
}

export { CARD_NAMES };

/** Selects the one GitLab used for public pins and snippets. */
export function primaryGitLabSource(
  config: Pick<Config, "gitlabSources" | "gitlabPrimarySource" | "cards" | "pins" | "gists">,
): GitLabSourceConfig | undefined {
  const sources = config.gitlabSources ?? [];
  if (config.gitlabPrimarySource) {
    const source = sources.find(({ id }) => id === config.gitlabPrimarySource);
    if (!source) throw new Error("Input gitlab-primary-source must match an id in gitlab-sources.");
    return source;
  }
  if (sources.length === 1) return sources[0];
  const hasGitLabShowcase = (["pins", "gists"] as const).some(
    (card) => config.cards.includes(card) && config[card].some((ref) => /^gitlab:/i.test(ref.trim())),
  );
  if (sources.length > 1 && hasGitLabShowcase) {
    throw new Error("Set gitlab-primary-source to show GitLab pins or gists with multiple GitLab sources.");
  }
  return undefined;
}

/**
 * Parses the `layout` input: one row per line, card names separated by spaces
 * or commas. `pins` and `gists` stand for all of them, two to a row.
 */
export function parseLayout(input: string): string[][] {
  const rows = input
    .split("\n")
    .map((line) => line.split(/[\s,]+/).map((name) => name.trim().toLowerCase()).filter(Boolean))
    .filter((row) => row.length > 0);
  for (const name of rows.flat()) {
    if (!(CARD_NAMES as readonly string[]).includes(name)) {
      throw new Error(`Input layout has an unknown card "${name}". Use ${CARD_NAMES.join(", ")}.`);
    }
  }
  return rows;
}
