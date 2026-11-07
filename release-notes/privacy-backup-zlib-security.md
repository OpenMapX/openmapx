---
impacts: [security]
---

## What changes

The privacy-backup image refreshes Debian's zlib and minizip libraries and
requires the fixed package revision for CVE-2026-76844 and CVE-2026-85091.
The build refuses an older mirror result instead of publishing that image.

## Who is affected

Installations using the privacy-backup helper image. PostgreSQL, PostGIS and
libpq remain at the deployment's reviewed versions.

## Required action

Deploy a release containing the updated helper image through the normal update
workflow. No data migration or backup-format change is required.
