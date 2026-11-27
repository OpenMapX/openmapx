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
reason, and the attention list on the overview shows **Safe mode is on**, or
**Safe mode after repeated crashes** when the API turned it on by itself (see
[Automatic safe mode](#automatic-safe-mode)).

Place links of an installed extension whose code the API kept out (safe mode,
a disabled extension, an incompatible release, or extension state that could
not be read) open like links of an integration switched off in its settings:
the place is looked up by its name and coordinates. An extension whose code
ran and failed keeps answering such links with "not found".

## Automatic safe mode

The API turns safe mode on by itself when it stopped without being asked to
three times within ten minutes while installed extension code was loading or
running. It counts a process that crashed with an error nothing handled, one
that was killed (for example for running out of memory) and one the
[event-loop watchdog](#event-loop-watchdog) ended. It does not count:

- a stop that was requested, such as `docker compose stop`, a restart, an
  update or `Ctrl+C`, even when Docker has to kill a slow shutdown;
- a stop before any installed extension started loading, such as a database
  outage, a failed platform migration or a missing setting at startup;
- a stop while an extension's database migrations run, because they run in
  PostgreSQL and not in the API process.

The fourth start then runs in safe mode with the reason `automatic`. The
attention item **Safe mode after repeated crashes** and the notice in
**Admin → Integrations** name the extension's integration that was loading, or
whose code was running when the process failed, when the crashes name one most
often. When the crashes name none, or several equally often, they say that
OpenMapX stopped repeatedly while installed extensions were loading or running;
the end of the API log then names the extension in the error the process
stopped with, or shows `event loop blocked for <n> ms; exiting`.

The API keeps its count in `infra/docker/data/api-runtime/boot-marker.json`,
beside `safe-mode.json`. A marker that cannot be read counts as empty, and one
that cannot be written is logged once; neither stops the API from starting,
but automatic safe mode is then unavailable. Leave automatic safe mode like
any other: it holds until you leave it, and leaving it forgets the crashes
counted so far.

### Event-loop watchdog

An extension can also freeze the API without crashing it, for example with an
endless loop: the process keeps running but answers nothing. Once the API
serves requests, a watchdog thread checks every second that the API's event
loop still turns. When it has not turned for 30 seconds, the watchdog records
in the boot marker the extension that was loading, if one was, writes
`event loop blocked for <n> ms; exiting` to the API log and ends the process.
Docker restarts the container, and the exit counts towards automatic safe
mode like a crash.

- Set `OPENMAPX_EVENT_LOOP_WATCHDOG_MS` in `infra/docker/.env` to change the
  30 seconds (values below 5 seconds are raised to 5 seconds), or to `0` to
  turn the watchdog off, then run `pnpm openmapx compose up`.
- It does not watch the start before the API listens, which includes loading
  the installed extensions and their migrations: an extension that freezes the
  API while it starts leaves it hanging, and
  `pnpm openmapx control safe-mode on` starts it without extensions.
- It stops first when the API is asked to stop, so a slow shutdown is never
  counted as a freeze.
- It stays off while a debugger is attached to the API, and does not mistake
  a suspended host for a frozen API.
- The image starts Node under `tini`; the watchdog does not start, and logs
  why, when Node runs as the container's first process.

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
  without a restart, and forgets the crashes counted so far. The action is
  recorded in the audit log as **Left safe mode**. If that reload fails, safe mode is still left: the extensions it
  held back show **Failed to load** with the reason, and **Reload** on their
  detail page tries again.
- From the host: `pnpm openmapx control safe-mode off`. It removes the
  safe-mode file and clears the crashes counted in the boot marker, then
  restarts the running `api` service.
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
   extensions. After three crashes within ten minutes it has usually done so by
   itself already (see [Automatic safe mode](#automatic-safe-mode)).
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
