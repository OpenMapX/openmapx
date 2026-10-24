---
title: Community extensions
description: Inspect extension trust and host access, install or update components, and configure OpenConditions.
sidebar_position: 4
---

# Community extensions

Install community components through **Admin → Extensions** or
`pnpm openmapx ext`. An extension can contain declarative integration artifacts,
container services, or both.

:::warning[Review third-party code and access]

Service containers execute third-party code. The sandbox restricts their host
access, but does not audit their behavior. Installable integration artifacts
cannot contain backend or frontend runtime entry points; community presentation
execution remains disabled. A verified catalog entry establishes identity and
validation of exact bytes, not a security audit. Review the service commit,
container image, credentials, network access and host ports before installation.

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
  (HTTPS only, no credentials in the URL) and they appear as the **community**
  tier.

Select an entry, inspect the preview and confirm the installation. For an
extension outside a catalog, use **Install from URL** with its `extension.json`
URL. Direct URL installs always have community trust.

The same operations are available on the CLI:

```bash
pnpm openmapx ext browse                 # list the catalog
pnpm openmapx ext preview openconditions # inspect current bindings and fingerprint
pnpm openmapx ext install <catalog-id>    # acquire preview, then queue if consent permits
pnpm openmapx ext install https://example.com/my-ext/extension.json
pnpm openmapx ext list                   # what's installed
pnpm openmapx ext update <id>            # update to the currently authorized version
pnpm openmapx ext remove <id>            # uninstall (removes its services + integrations)
```

The CLI talks to the admin API; run it on the API host (loopback admin) or set
`OPENMAPX_API_URL`. The destination is read for each action, in order:
`API_URL`, `OPENMAPX_API_URL`, then `http://localhost:3001`. The CLI sends
`x-openmapx-local-admin` on every request, using the trimmed optional
`OPENMAPX_LOCAL_ADMIN_TOKEN` or an empty value. It omits cookies and does not
create a browser session; a remote URL alone does not authenticate. The API's
socket-peer, local-token and administrator-access rules still apply.
Every accepted install/update/remove is recorded in the audit log.

Install and update always acquire a fresh preview first, using the same API
client and selector as the subsequent write. Without host ports they may proceed.
With host ports, first deliberately inspect the explicit preview:

```bash
pnpm openmapx ext preview <idOrUrl>
pnpm openmapx ext install <idOrUrl> --host-port-confirmation <fingerprint>
# For an update, preview the same catalog ID:
pnpm openmapx ext preview <id>
pnpm openmapx ext update <id> --host-port-confirmation <fingerprint>
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
   installed, into `services/.community/<url-hash>/`, managed by this extension.
2. **Enable + render + start** the service(s): `compose render` regenerates the
   stack and the container is brought up. Database initialization and migration behavior belongs to the installed service;
   inspect its startup logs.
3. **Install each integration artifact**: the `.tar.gz` is downloaded
   (HTTPS only), its SHA-256 verified before extraction, unpacked into
   `custom_integrations/<id>/`, and the integration host is hot-reloaded.
4. **Record** the installed extension and its components.

The operations agent owns `services/.community/` on the host, the way it owns
Docker and the generated configuration. `app-api` never writes there: it asks
the agent to inspect, install, settle or remove a repository, and reads the
installed community services back from it. Until a change is settled the agent
keeps the previous checkout for rollback and attempts recovery of interrupted
changes on startup. Recovery failures remain operator work.

The agent trusts an installed repository by content, not by file permissions.
When it installs a commit, its record (`services/.community/.repository-<hash>.json`)
lists each `service.json` it validated with that file's SHA-256. The agent, and
the CLI it runs for updates, builds and backups, load exactly those manifests
and only while their bytes match: a manifest the record does not list, or a
repository directory without a record, is never loaded. Changed bytes, or a
record the agent did not write, stop the agent from starting or authorizing
anything, as an invalid manifest always has. Recover by deleting that
repository's directory and record under `services/.community/` and installing
the extension again. Records are the agent's own files: they must be owned by
its user and writable only by it. Repositories installed before records carried
digests are refused the same way. `custom_integrations/` is
written by `app-api`. Both locations are gitignored and live on the host, so
installs survive container restarts.

### The service sandbox

The sandbox is derived from provenance, not the manifest's `quality` label:
manifests loaded from `services/.community/` are third-party whether they say
`community` or `community-verified`, and the admin lists them as community. They may **not** use any `bindMounts`
entry: community service installation and updates reject every host bind mount,
including read-only mounts, with `community_bind_mount_forbidden`. Use a
namespaced named volume (`openmapx-<serviceId>-<suffix>`) for persistent service
state instead. They may not use `networkMode: "host"`,
`privileged: true`, host device pass-through, escape-class Linux capabilities
(`SYS_ADMIN`, `SYS_PTRACE`, `NET_ADMIN`, and similar), deployment `envFile`, or
Compose-variable bind paths. Network aliases may not collide with another
service id or alias. Operator configuration belongs in
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
no numeric rating because installable integration artifacts are declarative-only;
their companion services use the service rating instead.

### Install-time hardening

Integration artifacts are guarded on several fronts: only HTTPS artifact URLs are
accepted; a SHA-256 pin is mandatory and checked before extraction; artifacts
are capped at 200 MiB; tar extraction blocks path-escape (zip-slip), malicious
symlinks/hardlinks, and absolute paths; and an artifact shipping a
`node_modules/` directory is rejected. Backend and frontend runtime
entry points are also rejected; executable behavior must move into an isolated
service. These reduce the blast radius of a
malformed archive. They cannot establish that the author's code is safe.

The operations agent reads the configuration schema of every installed
integration, and loads one only from files its own account owns and nobody
else can write. A single integration it refuses stops it from authorizing any
configuration change. The installer therefore gives installed files fixed
modes (`0755` for directories, `0644` for files), whatever the archive or the
umask declares. It also refuses an integration the agent would not load:

- a `manifest.json` that is a symbolic link, hard-linked to another file,
  larger than 128 KiB or not UTF-8;
- a configuration schema the agent does not accept;
- an id longer than 64 characters.

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
- The catalog can carry a **kill-switch**: an extension marked `removed` is hidden
  from Browse (with a banner on installed copies), and one marked `critical`
  refuses preview, new installation and update admission. The worker rechecks
  before installation effects and before committing installed state, including
  when an advisory arrives while a job is queued. Every critical entry blocks
  regardless of its version; advisory `maxVersion` is display information only.
  Wait for the advisory to be cleared before trying another deliberate install
  or update. Removal remains available. If the moving revocation feed cannot be
  refreshed, known cached denials remain effective and the API reports stale
  revocation data; an unavailable feed does not certify an extension as clean.

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
pnpm openmapx ext preview openconditions
# After reviewing the preview, wait for its preview rate-limit window if needed:
pnpm openmapx ext install openconditions --host-port-confirmation <fingerprint>
```

