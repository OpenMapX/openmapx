---
impacts: [security]
---

## What changes

The Transitous runner image, the only image that ships `gtfsclean`, now compiles
it with Go 1.27.4, which fixes the `crypto/x509` certificate-trust
advisory CVE-2026-111943 and the `net/http` `MaxBytesReader` advisory
CVE-2026-97054. The Go builder remains pinned by image digest.

## Who is affected

Installations using a Transitous runner image built with an earlier Go builder.

## Required action

Deploy the updated image, or rebuild it from the updated Dockerfile.
Restarting containers with an older image retains the older Go binary.
No configuration or data migration is required.
