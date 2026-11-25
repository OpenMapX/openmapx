---
impacts: [breaking, security, migration]
---

## What changes

Every value the API stores encrypted now records the version of the key it was
written with (`key_version`, currently 1) and is bound to the row that holds
it. The binding names the table and the row's natural key, for example
`system_secret:<key>` or `integration_secret:<integration id>:<key>`, as
additional authenticated data, so a ciphertext copied into another row no
longer decrypts. A value with an unknown key version is refused.

This covers `integration_secret`, `service_secret`, `system_secret`,
`personal_timeline_connection` (whose columns are now `api_key_ciphertext`,
`api_key_iv`, `api_key_tag` and `api_key_key_version`), `account_mail_outbox`,
`transit_credential_preview`, `configuration_migration_preview` and assisted
privacy-request locators.

## Who is affected

Development databases that hold secrets written before this change. No released
installation exists.

## Required action

Recreate development databases from the new baseline and enter stored
credentials again. Values written before this change cannot be read.
