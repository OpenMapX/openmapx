---
impacts: [operator-action]
---

## What changes

The API and operations agent no longer read the privacy backup capability key,
the collector image settings or the privacy release evidence settings. Compose
rendering no longer creates `infra/docker/secrets/privacy-backup-capability-key`
or the agent's `privacy-extraction` scratch directory, and release activation no
longer writes `state/ops-agent/releases/evidence`.

## Who is affected

Installations that set any of these variables or still hold these files.

## Required action

After updating, remove `PRIVACY_EXPORT_IMPLEMENTATION_ACTOR_IDS`,
`PRIVACY_EXPORT_EVIDENCE_VERSION`, `PRIVACY_EXPORT_VALIDATION_EVIDENCE_FILE`,
`PRIVACY_ARTIFACT_BACKUP_DISABLED`, `OPS_PRIVACY_BACKUP_COLLECTOR_ENABLED` and
`OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE` from `infra/docker/.env`. You may delete
`infra/docker/secrets/privacy-backup-capability-key`,
`infra/docker/state/ops-agent/privacy-extraction` and
`infra/docker/state/ops-agent/releases/evidence`; nothing reads them.
