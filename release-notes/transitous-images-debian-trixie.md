---
impacts: [security]
---

## What changes

The Data Manager and Transitous runner images now build on Debian 13 (Trixie)
instead of Debian 12 (Bookworm), and the Transitous runner, which runs the
catalog scripts, uses Python 3.13 instead of Python 3.11. The newer Python lets
the pinned Transitous catalog requirements
install Soup Sieve 4.1.1, which fixes the selector denial-of-service issues
[CVE-2026-126190](https://github.com/advisories/GHSA-mmhr-3c5m-f64f) and
[CVE-2026-126191](https://github.com/advisories/GHSA-6655-6qjp-jx7x). The
catalog scripts run CSS selectors over HTML fetched from third-party feed
sites. The temporary vulnerability-scan exceptions for Soup Sieve 3.0.1 are
removed.

## Who is affected

Operators running the Data Manager or Transitous runner.

## Required action

Receive the fix through a normal image update to a release containing this change.
Operators who build custom images on top of these images should rebuild them and
expect Debian 13 package names, such as `libssl3t64` and `libapt-pkg7.0`. No
settings or data migration is required.
