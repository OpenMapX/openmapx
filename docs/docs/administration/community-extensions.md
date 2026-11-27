---
title: Community extensions
description: Inspect extension trust and host access, install or update components, and configure OpenConditions.
sidebar_position: 4
---

# Community extensions

Install community components through **Admin → Extensions** or
`pnpm openmapx ext`. An extension can contain integration artifacts, container
services, or both. An integration artifact can include backend code.

:::warning[Review third-party code and access]

An integration's backend code (`dist/backend/index.mjs`) runs inside the
OpenMapX API process, with the same access as a built-in integration: to this
instance, its database, its credentials and its users' data. The host does not
sandbox it. Before loading a bundle, the API checks its imports and refuses one
that imports unbundled packages or OpenMapX internals; that check catches
packaging mistakes and is not a security boundary. Install only integrations you
trust. Service containers also execute third-party code; their sandbox restricts
host access but does not audit their behavior. Frontend code from community
integrations is still rejected. A verified catalog entry means a maintainer
reviewed that exact version and the host checks its pinned bytes; it is not a
security audit. Review the integration source, service commit, container image,
credentials, network access and host ports before installation.

:::

## Trust tiers

Every extension carries a trust tier assigned by the host. A manifest cannot
grant its own trust:

| Tier          | Meaning                                                                      | Source                                                    |
| ------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| **built-in**  | Ships in the OpenMapX monorepo                                               | First-party                                               |
| **verified**  | Catalog authorization binds the exact manifest ID, version and SHA-256 bytes | An immutable default catalog with a digest-bound entry    |
| **community** | No verified catalog authorization                                            | Custom sources, unpinned entries or a direct manifest URL |

The default catalog does not make every entry verified. Direct URL installation
validates the fetched manifest and uses its actual identity, always at community
trust. Catalog installs continue to require matching identity, declared version
and digest where present. Verification is not a security audit. Verified and
community services receive the same community container sandbox.

### What earns the Verified tier

An entry is verified only when all of these hold, and the host checks the first
three itself:

1. The entry is in the **default catalog** and the host reads that catalog from an
   immutable URL, one that names an exact 40-character commit. A branch URL, a
   custom source or an `EXTENSION_CATALOG_URL` that can move never carries
   verified trust.
2. The entry names the exact manifest `id`, `version` and `manifest` URL, and the
   SHA-256 of the manifest bytes in `manifestSha256`. The host hashes the bytes it
   receives before parsing them and refuses a mismatch, a different `id` or a
   different `version`. An entry cannot declare its own `trust`.
3. The fetched manifest validates, and every integration artifact it names carries
   its own SHA-256.
4. An OpenMapX maintainer reviewed the extension against the review bar below
   before the entry was added to the catalog repository.

The review bar for step 4 covers what the digest cannot show. The reviewer reads
the manifest and everything it references at the pinned revisions:

- Each service repository is pinned to a full commit SHA, not a tag, branch or an
  omitted ref, and the reviewer has read the code and `Dockerfile` at that commit.
- The container image, requested host ports, bind mounts, environment and
  credentials, and outbound network access are what the extension's purpose needs.
- Each integration artifact contains no frontend runtime entry point, the
  reviewer has read its backend bundle (`dist/backend/index.mjs`) and its source,
  and its files match the digest.
- The extension states the license and attribution of the data it serves.

Passing this review establishes who vouched for these exact bytes. It is not a
security audit, and a verified service runs in the same community container
sandbox as any other.

A verified entry reaches installations through a host release, not through the
catalog repository alone: the default catalog is pinned to a commit in the
OpenMapX source, so a new or changed entry becomes verified for users when that
pin is moved to a catalog commit containing it. A new version of an extension
needs its own reviewed entry with a new digest. Until the pin moves, the entry is
not offered as verified.

## Browsing and installing

Open **Extensions** in the admin panel. It has three tabs:

