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
operator is not uid 1000:

- change the owner of what an earlier release's containers wrote as uid 1000
  once, as root, with the `sudo chown` commands `pnpm openmapx check` prints:
  they name exactly the entries another uid owns that the stack's containers
  write, and leave out what services running as their image's own user write;
- if `app-api`'s startup log reports a volume an earlier image created for uid
  1000, do not remove it: it holds subject-export ciphertexts the database
  refers to and the runtime-recovery journal. With `app-api` stopped, change
  its owner in place with the command the log prints, for example
  `docker run --rm -v docker_openmapx-subject-exports:/v alpine chown -R 1001:1001 /v`.
