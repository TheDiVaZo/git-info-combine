# Server providers

The shared `sources` Action input and `GIC_SOURCES` local environment variable use the same array. GitLab and Forgejo are adapters in one registry. GitHub retains `github-token`; manual snapshots retain `manual-contributions-dir`. A deployment does not download or execute provider code from configuration.

## Configuration and compatibility

Each source has `id`, `url`, `token`, `label` and `color`, with optional `provider` and `options`. Labels and colors are public presentation settings; do not use a private hostname as a label. URLs are installation bases and may include a legitimate installation subpath. Do not append an API version, group or repository path.

Omitting `provider` enables discovery every run. An explicit registered provider bypasses discovery and never switches implementation on an API error. Common fields are validated centrally; provider options are checked by the selected adapter. GitLab accepts `options.mirrors`, an array of project paths already counted on GitHub; Forgejo currently accepts no provider options.

IDs must be unique. After discovery, repeated provider/server pairs are rejected, even when one entry used an explicit provider and another used detection. One account is supported per provider/server pair.

Legacy `gitlab-sources` and `gitlab-token`/`gitlab-url` normalize into explicitly selected GitLab sources. Their API implementation, account matching, mirror detection and counting rules remain intact. Their `mirrors` settings map into the GitLab adapter. Do not combine `sources` with legacy GitLab credentials. `github-token` and manual snapshots can accompany either configuration.

GitLab pins and snippets still use `gitlab-primary-source`. With the shared list, only detected GitLab entries participate in that selection; a Forgejo source cannot supply its token to a GitLab showcase request. Forgejo pins/snippets are not provided by the calendar adapter.

## Discovery and API access

The registry asks each adapter for positive API evidence:

| Adapter | Probe | Positive evidence |
| --- | --- | --- |
| GitLab | `GET <base>/api/v4/version`, using the configured source token | HTTP 200 and JSON with nonempty `version` and `revision` |
| Forgejo | `GET <base>/api/forgejo/v1/version`, without credentials | HTTP 200 and JSON with a nonempty `version` |

Exactly one match is required. No matches or several matches cause a safe error suggesting an explicit provider. HTTP 401/403/404, HTML, hostnames and token prefixes do not identify a provider. Ordinary Gitea's generic version endpoint is not evidence of Forgejo support.

Requests remain on the configured origin and installation path; redirects are rejected and network waits are bounded. The existing shared HTTP retry policy handles rate limits and transient server errors. Tokens never enter a query string. Errors identify the source and HTTP status without printing a token, server URL, response body or private repository name.

Use a GitLab personal token with `read_api` and `read_user`, or a Forgejo personal token with `read:user`. Forgejo requests the token owner's account followed by that account's native heatmap. Visibility remains subject to the server and token permissions. Server settings can disable the heatmap, and an HTML login/anti-bot page is not a usable API response. Do not replace such failures with zero activity.

References: [GitLab metadata](https://docs.gitlab.com/api/metadata/), [GitLab events permissions](https://docs.gitlab.com/api/events/), [Forgejo versions](https://forgejo.org/docs/latest/user/api/versions/), [Forgejo token scopes](https://forgejo.org/docs/latest/user/authentication/token-scope/).

## Calendar semantics and cache

Forgejo counts activity events, not exact authored commits. Its heatmap contains short UTC timestamp buckets covering 371 rolling days; multiple buckets are summed into each UTC date. Counts, timestamps, bucket uniqueness and aggregate integer bounds are validated. A separate repository-history traversal is not part of this adapter.

The successful response's HTTP Date supplies the window date when valid; collection time is the fallback. The complete window starts at that UTC date minus 370 days. Keep existing cached days strictly before it and replace the complete recent interval, including days no longer present. An empty array clears the recent interval. On first fetch, omit the incomplete oldest boundary day. The current day remains provisional and is refreshed on the next run.

Cache v3 has a common `sources` map. Each key combines the provider ID with a stable opaque server identity; each envelope contains `provider`, adapter cache `version`, and provider-specific aggregate `data`. The account identity is checked inside the adapter. Switching accounts discards that source's previous account history. Changing an alias, label, color or token does not change the server identity.

The v1/v2 migration preserves all saved GitLab instances, including disabled ones, without changing their original instance hashes. The GitHub cache retains its existing structure. Disabling a source retains its historical bucket but excludes it from totals. Unknown disabled provider buckets are retained for future use. A different provider cannot reuse another provider's history. Malformed envelopes in a recognized cache schema fail the run before output is replaced.

Older Forgejo dates in the cache are archived successful snapshots; the server can no longer verify them after its window expires. Removing the cache loses that archive. Aggregated calendars cannot deduplicate the same work across Forgejo, other API sources and manual JSON; configure non-overlapping activity where possible.

## Adding an adapter

The contract lives in `packages/core/src/provider.ts`; built-in adapters are registered in `packages/core/src/providers.ts`.

1. Implement the API client using the shared HTTP utilities. Return the common activity model, a validated cache payload and the sensitive-name tracker. Keep raw events, URLs, tokens, email addresses and repository names out of returned public data.
2. Implement `SourceProvider`: stable ID/name, cache version, `normalizeOptions`, `instanceId`, `detect`, `collect`, metric, optional timezone and capabilities. Discovery must provide positive API evidence. Cache payload interpretation and account checks belong to the adapter.
3. Register the adapter in `DEFAULT_PROVIDERS`. No new Action input, environment variable, collector branch or provider-specific renderer branch is necessary. Tests can inject a registry through `collect(options, { providers })`.
4. Add synthetic tests for detection, authentication, counts, cache identity/migration, failures and private-data protection. Add a short configuration/permissions example.

Presentation reads each source's explicit label, color, metric, origin, timezone and capabilities. Capabilities declare supported totals, language data and repository counts. A calendar-only source reports contributions without fabricating zero commits, issues or stars. Unsupported metrics are marked unavailable; mixed cards identify incomplete coverage. Existing activity without this metadata uses the compatibility resolver for GitHub, GitLab and local snapshots.

The collector validates/resolves all server sources, gathers their data, appends manual snapshots, and combines them through the existing model. Outputs are written only after every required source succeeds. A test-only third provider exercises this extension contract through collection and rendering.
