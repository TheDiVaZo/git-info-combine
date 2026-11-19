# Local Git exports and manual sources

The local exporter reads existing Git repositories and publishes nothing. GitHub Actions reads only the aggregate JSON you choose to commit. It never opens or contacts the original repositories. Obtain permission before publishing corporate statistics: even source names and daily aggregate counts may reveal information.

## Local configuration

Keep `.contributions.local.json` outside version control. The provided ignore rule covers this filename. Paths and author addresses belong only in this local file; the paths below are placeholders, not real repository locations.

```json
{
  "source-name": "EXBO",
  "source-id": "exbo",
  "repo-folders": [
    "<local-assets-repository>",
    "<local-code-repository>",
    "<local-extra-assets-repository>"
  ],
  "timezone": "Europe/Moscow",
  "color": "#a855f7"
}
```

All repositories with the same effective `source-name` belong to one source. To split them, use object entries:

```json
{
  "source-name": "EXBO",
  "repo-folders": [
    { "path": "<local-assets-repository>", "source-name": "EXBO / Assets", "source-id": "exbo-assets", "color": "#a855f7" },
    { "path": "<local-code-repository>", "source-name": "EXBO / Code", "source-id": "exbo-code", "color": "#2f80ed" },
    { "path": "<local-extra-assets-repository>", "source-name": "EXBO / EAssets", "source-id": "exbo-eassets", "color": "#d29922" }
  ],
  "timezone": "Europe/Moscow"
}
```

Strings and objects can be mixed. An object without `source-name` inherits the top-level name. Names are trimmed, then grouped case-sensitively. Optional `author-emails` and `color` can be set globally or overridden for a repository. Conflicting IDs or effective colors within one group fail validation.

The top-level `source-id` applies only to the top-level named source. Other groups derive an ID from their name, such as `EXBO / Assets` → `exbo-assets`; names without usable slug characters receive a stable name hash. Explicit IDs are recommended when a display name may change. IDs must be unique, lowercase, safe filenames, and cannot use Windows-reserved device names. A renamed source with the same explicit ID updates the same file. A source's default color is deterministic from its ID.

## Export command

Install the fork's dependencies once, then run offline with Git and Bun available:

```sh
bun run export:local --config .contributions.local.json --output-dir ../profile/contributions/manual
```

The CLI also accepts `--json-summary` for automation. Its report contains only source names/IDs, repository counts, deduplicated commit counts, first/last dates, output basenames and whether the files changed. It never prints author emails, hashes, internal paths, remotes or Git stderr.

Output follows this schema; the numbers are synthetic examples:

```json
{
  "schemaVersion": 1,
  "source": {
    "id": "exbo",
    "name": "EXBO",
    "type": "manual",
    "metric": "commits",
    "color": "#a855f7"
  },
  "timezone": "Europe/Moscow",
  "days": {
    "2026-11-16": 8,
    "2026-11-17": 12
  }
}
```

`source.color` is optional for imported JSON. Unknown schema fields, invalid calendar dates or time zones, unsupported versions/metrics, duplicate source IDs and unsafe or negative counts are rejected. Empty `days` is valid. Unknown metadata is not copied into cards or caches.

## What is counted

- Read local branches, remote-tracking refs and HEAD, including a detached HEAD. Stashes, reflogs and commits reachable only through tags are excluded.
- Use an exact, case-sensitive author-email match. The lookup order is repository `author-emails`, global `author-emails`, then that repository's configured `user.email`. Explicitly list historical addresses if needed. Mailmap rewriting is disabled.
- Use the **committer** timestamp, converted into the required IANA `timezone`. Author date is not used.
- Count merge commits when their author matches. Count a SHA once per source, across both branches and mirrored repositories. Different sources remain independent.
- Never fetch or change source repositories. Lazy fetching missing objects is disabled too. Missing, shallow or corrupt repositories fail; an empty valid repository gives an empty calendar.

This is a local-history metric. Unpushed commits, merges and branch coverage may differ from GitHub/GitLab's contribution calendars. API day aggregates retain their existing date boundaries; they cannot be accurately rebucketed after collection. Do not configure the same work as both a manual and automatic source: SHA deduplication happens before export within one manual source, and cannot be done later from aggregate counts.

## Updating files safely

Every run recomputes the full history; it does not add new counts onto old JSON. Files use sorted dates and stable formatting, without an export timestamp. Unchanged content is not rewritten.

All repositories and all intended documents are checked before writing. A missing or unreadable repository leaves every previous output unchanged. Changed files are prepared in temporary files and replaced atomically one file at a time; disk errors fail the command, and an integrating script must not commit after failure. This is not a multi-file filesystem transaction.

Existing targets must be valid manual documents with the matching source ID. Other JSON files are neither overwritten nor removed. If you change source IDs or split an aggregate, explicitly review and remove the obsolete JSON; the Action reads every JSON file and otherwise would count old and new sources together.

## Action integration

```yaml
with:
  github-token: ${{ secrets.GIC_GITHUB_TOKEN }}
  gitlab-sources: ${{ secrets.GIC_GITLAB_SOURCES }} # optional, existing multi-GitLab format
  manual-contributions-dir: contributions/manual
  cards: heatmap
  theme: auto
  heatmap-mode: single
  icon-color: 40c463
```

The directory must be relative to, and stay inside, the checked-out workspace. Only its immediate JSON files are read. An absent or unset directory adds no sources; existing unreadable directories and invalid files fail before outputs are written. Manual-only use needs no token; a run with no actual sources is an error.

Each document is converted into the existing activity model. Local commit counts contribute to both the heatmap's activity units and the commit total. No local stars, reviews, repository counts or languages are invented. Manual documents are re-read each run, independently of the existing GitHub/GitLab caches.

The summed heatmap can remain GitHub green while displaying source names in the legend; the `hosts` mode uses separate source colors. Cell titles include dates, totals and source-specific units, including zero counts. Per-cell tooltips are available when opening the SVG directly, but are not guaranteed when GitHub displays it as an image. Descriptions explain the different definitions and time zones.

## PowerShell profile wrapper

A profile can call the CLI from `update-contributions.ps1`, using a sibling fork checkout and ignored profile-local config. The associated profile implementation supports Windows PowerShell 5.1:

```powershell
.\update-contributions.ps1
.\update-contributions.ps1 -Commit
```

Default behavior exports only. `-Commit` commits only the generated JSON paths when they differ from HEAD, preserves unrelated staged files and refuses pre-staged changes or conflicts in the manual directory. It never pushes; publication is a separate user action. A daily profile workflow can regenerate SVG after the reviewed JSON has been pushed, using its normal workflow credentials.
