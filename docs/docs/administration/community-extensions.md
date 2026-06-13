---
title: Community extensions
description: Install third-party extensions — community service repositories and Store integrations — and understand the trust trade-offs.
sidebar_position: 4
---

# Community extensions

OpenMapX ships with a large set of first-party services and integrations, but
its plugin model is open: anyone can publish an extension and you can install it
into your own deployment. Extensions arrive through two channels, one per
[plugin layer](../overview/how-it-works.md):

- **Community service repositories** add backend **services** — a database, a
  custom routing engine, an alternative geocoder, a data processor. They are
  registered by Git URL and land in the service catalog alongside the built-ins.
- **Community integrations** add app-level **features** — map overlays, POI data
  sources, transit or geocoding providers, extra API routes. They are installed
  through the **Store** as prebuilt artifacts.

Both are managed from the admin panel (or the `openmapx` CLI) and both can be
installed by the same operator into the same stack. This page covers
*installing* third-party extensions. Writing your own is a separate topic — see
the Developer section.

:::warning[You are running third-party code]
A community extension is code you did not write, running on your server. A
service is a Docker container you choose to start; an integration's backend runs
**in-process inside the API server**, with the same filesystem, network, and
secrets access as a built-in. Neither channel is audited by the OpenMapX
project. Install only from authors you trust, and read the install preview
before you confirm.
:::

## Community service repositories

A **community service repository** is a Git repository that contains one or more
`<slug>/service.json` manifests at its top level. Each manifest follows the same
[service manifest](../developer/service-manifest.md) schema as a built-in service.
Once you register the repository, every valid manifest in it appears in the
service catalog and can be enabled, rendered, and started just like a first-party
service.

### Registering a repository

In the admin panel, open **Services → Repositories → Add repository** and paste
the Git URL. The same flow is available from the CLI:

```bash
pnpm openmapx repos add https://github.com/someone/openmapx-services-foo --yes
pnpm openmapx repos list
```

The URL is validated before anything is cloned. It must be `https://`, and the
host must be on a short allowlist of public Git hosts: `github.com`,
`gitlab.com`, `codeberg.org`, `bitbucket.org`, and `git.sr.ht` (plus the `www.`
forms of GitHub and GitLab). This is a defense-in-depth gate — the endpoint is
already admin-only, but the allowlist keeps an admin from coercing a clone of a
`file://`, `ssh://`, or intranet URL into the service tree.

### The install preview

Before you commit, OpenMapX performs a shallow clone, validates every
`service.json` against the schema, and shows you an **install preview** — one
card per service in the repository. The preview surfaces exactly what the
service will do to your host:

- the service id, name, version, and `quality` tier;
- the **capabilities it provides** (so you know what it adds to your stack);
- **host port bindings** — and any binding that is *not* loopback-only is flagged
  in red as **publicly accessible**, because that port will be reachable from the
  network, not just from the host;
- **reverse-proxy exposure**, if the service asks Traefik to route a public path
  prefix to it;
- requested **Linux capabilities and devices** beyond default container
  privileges;
- **validation errors**, if any manifest is malformed.

If any manifest in the repository fails validation, the whole repository is
refused — there are no partial installs. When the preview is clean, you confirm
by checking the acknowledgment box. The CLI requires the same acknowledgment:
`repos add` proceeds only with `--yes` or an interactive confirmation, and refuses
in a non-interactive session — so a copy-pasted command can't silently register a
repo. Either way, the action is recorded in the audit log.

The manifest validator also constrains what a community service may request:
`quality` must be `community` (or `community-verified`), and such a manifest may
**not** use `@`-prefixed bind mounts (no Docker socket, no cross-service file
sharing), `networkMode: "host"`, `privileged: true`, host device pass-through, or
any escape-class Linux capability (`SYS_ADMIN`, `SYS_PTRACE`, `NET_ADMIN`, and
similar) — only a safe capability subset (`NET_BIND_SERVICE`, `CHOWN`,
`SETUID`/`SETGID`, …) is allowed. Plain relative-path bind mounts under the
service's own directory are fine. `community-verified` is held to the exact same
rules.

### Where they land on disk

A registered repository is shallow-cloned into a directory keyed by a hash of its
URL:

```
services/.community/<url-hash>/
├── foo-engine/
│   └── service.json
└── bar-database/
    └── service.json
```

This directory is gitignored, and the service registry scans it on every render
right after `services/`. Registering the same URL twice collapses to a single
directory. A small `service_repository` row in the database records the URL, the
hash, a display name, and the last-fetched commit.