Use the exact fingerprint from the reviewed output when host-port consent is
required. Check **Activity**, then configure the installed services. A completed
installation does not prove that their database and feed credentials are valid.

### Configuring the OpenConditions services

1. Open **Services → openconditions-ingest** and
   **openconditions-contributions-api**. Read each installed manifest's fields
   and setup guides.
2. Set secrets on **Credentials**. `OPENMAPX_SECRETS_KEY` is required for the API
   vault; generated containers receive private secret files through `<KEY>_FILE`.
   The ingest and contributions services need `DATABASE_URL`. For the shared
   database, use `postgresql://postgres:<POSTGRES_PASSWORD>@postgis:5432/openmapx`
   with a correctly URL-encoded password. The contributions service also declares
   `OPENCONDITIONS_GRANT_SECRET` and `OPENCONDITIONS_REVIEWER_TOKEN`; generate
   separate values with `openssl rand -hex 32`.
3. Set non-secret options in **Configuration**, or use
   `SERVICE_OPENCONDITIONS_INGEST_<KEY>` and
   `SERVICE_OPENCONDITIONS_CONTRIBUTIONS_API_<KEY>` host overrides. Environment
   values take precedence. Community manifest `container.environment` values
   are literal; `${VAR}` there does not grant access to deployment secrets.
4. Apply changes, follow every returned job and check health and startup logs.
5. Set the OpenMapX consumers' endpoints in `infra/docker/.env`:

   ```bash
   OPENCONDITIONS_URL=http://openconditions-ingest:4100
   OPENCONDITIONS_CONTRIBUTIONS_URL=http://openconditions-contributions-api:4200
   OPENCONDITIONS_OPERATOR_TOKEN=
   ```

6. Recreate the consumers as described under [Applying a change](#applying-a-change).

The blank token above does not enable restricted feeds. Configure it deliberately
on both sides when your source terms permit operator-scope access.

Each community service has its own network. Built-in manifests explicitly bridge
`postgis` and `app-api` to both OpenConditions services; Data Manager and Overpass
join the ingest network. These bridges are bidirectional: an ingest container can
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
pnpm openmapx services start app-api data-manager
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
SERVICE_OPENCONDITIONS_INGEST_OVERPASS_URL=http://overpass:80
SERVICE_OPENCONDITIONS_INGEST_OPENCONDITIONS_EGRESS_ALLOWED_HOSTS=overpass
```

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
