---
impacts: [breaking, operator-action]
---

## What changes

The update system's state formats are fixed for launch, so later releases can
take over an installation in place:

- The operations agent's job journal is `infra/docker/state/ops-agent/jobs.json`.
  Its file, its rows' execution version, the operations protocol, community
  repository records and the release service-file index all start at version 1.
  A generation's `resolved-config.generated.json` carries `version: 1`. So do
  the execution fingerprints and terminal receipts the agent and data-manager
  record, data-manager's feed proxy validation record, the agent's
  configuration source witness, the ambient places publication and its
  policy, the Overture conflation operation in the admin catalogue, the
  erasure journal, an administrative job's recorded agent operations, the
  Transitous feeds overlay (`data/overrides/feeds-overlay.json`, whose
  `version` is now `1`) and the offline package request key.
- A release manifest's stored copy keeps any top-level field a later release
  adds, so that release reads back what it published under the same digest.
  It keeps only the five pinned images.
- The agent no longer refuses to start on journal rows another release wrote
  (after an update or a rollback). Each row's identity must still parse; a row
  whose operation, result or execution the running release cannot read is kept
  as written until its retention ends. A caller asking for it gets the new
  `other_release` error, and one that had not finished fails as
  `recovery_required`. The agent logs how many such rows it kept at start.
- A finished configuration apply also records a small settlement (what it
  committed) in a form every release reads. An update whose new agent cannot
  read the old agent's full result still completes from it instead of ending
  as needing recovery.
- Release manifests are read strictly only for what is authorised from them:
  the schema version, the release id, the five image references,
  `databaseMigrationHead` (now required) and the new required `stateEpoch`.
  Producer, build and product metadata may gain or change fields. Product
  versions and `OPENMAPX_RELEASE` accept stable versions such as `v1.0.0`.
- A release that cannot take over an installation's state in place carries a
  new `stateEpoch`. `compose release --check`, System → Updates and
  `system update` refuse it on an installation of another epoch, with the new
  `release_state_epoch` error, and say to install it fresh.
- The API migration step before an update requires the image's `dist/migrate.js`;
  an image without it fails the update.

## Who is affected

Every installation created before this release. Fresh installations are not
affected.

## Required action

Install fresh from this release with an empty API database and an empty
`infra/docker/state`. Do not upgrade an existing installation in place and do
not rename its journal: no earlier record is converted.
