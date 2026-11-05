---
impacts: [security]
---

## What changes

The Data Manager, Transitous runner and Transitous tools images explicitly upgrade
`apt` and `libapt-pkg6.0` to at least Debian Bookworm version 2.6.2. The privacy
backup image enforces Trixie's fixed version 3.0.4 for `apt` and `libapt-pkg7.0`
after its existing distribution upgrade, while keeping PostgreSQL and PostGIS
packages held at their pinned versions. These upgrades fix
[CVE-2026-109518](https://security-tracker.debian.org/tracker/CVE-2026-109518), as
documented in Debian's
[DLA-4880-1](https://lists.debian.org/debian-lts-announce/2026/11/msg00004.html) and
[DSA-6607-1](https://lists.debian.org/debian-security-announce/2026/msg00526.html).
Builds reject repositories that cannot supply that minimum version, and the
changed runtime instructions invalidate cached layers containing older packages.

## Who is affected

Operators using Data Manager, Transitous runner, Transitous tools or privacy
backup images built from the pinned Debian bases before these package upgrades.

## Required action

Receive the fix through a normal image update to a release containing this change.
Operators building custom images should rebuild the affected targets. No settings
or data migration is required.
