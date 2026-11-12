---
impacts: [operator-action]
---

## What changes

The stack's own containers (`app-api`, `ops-agent`, `data-manager`, MOTIS,
Transitous and Elasticsearch) run as the deployment's user, `UID:GID` from
`infra/docker/.env`, with no fallback uid, so the admin panel's configuration
changes and the deployment's secrets work whatever the operator's uid.

A render on the host, `pnpm openmapx compose render`, writes `UID` and `GID`
into `.env` from the checkout's owner when they are missing; explicit values
are kept. The operations agent only reads them (see the note on the agent
reading `.env`). A render refuses to run as a uid other
than `UID`, and to take the user from a checkout root owns. `pnpm openmapx
check` and **Run diagnostics** report when `.env`, the checkout's owner or the
running containers disagree.

## Who is affected

Every Docker deployment.

## Required action

Run renders and stack commands as the checkout's owner.