### Refreshing and removing

A registered repository tracks the remote's default branch. Refreshing pulls the
latest commit and re-validates every manifest; if the upstream pushed a change
that now fails validation, the refresh is rejected and your previous state is
kept:

```bash
pnpm openmapx repos refresh <hash>     # git fetch + reset, then re-validate
pnpm openmapx repos remove <hash>      # unregister and delete the local clone
```

Both are also available under **Services → Repositories** in the admin panel.

:::note[Removing a repo does not stop its containers]
`repos remove` deletes the clone and the database row and reloads the catalog,
but it does not stop any container that was started from one of its services.
Stop those services first if you want a clean tear-down. Once a community service
is in the catalog you enable, build, and run it exactly like a built-in — see
[Managing services](../install/managing-services.md).
:::

## Community integrations (the Store)

A **community integration** is an application feature installed through the admin
**Store**. Unlike services, integrations are installed as **prebuilt artifacts**
— a single `.tar.gz` containing the manifest, a bundled backend ESM module, a
bundled frontend ESM module, and a metadata file with checksums. The API server
never builds at runtime; it only ever unpacks and loads finished artifacts. This
keeps the `app-api` image immutable and makes installs survive a container
restart.

### Browsing the catalog and installing

Open **Store** in the admin panel. It lists entries from one or more **catalog
sources** — HTTPS URLs that return a JSON array of available integrations. The
default source is the OpenMapX community catalog; you can register additional
sources under **Store → Sources** (HTTPS only, no credentials in the URL). The
merged catalog is cached for 24 hours and can be refreshed on demand.

Each entry shows a trust-and-risk disclosure before you install — whether the
integration runs a frontend bundle in the browser, executes backend code in the
API process, makes outbound network calls, uses stored secrets, and which
services it requires. There are two ways to install:

- **From the catalog** — an entry that publishes an artifact URL installs with one
  click. Entries without a published artifact are shown for discovery but cannot
  be installed from the admin surface.
- **From an artifact URL** — the **Install from URL** dialog accepts a manual
  HTTPS link to a `.tar.gz`, with an optional SHA-256 checksum. This is useful for
  a release candidate or an artifact hosted in a private location. When you
  supply a checksum, it is verified before the archive is extracted.

The admin install path is **artifact-only by design** — you cannot install an
integration from a Git source URL through the admin panel, because that would
require build tooling inside the API image. Building an integration from source
is a developer workflow handled by the CLI.

### Where they land on disk

Installed integrations live in:

```
custom_integrations/<id>/
├── manifest.json
└── dist/
    ├── frontend/index.js     # loaded in the browser, when present
    └── backend/index.mjs     # imported by the API server, when present
```

This directory is gitignored and bind-mounted into the `app-api` container, so
installs persist across restarts. A row in the database tracks each installed
integration's id, source, and version.

### After installing

In production, an integration's backend code is loaded into the API server's
module cache at startup. After installing, updating, or removing one, restart the
API server so the new code takes effect — the Store's job log surfaces this hint
when it applies:

```bash
pnpm openmapx services restart app-api
```

Updates and removals are also driven from the Store. A catalog-managed
integration that has a newer published version shows an available update;
artifact-URL installs are refreshed by re-installing from a fresh URL.

### Install-time hardening

Artifact installs are guarded on several fronts: only HTTPS artifact URLs are
accepted from the admin surface; an optional SHA-256 is checked before
extraction; artifacts are capped at 200 MB; tar extraction blocks path-escape
(zip-slip), malicious symlinks and hardlinks, and absolute paths; and an artifact
that ships a `node_modules/` directory is rejected outright. These reduce the
blast radius of a malformed archive — they are not a substitute for trusting the
author of the code you run.

## Choosing a channel

| You want to add…                                              | Use…                            |
| ------------------------------------------------------------- | ------------------------------- |
| A backend daemon — database, routing engine, geocoder, worker | A community **service repository** |
| An app feature — overlay, data source, transit/geocoding provider, API route | A community **integration** via the **Store** |

## Where to go next

- **[Managing services](../install/managing-services.md)** — enable, render, run,
  and configure any community service after you have registered its repository.
- **[Admin panel](./admin-panel.md)** — where the **Store** and **Repositories**
  sections live, and how admin access works.
- **How it works** — the two plugin layers, in
  [the overview](../overview/how-it-works.md).
- **Developer section** — authoring your own service repository or community
  integration, the manifest schemas, and the artifact packaging workflow.
