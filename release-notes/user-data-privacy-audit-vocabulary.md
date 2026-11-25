---
impacts: [breaking, migration]
---

## What changes

Table and column names in the API database follow one rule, which the schema
hygiene test enforces: singular tables, `<role>_user_id` for a column that
references an account (the acting account is `actor_user_id`), `status` for a
lifecycle column and `<prefix>_ciphertext`, `_iv`, `_tag`, `_key_version` for
an encrypted value. In OpenMapX's user-data, privacy and audit tables,
`actor_id` is now `actor_user_id`, `account_action_receipt.target_id` is
`target_user_id`, `auth_policy_state.activated_by` is `activated_by_user_id`,
`admin_job.created_by` is `created_by_user_id`, `installed_by` is
`installed_by_user_id` on installed extensions and integrations, `updated_by`
is `updated_by_user_id` on system settings and on system, integration and
service secrets, and `state` is `status` on privacy cases, privacy case notifications and
administrator reauthentications. An assisted case's subject locator is stored
as `locator_ciphertext`, `locator_iv`, `locator_tag` and `locator_key_version`.
The privacy case API reports a case's `status` instead of `state`.

The audit log has one vocabulary. Every action is named
`<area>[.<object>].<verb>` with an imperative verb, a singular object and
`snake_case` inside a segment, and records one target type; the database
refuses anything else. Among the renamed actions: `integration.enabled` and
`integration.disabled` are `integration.enable` and `integration.disable`,
`credential.set` and `credential.delete` are `integration.credential.set` and
`integration.credential.delete`, `credentials.export` is `credential.export`,
`settings.update` is `setting.update`, `service.health_check` is
`service.health.check`, `service.images.pull` is `service.image.pull`,
`user.sessions.revoke_all` is `user.session.revoke_all`, a bulk service action
records the same action as a single one (`service.start`, `service.build`, …),
every data operation records `data.operation.run` with the operation as its
target, and the nearby-places actions are `ambient_places.*`. Target types are
`snake_case` (`transit_source`, `auth_policy`, `data_operation`, `setting`, …).
The audit API refuses an unknown action or target type in its filters.
Reauthentication purposes follow the same rule and use the name of the audit
action they confirm (`credential.export`, `credential.import`,
`transit.credential.update`, `user.password_reset.send`,
`user.invitation.send`); admin job types share these names too
(`credential.import`, `system.update`, `system.diagnostics.collect`). Account
action receipts use the mail kinds `email_verification` and `password_reset`.

Privacy case events record one `status_changed` event, whose payload names the
`from` and `to` statuses, instead of one event type per target status. The
database checks event types, actor kinds and operator task sources.

Stored formats carry a version. A snapshot share link records
`snapshot_version` (1) and is read with the parser for its target type and
version; the route payload's `scheduleVersion` is gone. A vehicle's EV
specification and a saved or labelled place's field contributors record their
format in `ev_version` and `field_contributors_version`.

Saved places gain `updated_at`, and labelled places `created_at` and
`updated_at`. Saved places, labelled places and parking refuse coordinates
outside the valid range, and an account has at most one default vehicle.

A place id is `<scheme>:<value>` with a lower-case, hyphenated scheme.
`stylePoi` ids are now `style-poi`, street-level imagery opens a `coordinate`
place, and a coordinate id is `<lat>,<lng>` at six decimals. Ids the web app
invents for one session (`style-poi`, `saved`, `label`, `coordinate`) are no
longer stored with a saved or labelled place: the app sends none, and the API
and the database refuse them. Such a place is recognised as saved or labelled
by position instead: `GET /api/saved/check` accepts `coordinate:<lat>,<lng>`
and matches the rows without a place id at those coordinates. Matching is
exact at six decimals, so two such places within about 0.1 m share their saved
state, and a basemap place saved at one zoom level may read as unsaved at
another: the map's vector tiles place a feature a few metres apart at different
zoom levels (most visibly below z14). Saving it again then adds a second row. A
shared
`?place=stylePoi:…` link still opens at its coordinates.

The data export names its schemas `urn:openmapx:privacy:<name>:1`, and each
manifest member names the one schema it follows (`export-record-1`,
`portable-places-1`, …) or none. The unused category manifest schema is gone.
The manifest, the processing information and every catalogue registration
start at version 1.

## Who is affected

Every database created by an earlier development build. No released
installation exists.

## Required action

Install fresh with an empty database volume, as for the migration baseline.
Saved audit-log filters or scripts that match old action names need the new
names.
