---
impacts: [breaking]
---

## What changes

Self-service privacy exports no longer depend on release approvals or a build
fingerprint; they run as soon as a case's own source tasks allow it. Release
manifests list six application images and carry no privacy validation evidence.
The `privacy-backup` collector image, automated per-person backup extraction,
backup and omission reviews, and receipt snapshots are gone, along with the
privacy admin readiness, approval and backup review endpoints. Retained backups
are handled manually by the operator, and the privacy page and each export's
response report state the backup policy.

## Who is affected

Operators of every installation. An operations agent from an earlier release
cannot select a release published after this change.

## Required action

Update the operations agent from the host before selecting a new release, as
described in the upgrading guide.