- **Browse**: cards for every extension in the merged catalog, with search and
  filters by trust tier and component type. Each card shows the trust badge, the
  component types it ships (service / integration), a [service security
  rating](#service-security-rating), and compatibility with your platform
  version. An incompatible, delisted, or security-flagged extension cannot be
  installed.
- **Installed**: what you have installed, each with its components expanded
  (service security rating inline), an **Update** action when a newer version is
  published, and **Uninstall**.
- **Sources**: the catalog sources the Browse list is merged from. The default
  OpenMapX catalog is built in and cannot be removed; you can add your own
  (HTTPS only, with no username, password, query, or fragment) and they appear
  as the **community** tier. The same locator rule applies to direct manifest
  URLs and every artifact or service repository declared by an extension.

Select an entry, inspect the preview and confirm the installation. For an
extension outside a catalog, use **Install from URL** with its `extension.json`
URL. Direct URL installs always have community trust.

## Standalone integrations

Use **Extensions → Install integration** for an integration that has no
`extension.json` bundle. Choose an HTTPS repository and optional ref, an HTTPS
artifact URL with its SHA-256, or a local `.tar.gz` archive. Archives are limited
to 200 MiB compressed and expanded. Symbolic links, frontend code, incompatible
protocols and unsafe archive paths are rejected. A backend bundle is accepted and
runs in the API process with full access, so install only integrations you trust.

**Review source** prepares the exact bytes without replacing the installed
integration. Check the integration ID, version, content digest and resolved Git
commit before installing. Reviews expire after ten minutes; review again if one
expires. Uploads remain private to the administrator who created them.

Installation runs as an Activity job and records community trust plus the actual
source provenance. The agent holds the component and uploaded artifact while the
API reloads the integration and records ownership. A confirmed failure restores
the original directory; an uncertain result keeps the original transaction held
for reconciliation. Closing the dialog only stops observation. Cancellation can
remain pending until restoration is confirmed. Retrying the same request observes
its existing job instead of installing twice.

In **Local integrations**, the inventory includes CLI-installed directories,
standalone owners, invalid legacy content and missing local files, independently
of catalog availability. A directory without an owner record shows its source as
unknown; to manage it from the admin panel, install it again with **Install
integration** so its provenance is recorded.

**Remove** requires confirmation of the reviewed content digest. The agent keeps
the original directory in quarantine until reload and ownership bookkeeping
complete. If CLI already removed the files, removal verifies their absence under
the same component lock before cleaning up the remaining standalone records.
A changed directory or foreign/catalog owner blocks the action. Invalid executable
legacy entries stay inert and require host inspection rather than privileged
execution or automatic deletion. Pending transactions show their original
Activity reference; an unknown result keeps the component held for reconciliation.
Standalone parents use this view rather than bundle update/uninstall controls.

The same operations are available on the CLI:

```bash
SESSION="$HOME/.local/state/openmapx/admin-session"
pnpm openmapx ext browse --session-file "$SESSION"                 # list the catalog
pnpm openmapx ext preview openconditions --session-file "$SESSION" # inspect bindings and fingerprint
pnpm openmapx ext install <catalog-id> --session-file "$SESSION"    # acquire preview, then queue if consent permits
pnpm openmapx ext install https://example.com/my-ext/extension.json --session-file "$SESSION"
pnpm openmapx ext list --session-file "$SESSION"                   # what's installed
pnpm openmapx ext update <id> --session-file "$SESSION"            # update to the currently authorized version
pnpm openmapx ext remove <id> --session-file "$SESSION"            # uninstall (removes its services + integrations)
```

The CLI acts as your administrator session, exactly as `pnpm openmapx system
update` does (see [Upgrading](../install/upgrading.md#3-apply-the-release)).
`--session-file` names a private file (owned by you, mode `0600`, one link)
that contains only a signed-in full administrator's Better Auth session cookie;
the CLI never discovers browser cookies or creates a session. Each action reads
it once and sends it, for all of that action's requests, only to the HTTPS API
origin `https://DOMAIN`, or the origin `--api-origin` names, with redirects
refused. The API's administrator-access rules apply as in the panel.
Every accepted install/update/remove is recorded in the audit log under that
administrator.

Install and update always acquire a fresh preview first, using the same API
client and selector as the subsequent write. Without host ports they may proceed.
With host ports, first deliberately inspect the explicit preview:

```bash
pnpm openmapx ext preview <idOrUrl> --session-file "$SESSION"
pnpm openmapx ext install <idOrUrl> --host-port-confirmation <fingerprint> --session-file "$SESSION"
# For an update, preview the same catalog ID:
pnpm openmapx ext preview <id> --session-file "$SESSION"
pnpm openmapx ext update <id> --host-port-confirmation <fingerprint> --session-file "$SESSION"
```

Use the `confirmation` fingerprint from the inspected output. Preview shows the
complete extension identity and source trust, each service's full repository
commit, all effective host/container ports, bind addresses (including IPv6),
protocols and full security rating, including deployment variables and factors.
Preview may fetch and stage repositories. Direct manifest URLs follow the same
review flow and always have community trust. Because install/update obtain
another preview, respect the one-preview-per-30-seconds limit after an explicit
`ext preview` before invoking them. A 429 exits without retrying; wait for its
`Retry-After` before a deliberate new invocation.

Missing or mismatched confirmation fails with a nonzero exit before the write.
If the snapshot moves between inspection and install/update, run a new explicit
preview and review it before supplying its fingerprint. The CLI never copies a
fresh fingerprint into consent, offers no `--yes` bypass, and does not re-enqueue
a failed write. The worker remains the authority for host-port enforcement.

Read requests have a 30-second deadline; preview and install/update/remove
requests have finite 180-second deadlines, including response-body reading.
A timeout leaves the outcome uncertain and does not cancel host work. Check
**Admin → Activity** before deliberately retrying. HTTP 202 and the printed job
ID mean queued acceptance, not completion. The CLI exits after acceptance without
watching the job. Failed or invalid responses produce safe stderr and a nonzero
exit, without dumping API payloads. Respect 429 `Retry-After`; no command retries
automatically.

## What happens on install

Install is a queued orchestration with ownership records and recovery journals.
It attempts rollback on failure; a rollback or cleanup failure still requires
operator investigation. Do not assume a failed job left every component
unchanged. The normal sequence is:

1. **Inspect + pin each service repository**: the operations agent
   shallow-clones the bundle's pinned tag or commit and validates every
   `service.json` against the [service manifest](../developer/service-manifest.md)
   schema and the community sandbox. If any manifest fails, or a service id is
   already taken, the whole install is refused before anything changes. The
   security preview describes that exact commit, and only that commit is
   installed, into the agent's community store
   (`infra/docker/state/ops-agent/community/<url-hash>/`), managed by this extension.
2. **Enable + render + start** the service(s): `compose render` regenerates the
   stack and the container is brought up. Database initialization and migration behavior belongs to the installed service;
   inspect its startup logs.
3. **Install each integration artifact**: the operations agent downloads the
   `.tar.gz` (HTTPS only), verifies its SHA-256 before extraction, unpacks it
   into its integration store (`infra/docker/state/ops-agent/custom-integrations/<id>/`)
   and records the SHA-256 of every file it
   wrote. The integration host is then hot-reloaded.
4. **Record** the installed extension and its components.

The operations agent owns its community store,
`infra/docker/state/ops-agent/community/`, the way it owns
Docker and the generated configuration. `api` never writes there: it asks
the agent to inspect, install, settle or remove a repository, and reads the
installed community services back from it. Until a change is settled the agent
keeps the previous checkout for rollback and attempts recovery of interrupted
changes on startup. Recovery failures remain operator work.

The agent trusts an installed repository by content, not by file permissions.
When it installs a commit, its record (`community/.repository-<hash>.json` in that store)
lists each `service.json` it validated with that file's SHA-256. The agent, and
the CLI it runs for updates, builds and backups, load exactly those manifests
and only while their bytes match: a manifest the record does not list, or a
repository directory without a record, is never loaded. Changed bytes, or a
record the agent did not write, stop the agent from starting or authorizing
anything, as an invalid manifest always has. Recover by deleting that
repository's directory and record in the community store and installing
the extension again. Records are the agent's own files: they must be owned by
its user and writable only by it. Repositories installed before records carried
digests are refused the same way. Both stores live in the agent's state
directory on the host, which is gitignored, so installs survive container restarts.

The agent owns its integration store,
`infra/docker/state/ops-agent/custom-integrations/`, the same way. It installs,
updates, rolls back and removes integrations; `api` mounts the store
read-only at `/app/custom_integrations` and
`pnpm openmapx integrations install` and `remove` ask the agent too. For each
integration the agent records the SHA-256 of every file it installed, in its
own state directory (`infra/docker/state/ops-agent/integrations/`), which no
other service mounts. The agent, and the CLI it runs, load an installed
integration's configuration schema only while its `manifest.json` has exactly
the recorded bytes; `api` serves only the files whose bytes match. File
owners and modes in the store decide nothing. An integration the
agent did not install, or whose files changed, is left out and reported (in the
agent's startup log and in **Run diagnostics**) without affecting the others.
Install it again to fix it.

Each record also names its owner: the extension that installed it, or the
operator for an install made with the CLI. Only that owner changes or removes
it, so an extension and a manual install don't replace each other by accident.

This is bookkeeping, not a security boundary: `api` and the CLI reach the
agent with the same credentials, and `api` can install any artifact as an
admin anyway. What the agent guarantees is that every installed file is one it
verified and recorded.

### The service sandbox

The sandbox is derived from provenance, not the manifest's `quality` label:
manifests loaded from the community store are third-party, must say `community`,
and the admin lists them as community. They may **not** use any `bindMounts`
entry: community service installation and updates reject every host bind mount,
including read-only mounts, with `community_bind_mount_forbidden`. Use a
namespaced named volume (`openmapx-<serviceId>-<suffix>`) for persistent service
state instead. They may not use `networkMode: "host"`,
`privileged: true`, host device pass-through, escape-class Linux capabilities
(`SYS_ADMIN`, `SYS_PTRACE`, `NET_ADMIN`, and similar), deployment `envFile`, or
Compose-variable bind paths. Network aliases may not collide with another
service id or alias. Every community service must declare a literal memory limit
in `container.memory` (for example `"512m"`); installation and updates reject a
service without one with `community_memory_limit_required`. The platform also
limits each community container to 512 processes and threads
(`deploy.resources.limits.pids`, beside the memory limit) and starts it with
`no-new-privileges`, so a runaway extension cannot take the host down or gain
privileges through a setuid binary. Operator configuration belongs in
`configSchema`; secret fields are delivered as `/run/secrets/<KEY>` with
`<KEY>_FILE` set. A community Git URL must also be `https://` on a short
allowlist of public hosts (`github.com`, `gitlab.com`, `codeberg.org`,
`bitbucket.org`, `git.sr.ht`). Local-file, SSH and intranet clone URLs are rejected.

### Service security rating

Each service component shows a deterministic **security rating** (1 to 8) computed
from what its manifest declares: published host ports lower it, auth-in-front
and an owned (scoped) database schema raise it, while privileged/deployment-variable declarations lower it. The score is clamped
to the 1 to 8 range. Prohibited community declarations still fail installation
regardless of score; the rating does not assess executable code. Integrations get
no numeric rating: an integration's backend code runs in the API process with
full access, which no declaration score can express. Their companion services use
the service rating instead.

### Install-time hardening

Integration artifacts are guarded on several fronts: only HTTPS artifact URLs are
accepted; a SHA-256 pin is mandatory and checked before extraction; artifacts
and their extracted contents are each capped at 200 MiB; an artifact must be a
gzip-compressed tar; tar extraction accepts
only regular files and directories, so it refuses path escapes (zip-slip),
absolute paths and every symbolic or hard link; and an artifact shipping a
`node_modules/` directory is rejected. Frontend runtime entry points are also
rejected. A backend bundle is accepted only at `dist/backend/index.mjs`, together
with `migrations/*.sql` and `assets/**`, within the archive limits, and runs in
the API process with full access. These reduce the blast radius of a malformed
archive. They cannot establish that the author's code is safe.

The agent also refuses an archive it would not load, before it replaces
anything:

- an entry that is a symbolic link or a hard link;
- a `manifest.json` larger than 128 KiB or not UTF-8;
- a configuration schema the agent does not accept;
- an id longer than 64 characters, or the id of a built-in integration;
- more than 1,024 files, or more than 4,096 across all installed integrations;
- file paths and artifact URLs that, across all installed integrations, would
  not fit in the agent's one-shot inventory of them (about 640 KiB of paths,
  digests and URLs as JSON).

Installed files get fixed modes (`0755` for directories, `0644` for files),
whatever the archive declares.

### Preview, admission and failures

Extension previews have an independent limit of one request per 30 seconds per
network peer key. Install and update admission share a separate bucket with the
same limit. At the HTTP level, preview can therefore be followed immediately by
a deliberate install or update write. The CLI's install/update acquire their own
fresh preview, so after `ext preview` they must also respect the preview bucket.
Repeated requests in either bucket return 429 with
`Retry-After`; there is no automatic mutation retry. Administrator, CSRF and
broader API rate limits still apply.

Install, update and removal return a queued job ID (HTTP 202). Check Activity
for the terminal outcome. Dependency failures return bounded public messages;
manifest detail may still return an empty component list if resolution fails.
That fallback does not prove the extension has no components.

The internal operator CLI provides `ext preview <idOrUrl>` and
`ext install/update --host-port-confirmation <fingerprint>` as described above.
Host-port approval is bound to the exact inspected snapshot and is never granted
automatically.

### Browser review and request lifetime

The administration page distinguishes catalog trust from revoked status and stale
revocation data. A missing manifest version appears as **Version unknown**. The
default catalog label does not assert that every entry is verified. Failed inventory/source reads show an error. Installed inventory is local and
remains readable when optional catalog acquisition fails; update availability
then becomes unknown (`hasUpdate: null`). Removal remains available. Unknown
version comparison is not evidence that the installed version is current.

Security review displays the exact repository commit, effective host-port bindings
(including protocol and bind address), and full service rating, including deployment
variables. Install and update have distinct confirmation actions. Editing a selector,
closing/reopening a dialog, switching tabs or API origins, selecting another row,
or receiving a changed catalog/installed snapshot retires the previous preview.
Confirmation uses the exact reviewed selector and fingerprint. A changed port
snapshot requires another deliberate review; confirmation is never automatic.

Browser reads have a 30-second deadline. Preview, mutation resolution and explicit
catalog refresh have a 180-second deadline. A timeout is an unknown result, not
host-job cancellation; check Activity before deliberately retrying. The longer
budget is not a guarantee for extensions with several repositories. Accepted jobs
continue to be observed by the administration layout after leaving the extension
view; all terminal outcomes refresh the originating extension/component state.

### Catalog document format

A catalog source serves one JSON object, the same format for the default catalog
and for custom sources:

```json
{
  "schemaVersion": 1,
  "extensions": [
    { "id": "example-extension", "name": "Example", "manifest": "https://…/extension.json" }
  ],
  "removed": [],
  "critical": []
}
```

`schemaVersion` is required and must be `1`; a host refuses a catalog with a
missing or different format version, as it refuses a bare list of entries.
`extensions`, `removed` and `critical` are optional. `removed` and `critical`
follow the rules of the [revocation feed](#publishing-a-revocation). Extension,
service and integration ids are lowercase slugs of at most 48 characters
(`^[a-z0-9]+(-[a-z0-9]+)*$`), and a verified entry's `version` is a semantic
version.

### Catalog source changes and refresh

A successful source edit invalidates the cached catalog before persisting the
new source list. An older in-flight build cannot republish against changed source
or catalog bytes. Concurrent edits or refreshes can therefore fail with a safe
error: read the current state before deliberately trying again. No mutation is
automatically retried, and unavailable source storage cannot acknowledge an edit
or an explicit refresh.
Removing an absent source remains a no-op; the default source remains built in.

A fully successful empty refresh replaces the previous catalog. If any catalog
source acquisition fails and the assembled result is empty, refresh fails and
leaves the existing snapshot, including its denials, untouched. Nonempty partial
results retain their existing behavior; a returned entry count does not prove
that every source was fetched. Moving-feed stale status remains independent.
A storage or refresh error is not evidence that the catalog is empty.

## Updating, uninstalling, and the kill-switch

- **Update** applies the catalog's current authorized bundle through the same
  preview and confirmation flow. Verified entries bind manifest ID, version and
  digest; a moving manifest cannot choose a new verified version by itself.
  Unverified entries can use manifest metadata for version discovery. Inspect
  the resulting preview before consent.
- **Uninstall** removes exactly what the extension installed: it stops and removes
  its service containers, drops the cloned repos and the integrations it placed,
  re-renders compose, and reloads the integration host. Standalone installs of
  the same component are left alone.
- The catalog and a separate **revocation feed** can carry a **kill-switch**. An
  extension listed as `removed` is shown as delisted and cannot be installed or
  updated. One listed as `critical` refuses preview, new installation and update
  admission. The worker rechecks before installation effects and before
  committing installed state, including when an advisory arrives while a job is
  queued. A critical entry without `maxVersion` blocks every version; one with
  `maxVersion` blocks that version and every earlier one by semantic-version
  order, so a fixed later release can be installed while the advisory stays in
  place. A version that is not a semantic version is always blocked. Otherwise
  wait for the advisory to be cleared before trying another deliberate install
  or update. Removal remains available.
  A revocation does not stop or remove a copy that is already installed. An
  advisory is checked against the installed version as well as the offered one:
  when it covers the installed version, the **Browse** card shows the extension
  as revoked and the **Installed** tab names the advisory, even when the
  catalog already offers a fixed version. Update to that version, or remove an
  extension that is revoked.
- When the catalogs and the revocation feed carry several `critical` entries for
  one extension, the widest one applies: an entry without `maxVersion` wins over
  any entry with one, and otherwise the highest `maxVersion` wins. A later source
  can add a denial but never narrow one.
- If the revocation feed cannot be refreshed, or answers with something that is
  not a valid denial list, known cached denials remain effective and the API
  reports stale revocation data. Browse then shows a stale-data warning on the
  page and on every entry that is not revoked, beside its tier, so "could not
  check" never reads as "clean". An empty list is a fresh answer and shows no
  warning.

### Publishing a revocation

The revocation feed is `revocations.json` on the `main` branch of the
`community-extensions` repository, read from
`https://raw.githubusercontent.com/openmapx/community-extensions/main/revocations.json`.
Set `EXTENSION_REVOCATION_URL` to read a different feed. It is deny-only: it can
block an extension but never add one, change a manifest or raise trust. It takes
effect on installations without a release, once GitHub serves the new file, which
can take a few minutes.

```json
{
  "schemaVersion": 1,
  "removed": [{ "id": "example-extension", "reason": "Abandoned by its maintainer" }],
  "critical": [
    {
      "id": "another-extension",
      "reason": "Exfiltrates credentials",
      "maxVersion": "1.2.0"
    }
  ]
}
```

- `schemaVersion` is required and must be `1`. A host refuses a document with a
  missing or different format version and keeps its last good denials, so a
  later format never silently reads as "nothing revoked" on an older host.
- `removed` delists an extension. `critical` is a security advisory.
- Both lists are optional; a feed with neither is valid and empty. `id` is
  required on every entry and `reason` is optional text. `maxVersion` on a
  `critical` entry is optional and must be a semantic version such as `1.2.0`;
  it names the newest affected version.
- `maxVersion` is for an extension whose author shipped a fix. The version it is
  compared with is the one the extension declares about itself: for an
  installation from a direct manifest URL, that is whatever the fetched manifest
  says. An author can step past a bounded advisory by publishing a higher
  version number, so list a hostile extension without `maxVersion`, or under
  `removed`.
- The whole document is validated. One malformed entry makes installations treat
  the entire feed as unreadable and keep their last good denials, so validate
  before merging.
- To lift a revocation, delete its entry. The feed carries no expiry.

Revoke by merging a change to `revocations.json`; do not edit the catalog entry to
revoke it, because the default catalog is pinned and only changes with a release.

:::note[An extension-managed service repo is pinned]
Service repos installed as part of an extension are pinned and marked
managed-by-extension. Update them through the extension (which re-pins every part
together). A manual refresh of a managed repository is refused.
:::

## Example: OpenConditions

[OpenConditions](https://github.com/openconditions/openconditions) supplies
container services. OpenMapX's built-in `openconditions` integration reads its
road conditions, hazards, fuel, charging, parking, cameras, message signs,
road weather, service vehicles and border-crossing data. The companion
contributions API accepts crowd reports. Which data is usable depends on the
installed release, feed credentials, source policy and publication state.

Inspect the currently authorized catalog entry and pinned service manifests;
do not assume that a moving upstream release matches an older deployment.

```bash
SESSION="$HOME/.local/state/openmapx/admin-session"   # your administrator session cookie
pnpm openmapx ext preview openconditions --session-file "$SESSION"
# After reviewing the preview, wait for its preview rate-limit window if needed:
pnpm openmapx ext install openconditions --host-port-confirmation <fingerprint> --session-file "$SESSION"
```

Use the exact fingerprint from the reviewed output when host-port consent is
required. Check **Activity**, then configure the installed services. A completed
installation does not prove that their database and feed credentials are valid.

### Configuring the OpenConditions services

1. Open **System → Services → openconditions-ingest** and
   **openconditions-contributions-api**. Read each installed manifest's fields
   and setup guides.
2. Set secrets on **Credentials**. The API vault needs the secrets key that
   `pnpm openmapx compose render` generates; generated containers receive private secret files through
   `<KEY>_FILE`. The ingest and contributions services need `DATABASE_URL`.
   Never give a community service the PostgreSQL superuser's URL, even when its
   own documentation suggests one, nor the `openmapx_api` and
   `openmapx_data_manager` roles: any of them would let it read and change
   accounts and the platform's configuration. The superuser is worse still: it
   can change every role and run commands in the database container. Create a
   dedicated role for each service with only
   what it needs, as shown below, and use
   `postgresql://<role>:<password>@openmapx-postgis:5432/openmapx` with a correctly
   URL-encoded password. The contributions service also declares
   `OPENCONDITIONS_GRANT_SECRET` and `OPENCONDITIONS_REVIEWER_TOKEN`; generate
   separate values with `openssl rand -hex 32`. `OPENCONDITIONS_SECRETS_KEY`
   encrypts the OAuth grants and private keys OpenConditions stores in the
   database: generate one value with `openssl rand -hex 32` (64 hexadecimal
   characters) for **openconditions-ingest**, and copy that same value, never a
   newly generated one, into the **Credentials** of every other OpenConditions
   service that declares it: the contributions service and, when enabled, the
   heavy-feeds process `openconditions-ingest-heavy`. A federation service
   started from its own compose file gets the copy as a mounted file, as
   OpenConditions'
   [federation guide](https://github.com/openconditions/openconditions/blob/main/docs/federation-onboarding.md)
   shows. The first ingest process to start seals its key in
   `conditions.secrets_key_check`, and every other service refuses to start
   with a different key, with an error naming that table; start the ingest
   service first. A lost key means deleting the sealed rows and logging in to
   every OAuth feed again; see OpenConditions'
   [secrets encrypted at rest](https://github.com/openconditions/openconditions#secrets-encrypted-at-rest).
   OpenMapX's vault stores the key in `public.service_secret`, encrypted with
   OpenMapX's secrets key file `infra/docker/secrets/secrets-key`, so a full
   database backup holds it, encrypted, next to the values it protects. Such a
   backup is safe for them only while that key file stays out of it. Keep both
   keys, the OpenConditions secrets key and OpenMapX's `secrets-key`, in your
   recovery set (see
   [Backup & restore](./backup-and-restore.md#what-gets-skipped-and-why)).
   A role is created once, as the superuser, in the `postgis` container. A
   service that creates its own schemas needs `CREATE` on the database; it then
   owns those schemas. The ingest service checks that right at every start,
   since it runs `CREATE SCHEMA IF NOT EXISTS conditions` each time, so do not
   revoke it after installation. Give each role a search path of its own schemas and
   `extensions`, where PostGIS lives; leave out `public`, which the API's role
   owns. Create both OpenConditions roles before the ingest service first
   starts:

   ```bash
   docker exec -it openmapx-postgis psql -U postgres -d openmapx
   ```

   ```sql
   CREATE ROLE openconditions_ingest LOGIN PASSWORD '<openssl rand -hex 32>';
   ALTER ROLE openconditions_ingest SET search_path = conditions, extensions;
   GRANT CREATE ON DATABASE openmapx TO openconditions_ingest;
   CREATE ROLE openconditions_contributions LOGIN PASSWORD '<openssl rand -hex 32>';
   ALTER ROLE openconditions_contributions SET search_path = conditions, extensions;
   ```

   Grant nothing in `conditions` yourself. Only the ingest service migrates,
   with its heavy-feeds process when that is enabled: it creates the
   `conditions` schema and owns it. At every start, after
   migrating, it grants `openconditions_contributions` exactly what the
   contributions service uses, and `openmapx_tiles_owner`, the role Martin's
   traffic tiles run as, read access to `road_segment`, `segment_speed`,
   `source` and `public_license_policy` and the use of `segment_flow`,
   `flow_public_licenses` and `flow_osm_credit`. It grants only roles that
   exist; create both first, so the contributions service finds its grants on
   its first start. A role created later, or dropped and created again, gets
   its grants once the ingest service restarts. The optional heavy-feeds
   process and federation service connect with the ingest service's role and
   `DATABASE_URL`, never with a role of their own. The contributions service
   waits until the ingest service has migrated, for at most
   `OPENCONDITIONS_SCHEMA_WAIT_TIMEOUT_MS` (five minutes by default), and then
   stops; after that it waits for the sealed key check. While a first
   migration takes longer than about three minutes, it reports unhealthy, and
   it recovers once the migration finishes. No OpenMapX role can read
   OpenConditions' credentials or crowd reports. The roles live outside the
   database, so a backup restore keeps their grants only while the roles still
   exist, and those roles must be able to log in. After restoring into a
   cluster where you had to create the roles again, restart the ingest
   service, which grants them again.

   A `conditions` schema created by an OpenConditions build from before its
   migration baseline is not upgraded: the ingest service's migrations fail
   with "relation already exists". Drop the `conditions` schema before the
   first start of a release with the baseline; the old history table
   `drizzle.__drizzle_migrations_oc` is no longer read and can be dropped too.
   See OpenConditions'
   [release note](https://github.com/openconditions/openconditions/blob/main/docs/release-notes/database-baseline.md).

3. Set `OPENCONDITIONS_INSTANCE_ID` before any OpenConditions service first
   starts. It is required and names this instance in every record id it
   creates (`oc:<class>:<instanceId>:<localId>`), in crowd reports and in the
   signatures over them, so set it once and never change it: a later change
   would orphan or invalidate everything stored. Use a stable name you
   control, such as the instance's domain (`maps.example.org`). Give every
   OpenConditions service the same value: the ingest service, the
   contributions service and, when enabled, the heavy-feeds process and a
   federation service. The ingest service records it at its first start, and
   every service refuses to start with a different one.

   If a wrong value was recorded, the shared `openmapx` database cannot simply
   be started empty. Stop every OpenConditions service, then drop the
   `conditions` schema (`DROP SCHEMA conditions CASCADE;` as the database
   owner), set the right value and start the services again; the ingest
   service recreates the schema and records the new value. This deletes every
   OpenConditions record, report and vote, so do it before the instance is in
   use.

4. Set the relay token on both sides. OpenMapX's API relays crowd reports from
   browsers to the contributions service and never forwards the reporter's
   address, so the contributions service would otherwise count every report
   against one address. With the token, it recognises the API's requests and
   rate-limits them in a relay bucket, while the API rate-limits each client
   address itself. Generate one value of at least 32 characters
   (`openssl rand -hex 32`) and set it as `OPENCONDITIONS_RELAY_TOKEN` in the
   **Credentials** of **openconditions-contributions-api** and, for the API, in
   `infra/docker/.env` (step 7). Use the same value on both sides; a set but
   shorter token stops the contributions service from starting. Neither side
   reports a mismatch: with two different values, the contributions service
   treats every relayed request as the API's one address, so enrollment for
   the whole instance stops at that service's per-address limit (ten a minute
   by default). If reporters see enrollments refused with `429` under ordinary
   use, compare the two values.
5. Set non-secret options in **Configuration**, or use
   `SERVICE_OPENCONDITIONS_INGEST_<KEY>` and
   `SERVICE_OPENCONDITIONS_CONTRIBUTIONS_API_<KEY>` host overrides. Environment
   values take precedence. Community manifest `container.environment` values
   are literal; `${VAR}` there does not grant access to deployment secrets.
6. Apply changes, follow every returned job and check health and startup logs.
7. Set the OpenMapX consumers' endpoints and the API's relay token in
   `infra/docker/.env`:

   ```bash
   OPENCONDITIONS_URL=http://openmapx-openconditions-ingest:4100
   OPENCONDITIONS_CONTRIBUTIONS_URL=http://openmapx-openconditions-contributions-api:4200
   OPENCONDITIONS_OPERATOR_TOKEN=
   OPENCONDITIONS_RELAY_TOKEN=<the value from step 4>
   ```

8. Recreate the consumers as described under [Applying a change](#applying-a-change).

The blank operator token above does not enable restricted feeds. Configure it
deliberately on both sides when your source terms permit operator-scope access.

Each community service has its own network. Built-in manifests explicitly bridge
`postgis` and `api` to both OpenConditions services; Data Manager and Overpass
join the ingest network, and `postgis` and Overpass also join the heavy-feeds
process's network when it is installed. These bridges are bidirectional: an ingest container can
reach the bridged API, database and Data Manager, including internal endpoints.
They are granted by service ID, so another extension claiming those IDs receives
the same network reach. This exception is part of the trust decision; a separate
network does not isolate those peers. Community services receive no platform
public proxy route. See the [service manifest contract](../developer/service-manifest.md).

#### The operator token

Set the same `OPENCONDITIONS_OPERATOR_TOKEN` in the ingest service's
**Credentials** and in OpenMapX's `.env`. The API and Data Manager send it as a
bearer token. The ingest service requires at least 32 characters when configured;
its credential is separate from the consumers' environment value.

Operator scope includes feeds withheld from public redistribution. The reviewed
OpenConditions configuration includes Tankerkönig (recipient restrictions),
OpenStreetMap-derived records (ODbL obligations), E-Control (unasserted API terms)
and restricted feeds in other domains. The token grants technical access; it
does not grant redistribution rights. Review each installed source's terms,
retention, attribution and permitted recipients before exposing its data.

| Ingest credential state            | Result for OpenMapX requests                                                |
| ---------------------------------- | --------------------------------------------------------------------------- |
| Unset                              | Public scope, restricted sources withheld and ordinary public rate limiting |
| Matches the consumer token         | Operator scope; restricted feeds can be returned                            |
| Set but different                  | Bearer reads fail with 401                                                  |
| Set but shorter than 32 characters | Ingest refuses startup                                                      |

When restricted data is missing, inspect the service's scope and provider status
before treating it as a geographic coverage gap. Public scope does not establish
that a region has no stations or conditions. Rotate the ingest credential and
consumer environment together, allowing for the brief mismatch while containers
are recreated.

#### Applying a change

For non-secret settings, **Save** stores the edit and publishes the host
configuration generation; **Save & apply** also queues recreation of the selected
service. Credential changes queue their own apply. Check Activity for completion.
These actions do not recreate every consumer of that service.

After editing `OPENCONDITIONS_URL`, `OPENCONDITIONS_CONTRIBUTIONS_URL` or the
consumer token in the host `.env`, recreate the API and Data Manager from the
repository checkout:

```bash
pnpm openmapx services start api data-manager
```

Host renders preserve settings and service secrets from the last published
configuration generation; they do not silently replace all admin values with
defaults. An unpublished database edit is not available to the CLI. Environment
overrides come from the host during CLI rendering; an API process cannot see
new `.env` lines until it is recreated.

For heavier OSM acquisition, point the ingest service at a self-hosted Overpass.
OpenMapX's own `OVERPASS_URL` does not configure that service. Set its base URL
(or full interpreter URL) and allow the private host in the service's egress
settings:

```bash
SERVICE_OPENCONDITIONS_INGEST_OVERPASS_URL=http://openmapx-overpass:80
SERVICE_OPENCONDITIONS_INGEST_OPENCONDITIONS_EGRESS_ALLOWED_HOSTS=openmapx-overpass
```

Address built-in services by their `openmapx-<service-id>` names, as here.
OpenMapX refuses to install a community service whose environment, command or
configuration defaults reach a built-in service by its bare ID, such as
`postgis` or `overpass`.

Then run `pnpm openmapx services start openconditions-ingest` or apply the
corresponding settings in the admin form. Verify the resolved source and the
resulting container logs.

For the author-and-operator
walkthrough of how an extension is built and bundled into one `extension.json`,
see [Building an external extension](../developer/building-an-external-extension.md).

## Where to go next

Use [Managing services](../install/managing-services.md) for host operations or
[Services administration](./services-administration.md) for the panel.
Extension authors should follow
[Building an external extension](../developer/building-an-external-extension.md).
