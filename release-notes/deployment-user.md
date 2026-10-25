---
impacts: [migration, operator-action]
---

## What changes

The stack's own containers (`app-api`, `ops-agent`, `data-manager`, MOTIS,
Transitous and Elasticsearch) run as the deployment's user, `UID:GID` from
`infra/docker/.env`, with no fallback to uid 1000. `app-api`, which always ran
as uid 1000, now runs as that user too, so a host whose operator is not uid
1000 can use the admin panel's configuration changes and its own secrets.

Every render, the host's `pnpm openmapx compose render` and the operations
agent's, writes `UID` and `GID` into `.env` from the checkout's owner when they
are missing; explicit values are kept. A render refuses to run as a uid other
than `UID`, and to take the user from a checkout root owns. `pnpm openmapx
check` and **Run diagnostics** report when `.env`, the checkout's owner, the
running containers or the paths they write disagree.

## Who is affected

Every Docker deployment. Where the checkout's owner is uid 1000, the
containers keep their user and nothing else changes.

## Required action

Run renders and stack commands as the checkout's owner. On a host whose
operator is not uid 1000, follow what `pnpm openmapx check` reports: change the
owner of files an earlier release wrote as uid 1000 once, as root, with the
`sudo chown -R` it prints, and remove an `app-api` volume an earlier image
created for uid 1000 while `app-api` is stopped.
