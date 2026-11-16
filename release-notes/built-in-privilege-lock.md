---
impacts: [security]
---

## What changes

The core platform services now start with Docker's `no-new-privileges` option,
which community services already had. A process in these containers can no
longer gain privileges through a setuid binary or file capability. This covers
the API, web app, data manager, operations agent, Transitous runner, Traefik,
the well-known file server, PostGIS and Redis. The other bundled engines keep
their previous settings for now.

## Who is affected

All self-hosted installations. The listed containers are recreated on the first
`compose up` after the update, because their configuration has changed.

## Required action

None. The recreate happens as part of the normal update. Installations that
replaced one of the listed services' images with a custom image that runs
`sudo`, `su` or another setuid helper as a non-root user must change that image
to start as the user it needs.
