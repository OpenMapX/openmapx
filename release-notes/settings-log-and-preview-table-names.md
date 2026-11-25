---
impacts: [breaking, migration]
---

## What changes

Several API database tables and columns follow the naming rules of the rest of
the schema:

- `system_settings` is now `system_setting`, and its `updated_at` is required.
- `app_logs` is now `app_log`; its `msg` column is `message` and its `id` is a
  64-bit identity. `health_history.id` is a 64-bit identity too.
- `account_mail_outbox.state` is now `status`, and its `kind` values are
  `email_verification`, `password_reset` and `password_setup`, from the one
  account mail vocabulary.
- `actor_id` is now `actor_user_id` on `configuration_migration_preview`,
  `platform_configuration_preview` and `transit_credential_preview`.

The administrator log API (`GET /api/admin/logs`) returns each entry's text as
`message` instead of `msg`.

## Who is affected

Development databases, and scripts or SQL that name the old tables, columns or
the `msg` field. No released installation exists.

## Required action

Recreate development databases from the new baseline and update queries that
use the old names.
