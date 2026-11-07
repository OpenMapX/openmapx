---
impacts: [security]
---

## What changes

The ops-agent image refreshes Docker CLI to Alpine's fixed 29.9.3-r0 release or
later, addressing CVE-2026-116587 and CVE-2026-116591. The package-version check
also prevents a cached older package layer from passing a release build.

## Who is affected

Self-hosted installations using the ops-agent image. This updates the container's
Docker client, not the host Docker daemon.

## Required action

Install a qualified OpenMapX release containing this change through the normal
update workflow. No configuration or data migration is required.
