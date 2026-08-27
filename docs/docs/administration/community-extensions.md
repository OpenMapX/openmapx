---
title: Community extensions
description: Browse, install, and manage third-party extensions from the unified Extensions store — integrations, services, and bundles of both — and understand the trust model.
sidebar_position: 4
---

# Community extensions

OpenMapX ships with a large set of first-party services and integrations, but
its plugin model is open: anyone can publish an **extension** and you install it
into your own deployment from one place — the **Extensions store**
(**Extensions** in the admin panel, or `pnpm openmapx ext` on the CLI).

An extension bundles the parts of one feature so you install it in a single
action. A bundle may contain:

- **integrations** — declarative app metadata and presentation assets.
  Distributed as prebuilt `.tar.gz` artifacts, pinned by SHA-256. Community
  backend and POI-source JavaScript is rejected rather than run in a privileged
  host process.
- **services** — backend containers: a database, a routing engine, an alternative
  geocoder, a data processor. Distributed as Git repositories, pinned by tag or
  commit.

Most extensions are a single component (one integration, or one service); a
bundle like [OpenConditions](#example-openconditions) ships both together. Either
way you install it the same way, and the platform orchestrates the parts.

:::warning[You are running third-party code]
A community extension can contain code you did not write. Executable backend
behavior runs as a separately sandboxed service; app-api and data-manager never
import community runtime modules. Executable community presentation is disabled
until it has a cross-origin sandbox and narrow capability protocol. Verification
(see [trust tiers](#trust-tiers)) is
an identity and automated-validation check — **not a security audit**. Install
only from authors you trust, and read what an extension installs before you
confirm.
:::

## Trust tiers

Every extension carries one trust tier, and the tier is assigned by **where it
came from** — a manifest can advertise but never grant its own trust:

| Tier | Meaning | Source |
| --- | --- | --- |
| **built-in** | Ships in the OpenMapX monorepo | first-party |
| **verified** | Identity-checked + passed automated validation (not audited) | the curated OpenMapX catalog (`openmapx/community-extensions`), where inclusion is a CI-gated pull request |
| **community** | Unreviewed | a catalog source you added yourself, or a direct install by URL |

The default catalog source is the curated **verified** one. Anything you add
under **Sources**, or install by raw URL, is surfaced as **community** and
requires you to acknowledge the risk.

Verified and community services receive the same container sandbox. Verification
is a listing and identity check, not an integrity guarantee about the manifest,
moving image tag, or bytes that will run tomorrow.

## Browsing and installing

Open **Extensions** in the admin panel. It has three tabs:

- **Browse** — cards for every extension in the merged catalog, with search and
  filters by trust tier and component type. Each card shows the trust badge, the
  component types it ships (service / integration), a [service security
  rating](#service-security-rating), and compatibility with your platform
  version. An incompatible, delisted, or security-flagged extension cannot be
  installed.
- **Installed** — what you have installed, each with its components expanded
  (service security rating inline), an **Update** action when a newer version is
  published, and **Uninstall**.
- **Sources** — the catalog sources the Browse list is merged from. The default
  OpenMapX catalog is built in and cannot be removed; you can add your own
  (HTTPS only, no credentials in the URL) and they appear as the **community**
  tier.

Installing from the catalog is one click. To install something not in any
catalog, use **Install from URL** and paste an `extension.json` URL — that always
lands as **community**.

The same operations are available on the CLI:

```bash
pnpm openmapx ext browse                 # list the catalog
pnpm openmapx ext install openconditions # install by catalog id…
pnpm openmapx ext install https://example.com/my-ext/extension.json  # …or by URL
pnpm openmapx ext list                   # what's installed
pnpm openmapx ext update <id>            # re-pin to the latest published version
pnpm openmapx ext remove <id>            # uninstall (removes its services + integrations)
```

The CLI talks to the admin API; run it on the API host (loopback admin) or set
`OPENMAPX_API_URL`. Every install/update/remove is recorded in the audit log.

## What happens on install

Install is one orchestrated, atomic job — it reuses the per-component pipelines
and rolls back on any failure, leaving parts that already existed untouched:

1. **Register + pin each service** — the service repo is shallow-cloned at the
   bundle's pinned tag/commit into `services/.community/<url-hash>/` and marked as
   managed by this extension. Every `service.json` is validated against the
   [service manifest](../developer/service-manifest.md) schema; if any fails, the
   whole install is refused.
2. **Enable + render + start** the service(s) — `compose render` regenerates the
   stack and the container is brought up. Each service creates and migrates its
   own database schema on boot.
3. **Install each integration artifact** — the `.tar.gz` is downloaded
   (HTTPS only), its SHA-256 verified before extraction, unpacked into
   `custom_integrations/<id>/`, and the integration host is hot-reloaded.
4. **Record** the installed extension and its components.

Both on-disk locations (`services/.community/` and `custom_integrations/`) are
gitignored and bind-mounted, so installs survive container restarts.

### The service sandbox

The sandbox is derived from provenance, not the manifest's `quality` label:
manifests loaded from `services/.community/` are third-party whether they say
`community` or `community-verified`. They may **not** use any `bindMounts`
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
`bitbucket.org`, `git.sr.ht`) — defense-in-depth so an admin can't coerce a clone
of a `file://`, `ssh://`, or intranet URL into the service tree.

### Service security rating

Each service component shows a deterministic **security rating** (1–8) computed
from what its manifest declares — published host ports lower it, auth-in-front
and an owned (scoped) database schema raise it, and anything requiring built-in
privileges floors it. It's an at-a-glance signal of how contained a service is
*within* the allowed sandbox; it is not a verdict on the code. Integrations get
no numeric rating because installable integration artifacts are declarative-only;
their companion services use the service rating instead.

### Install-time hardening

Integration artifacts are guarded on several fronts: only HTTPS artifact URLs are
accepted; a SHA-256 pin is mandatory and checked before extraction; artifacts
are capped at 200 MB; tar extraction blocks path-escape (zip-slip), malicious
symlinks/hardlinks, and absolute paths; and an artifact shipping a
`node_modules/` directory is rejected. Backend, POI-source, and frontend runtime
entry points are also rejected; executable behavior must move into an isolated
service. These reduce the blast radius of a
malformed archive — they are not a substitute for trusting the author.

## Updating, uninstalling, and the kill-switch

- **Update** re-pins **all** of a bundle's parts to the latest published version
  through the same orchestrated flow, keeping coupled parts version-consistent.
  The version comes from the extension's own `extension.json` (the manifest the
  catalog points at), not from a number in the catalog — so an extension that
  publishes a moving "latest release" manifest surfaces new releases here
  automatically, and its catalog listing is a one-time inclusion rather than a
  per-release edit.
- **Uninstall** removes exactly what the extension installed — stops and removes
  its service containers, drops the cloned repos and the integrations it placed,
  re-renders compose, and reloads the integration host. Standalone installs of
  the same component are left alone.
- The catalog can carry a **kill-switch**: an extension marked `removed` is hidden
  from Browse (with a banner on installed copies), and one marked `critical`
  shows a blocking security warning on installed copies and refuses new installs.

:::note[An extension-managed service repo is pinned]
Service repos installed as part of an extension are pinned and marked
managed-by-extension. Update them through the extension (which re-pins every part
together), not by hand — a manual refresh of a managed repo is refused to keep
the bundle's coupled parts in agreement.
:::

## Example: OpenConditions

[OpenConditions](https://github.com/openconditions/openconditions) is the
canonical multi-part bundle: a community **service** (`openconditions-ingest`)
writes road-condition observations to the shared database, and a community
**integration** (`road-conditions-openconditions`) surfaces them as a
road-conditions overlay and feeds routing closure-avoidance. It's published as
the first **verified** entry in the curated catalog, so installing it is one
action:

```bash
pnpm openmapx ext install openconditions
```

The orchestrator registers the ingest service at its pinned tag, renders and
starts it (it creates its `conditions` schema and begins ingesting), installs the
overlay integration, and reloads the API — all as one job. For the
author-and-operator walkthrough of how the two pieces are built and bundled into
one `extension.json`, see
[Building an external extension](../developer/building-an-external-extension.md).

## Where to go next

- **[Managing services](../install/managing-services.md)** — enable, render, run,
  and configure any service (built-in or extension-installed) once it's in the
  catalog.
- **[Admin panel](./admin-panel.md)** — where the **Extensions** and **Services**
  sections live, and how admin access works.
- **Developer section** — authoring your own extension, the manifest schemas, the
  `extension.json` bundle format, and the packaging workflow.
