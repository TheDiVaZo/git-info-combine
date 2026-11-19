# Git-info-combine

A GitHub Action that combines your **GitHub and GitLab** activity into cards for your profile README, including multiple self-hosted GitLab servers. Private work is counted; private repo and project names are never shown.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/KINGH242/KINGH242/main/git-info-combine/heatmap-dark.svg">
  <img alt="Example heatmap combining GitHub and GitLab contributions" src="https://raw.githubusercontent.com/KINGH242/KINGH242/main/git-info-combine/heatmap-light.svg">
</picture>

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/KINGH242/KINGH242/main/git-info-combine/stats-dark.svg">
    <img alt="Example stats card" src="https://raw.githubusercontent.com/KINGH242/KINGH242/main/git-info-combine/stats-light.svg">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/KINGH242/KINGH242/main/git-info-combine/languages-dark.svg">
    <img alt="Example languages card" src="https://raw.githubusercontent.com/KINGH242/KINGH242/main/git-info-combine/languages-light.svg">
  </picture>
</p>

*Live example: [github.com/KINGH242](https://github.com/KINGH242).*

## Why

If most of your work happens on GitLab, in private repos or in company groups, your GitHub contribution graph shows only a small part of it. Git-info-combine reads both hosts with your own tokens, inside your own workflow, and draws one honest picture.

## Cards

| Card | Shows |
|---|---|
| `heatmap` | Contribution calendar across sources, each day split by source colour |
| `stats` | Stars, commits, PRs/MRs, issues, reviews and repos contributed to, added up, with a rank |
| `languages` | Top languages across both hosts |
| `hosts` | How your activity splits between GitHub and each GitLab server: contributions, commits, PRs/MRs and issues |
| `wakatime` | Coding time by language from WakaTime (or Wakapi) |
| `pins` | One card per public repo or project you list in `pins` |
| `gists` | One card per public gist or snippet you list in `gists` |

Every card is on by default; `wakatime`, `pins` and `gists` are skipped until you set `wakatime-api-key`, `pins` or `gists`. Choose cards with the `cards` input, for example `cards: heatmap,stats,languages`.

Cards that usually sit side by side get the same height (`equal-heights`, on by default): stats, languages, hosts and wakatime match each other, and so do pins and gists.

### Layout: rows that line up

Images side by side in a README never quite line up: rows end at different widths, and GitHub spaces them unevenly. The `layout` input has the Action lay the cards out itself:

```yaml
          layout: |
            heatmap
            stats languages
            wakatime hosts
            pins
```

Every row comes out exactly `layout-width` wide (default 800), cards in a row share one height and keep their proportions, and the gap across and down is the same (`layout-gap`, default 10). It writes `layout.svg` with every row, plus `row-1.svg`, `row-2.svg` and so on, each with `-light` and `-dark` versions. `pins` and `gists` mean all of them, two to a row. Use one image for the whole set:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="git-info-combine/layout-dark.svg">
  <img alt="My activity across GitHub and GitLab" src="git-info-combine/layout-light.svg">
</picture>
```

## Usage

1. **Create the tokens.**
   - **GitHub:** a classic personal access token with `repo`, `read:org` and `read:user`, so private and organisation activity can be read. The default `GITHUB_TOKEN` cannot read your activity in other repos.
   - **GitLab:** a personal access token with `read_api`.
2. **Add them as secrets** in your profile repo (the repo named after your username), for example `GIC_GITHUB_TOKEN` and `GIC_GITLAB_TOKEN`.
3. **Add the workflow:**

```yaml
# .github/workflows/git-info-combine.yml in your profile repo
name: Git-info-combine
on:
  schedule:
    - cron: "0 3 * * 1" # Mondays, 03:00 UTC
  workflow_dispatch:

permissions:
  contents: write

jobs:
  cards:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Kingpin-Apps/git-info-combine@v1
        with:
          github-token: ${{ secrets.GIC_GITHUB_TOKEN }}
          gitlab-token: ${{ secrets.GIC_GITLAB_TOKEN }}
          # gitlab-url: https://gitlab.example.com  # self-hosted GitLab
          # pins: |
          #   your-name/your-repo
          #   gitlab:your-group/your-project
```

4. **Run it once** from the Actions tab (*Run workflow*). It commits the cards to `git-info-combine/` in your repo.
5. **Show the cards in your README.** With the default `auto` theme, a `<picture>` follows GitHub's own light or dark setting:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="git-info-combine/heatmap-dark.svg">
  <img alt="Contributions on GitHub and GitLab" src="git-info-combine/heatmap-light.svg">
</picture>
```

Each card has three files: `<card>.svg` (follows the viewer's system setting), `<card>-light.svg` and `<card>-dark.svg`. Pin and gist files are named after what they show: `pins: Kingpin-Apps/git-info-combine` writes `pin-github-kingpin-apps-git-info-combine.svg`.

The first run reads your whole history and can take a few minutes. Later runs use the cache and only fetch what changed.

### Multiple GitLab servers

Use `gitlab-sources` instead of `gitlab-token` to collect from several servers. It is a JSON array; each server gets its own token, public label and colour. For example, replace the `with` block above with:

```yaml
        with:
          github-token: ${{ secrets.GIC_GITHUB_TOKEN }}
          gitlab-sources: |
            [
              {
                "id": "work",
                "url": ${{ toJSON(secrets.WORK_GITLAB_URL) }},
                "token": ${{ toJSON(secrets.WORK_GITLAB_TOKEN) }},
                "label": "Work",
                "color": "#fc6d26"
              },
              {
                "id": "personal",
                "url": ${{ toJSON(secrets.PERSONAL_GITLAB_URL) }},
                "token": ${{ toJSON(secrets.PERSONAL_GITLAB_TOKEN) }},
                "label": "Personal",
                "color": "#6e49cb"
              }
            ]
          # Needed only for GitLab pins or snippets with multiple servers:
          # gitlab-primary-source: personal
          # pins: gitlab:your-group/your-public-project
```

Set the URL secrets to the servers' base URLs, such as `https://gitlab.example.com`. `toJSON` supplies the JSON quotes and escaping; do not add another pair of quotes around these expressions. GitHub is optional if at least one GitLab source is configured.

- `id` is a unique settings alias; `label` is the public text shown on the cards. Use neutral labels such as `Work` if a server's address is private. Labels never default to hostnames.
- `color` is a hex colour for that source's activity and takes precedence over `gitlab-color`. GitHub appears first, followed by the GitLab servers in configuration order.
- Each URL may appear once, with one account. The existing `gitlab-token`/`gitlab-url` configuration still works, but cannot be combined with `gitlab-sources`.
- An optional `mirrors` array in a source lists its projects that mirror GitHub repositories. It supplements the global `gitlab-mirrors` list, which applies to every server. Mirrors between two GitLab servers are counted independently.
- `gitlab:group/project` pins and `gitlab:123` snippets use the source selected by `gitlab-primary-source`. A single source is selected automatically; multiple sources need an explicit selection only when GitLab pins or snippets are enabled. GitHub pins and gists are unaffected.

Stats and languages combine all configured sources. Heatmap segments and the hosts card distinguish each server using its label and colour. Project selection and counting rules remain the same on every server.

Each server has an independent cache. Existing single-server caches are migrated without dropping their saved history. Changing a token, label, colour or source order keeps that history; changing the account starts a fresh cache for that server. Temporarily removed sources keep their cached history but contribute nothing until configured again. If any source fails, the run fails before updating cards or the cache, leaving the previous output in place.

## How things are counted

- **Contributions** (the heatmap) are GitHub's own contribution calendar plus GitLab's events, counted the way GitLab's calendar counts them.
- **Commits** are your commits on each repo's default branch: GitHub's commit contributions, and on GitLab, each project's contributor list matched to all of your GitLab emails and your name. GitLab projects are discovered through membership with Developer access or higher.
- **Languages** count every repo once, split by its languages (`languages-weighting: repo`). GitLab reports only percentages, not bytes, so this keeps both hosts in the same unit. `languages-weighting: size` weighs by size instead, so big repos dominate.
- **WordPress sites** that bundle WordPress core (at the root, or in `wordpress/`, `public/`, `public_html/` or Bedrock's `web/wp/`) count as one PHP repo: WordPress's own code is not counted as yours. Turn this off with `detect-wordpress: false`.
- **Mirrors.** A GitLab project whose latest commit matches one of your GitHub repos is a mirror, and is counted once. Name others with `gitlab-mirrors`.
- **Languages and stars** come from repos you own or are an organisation member of on GitHub (`include-org-repos`), and from projects where you have Maintainer access or higher on GitLab. Forks are skipped.
- The **rank** uses [GitHub Stats Extended](https://github.com/stats-organization/github-stats-extended)'s formula on the combined numbers.

## Privacy

- Private repos, projects and their activity are **counted**, but their **names are never written** to the cards, the cache or the logs. A check refuses to write output that contains one.
- Tokens stay in your repo's secrets and are only used inside the Action run.
- The cache (`cache.json`) holds counts, aggregate project statistics, account identifiers and opaque project ids. Each GitLab server's address is stored only as a hash; tokens and source labels are not cached.
- Pins and gists must be public; private repos, internal projects and secret gists are refused.
- WakaTime's project names are dropped; only languages and time are used.
- Source labels are public. Put private server URLs in secrets, as in the example above. `exclude-repos`, `gitlab-mirrors` and per-source `mirrors` are the exceptions you control: naming a private repo in a public workflow reveals its name.

## Inputs

Configure at least one GitHub or GitLab source. All other inputs are optional. See [`action.yml`](action.yml) for the full descriptions.

| Area | Inputs |
|---|---|
| Sources | `github-token`, `gitlab-token`, `gitlab-url`, `gitlab-sources`, `gitlab-primary-source`, `include-org-repos`, `exclude-repos`, `gitlab-mirrors`, `detect-wordpress`, `wakatime-api-key`, `wakatime-url`, `pins`, `gists` |
| Output | `cards`, `output-dir`, `commit`, `commit-message`, `equal-heights`, `layout`, `layout-width`, `layout-gap` |
| Look | `theme` (`auto` or any [GitHub Stats Extended theme](https://github.com/stats-organization/github-stats-extended/blob/master/apps/frontend/src/content/docs/docs/customization/themes.md)), `hide-title`, `hide-border`, `border-radius`, `title-color`, `icon-color`, `text-color`, `bg-color`, `border-color`, `github-color`, `gitlab-color` |
| Stats | `name`, `stats-hide`, `hide-rank`, `show-hosts`, `number-format` |
| Languages | `languages-layout`, `languages-count`, `languages-hide`, `languages-weighting` |
| Heatmap | `heatmap-range` (`last-year` or `all`), `heatmap-mode` (`hosts` or `single`) |
| WakaTime | `wakatime-range`, `wakatime-layout`, `wakatime-count`, `wakatime-hide` |

## Good to know

- **Tokens expire.** When your GitHub or GitLab token expires, runs fail. Set a reminder to renew it.
- **Scheduled workflows pause** after 60 days without activity in a repo. The cards change every run, so their commits normally keep the schedule alive.

## Development

Requires [Bun](https://bun.sh); the version is pinned in `.bun-version`.

```sh
bun install
bun test
bun run typecheck
bun run build    # bundles the Action to dist/index.js (commit the result)

# Try it on real data. Tokens come from the environment.
GIC_GITHUB_TOKEN=... GIC_GITLAB_TOKEN=... bun run fetch
bun run render radical   # writes .out/cards/, with an index.html preview
```

For a local multi-server run, set `GIC_GITLAB_SOURCES` to the same JSON array as `gitlab-sources` (with actual environment-provided credentials, not GitHub workflow expressions), then run `bun run fetch`. Leave `GIC_GITLAB_TOKEN` unset. The script writes combined activity and per-server cache data to `.out/`; `bun run render` shows each source separately.

## Credits

Themes, the rank formula and card designs come from [GitHub Stats Extended](https://github.com/stats-organization/github-stats-extended) (MIT). Icons are [Primer Octicons](https://github.com/primer/octicons) (MIT). Language colours are from [GitHub Linguist](https://github.com/github-linguist/linguist) (MIT).

## License

[MIT](LICENSE) © Kingpin Apps
