---
impacts: [security]
---

## What changes

The data-manager, Transitous runner and Transitous tools images now compile
`gtfsclean` with Go 1.27.3, which fixes the `crypto/x509` certificate-trust
advisory CVE-2026-111943. The Go builder remains pinned by image digest.

## Who is affected

Installations using any of these three images built with the previous Go
1.27.2 builder.

## Required action

Deploy the updated images, or rebuild them from the updated Dockerfiles.
Restarting containers with an older image retains the older Go binary.
No configuration or data migration is required.
