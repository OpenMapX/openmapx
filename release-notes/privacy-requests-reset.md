---
impacts: [migration]
---

## What changes

Migrations `0058_remove_privacy_admin_role`,
`0059_privacy_five_states_direct_download`,
`0060_drop_privacy_request_columns` and
`0061_allow_privacy_export_reauthentication` move privacy requests to the
five-state model. They delete every existing privacy request (with its
events, tasks, retention holds and notifications) instead of converting it,
drop the `data_export_artifact`, `data_export_reauthentication`,
`data_subject_request_identity`, `data_subject_request_email_challenge` and
`data_subject_request_attachment` tables, demote `privacy_admin` accounts to
`user`, and allow the `privacy.export` administrator reauthentication purpose.

## Who is affected

Every installation that applies the migrations. Existing privacy cases are
removed.

## Required action

Answer or record any open privacy request outside OpenMapX before updating;
the migration runs before the API starts and does not keep old cases.
