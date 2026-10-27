---
impacts: [operator-action]
---

## What changes

The operations agent no longer writes `infra/docker/.env`. Only a render on the
host, `pnpm openmapx compose render`, writes `UID` and `GID` there from the
checkout's owner when they are missing; explicit values are kept, as before.
The agent, and so the admin panel, only reads them.

Where `.env` sets no `UID` or `GID`, the agent says so in its log when it
starts and keeps running. Its renders and the admin panel's configuration
changes refuse, and **Run diagnostics** reports it, each naming the host render
that writes them. `.env` is never created or changed by the agent.

## Who is affected

Only a deployment whose `.env` still sets no `UID` or `GID`. Every host render
since the release that introduced the deployment's user wrote them, and so did
the agent of that release when it started, so most deployments already have
both.

## Required action

Before this release's agent starts, `.env` must set `UID` and `GID`. This
release is installed with a host update, whose render writes them. If the
agent's log or **Run diagnostics** reports them missing, run
`pnpm openmapx compose render` on the host as the checkout's owner.
