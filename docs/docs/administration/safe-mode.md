---
title: Safe mode and recovery
description: Start the API without installed extensions, disable an extension that stops the API, and leave safe mode again.
sidebar_position: 5
---

# Safe mode and recovery

An installed extension's backend code runs inside the API process. When that
code keeps the API from starting, or stops it shortly after, **safe mode**
starts the API without any installed extension, so the administration, the map
and the built-in integrations work while you deal with the extension.

## What safe mode does

- **Not loaded:** the backend code of every installed extension. Its migrations
  do not run, its scheduled tasks do not start and its personal-data handlers do
  not run. Its integrations are absent from the public integration list and
  from every provider chain.
- **Loaded as usual:** every built-in integration, the administration, accounts,
  services and their containers. An extension's containers keep running; only
  its code inside the API is left out.
- **Kept:** each installed integration stays listed in **Admin → Integrations**
  with its manifest and the chip **Safe mode**, its settings and credentials
  stay stored, and accounts deleted in the meantime are still recorded, so the
  extension erases their data once it runs again.
- **Lasting:** safe mode holds across reloads of the integrations. Only leaving
  it, or a restart without the safe-mode file and without
  `OPENMAPX_SAFE_MODE=1`, ends it.

While safe mode is on, **Admin → Integrations** shows a notice that names the
reason, and the attention list on the overview shows **Safe mode is on**.
Safe mode that started because the API stopped repeatedly names the extension
that was loading when that is known; otherwise the notice says that OpenMapX
stopped repeatedly while starting, and the API log names the extension.

Place links of an installed extension whose code the API kept out (safe mode,
a disabled extension, an incompatible release, or extension state that could
not be read) open like links of an integration switched off in its settings:
the place is looked up by its name and coordinates. An extension whose code
ran and failed keeps answering such links with "not found".

## Turn safe mode on

From the host, in the checkout, as the deployment's user:

```bash
pnpm openmapx control safe-mode on
```

This writes `infra/docker/data/api-runtime/safe-mode.json` first, so the next
start of the `api` service honours it whatever happens afterwards. When the
`api` container is running, the command then restarts it under a lease on the
`api` service; when another operation holds that service, the command prints
the holder and exits non-zero, and the file still takes effect at the next
start. The command does not need the API, so it works while the API is down or
restarting in a loop. Each use is appended to
`infra/docker/state/ops-agent/control-audit.jsonl` and printed.

To force safe mode through the environment instead, set `OPENMAPX_SAFE_MODE=1`
in `infra/docker/.env` and run `pnpm openmapx compose up`. Safe mode forced this
way cannot be left from the administration or with `control safe-mode off`.

## Leave safe mode

Fix or disable the extension that caused the problem first (see below), then
choose one of:

- **Admin → Integrations → Leave safe mode.** After you confirm, the API
  removes the safe-mode file and loads the installed extensions at once,
  without a restart. The action is recorded in the audit log as **Left safe
  mode**. If that reload fails, safe mode is still left: the extensions it
  held back show **Failed to load** with the reason, and **Reload** on their
  detail page tries again.
- From the host: `pnpm openmapx control safe-mode off`. It removes the
  safe-mode file and the boot marker, then restarts the running `api` service.
  It refuses with exit code 1 while `OPENMAPX_SAFE_MODE=1` is set.
- When `OPENMAPX_SAFE_MODE=1` is set: remove it from `infra/docker/.env` and
  run `pnpm openmapx compose up`.

If an installed extension stops the API again, turn safe mode on again and
disable that extension.

## Disable an extension without the API

When the API does not start because of an extension, disable that extension in
the database directly. The database must be running:

```bash
pnpm openmapx extensions disable <extension-id> --offline
pnpm openmapx services restart api
```

`--offline` runs on the host, needs neither the API nor an administrator
session, and only marks the extension disabled; it stops no container. At the
next start the API leaves its integrations out, and they show the chip
**Extension disabled** in **Admin → Integrations**. The command exits non-zero
with `No installed extension <id>` for an id that is not installed, and with
`The database is not running; use: openmapx control safe-mode on` when the
database container is down.

The extension id is the one **Admin → Extensions** and
`pnpm openmapx extensions list` show, not an integration id. `ext` remains an
alias of the `extensions` command group. Without `--offline`, the command
currently prints `Pass --offline to disable an extension without the API`.

Enabling a disabled extension again is not offered yet: an update keeps it
disabled, while removing it and installing it again starts it enabled and keeps
its data.

## When the API does not start because of an extension

1. Read the end of the API log (`docker compose logs api` from
   `infra/docker`): a failing extension is named in a line such as
   `Leaving out installed integration <id>` or in the error the process stopped
   with.
2. Run `pnpm openmapx control safe-mode on`. The API starts without installed
   extensions.
3. Disable the extension from the host:
   `pnpm openmapx extensions disable <extension-id> --offline`.
4. Leave safe mode from **Admin → Integrations** or with
   `pnpm openmapx control safe-mode off`.
5. Remove the extension, or keep it disabled until a fixed version is
   available.

## Other states in the integration list

| Chip                   | Meaning                                                                                                                                               | What to do                                                                           |
| :--------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------- |
| **Safe mode**          | The API runs in safe mode.                                                                                                                            | Leave safe mode once the cause is fixed.                                             |
| **Extension disabled** | An operator disabled the extension the integration belongs to.                                                                                        | See [Disable an extension without the API](#disable-an-extension-without-the-api).   |
| **Not compatible**     | This OpenMapX release cannot run the extension; the detail page names the version it needs, for example `requires platform 2.0, this is 1.0`.         | Update OpenMapX, or install a version of the extension made for this release.        |
| **Failed to load**     | The extension's code failed to import, migrate or set up, or the API could not read which extensions are disabled (`could not read extension state`). | Fix or update the extension; for the extension state, check the database and reload. |

When the API cannot read which extensions are disabled, it retries once after
five seconds at startup and then loads no installed extension in that
generation, so an extension disabled because it stopped the API never loads by
accident.
