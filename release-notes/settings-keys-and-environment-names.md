---
impacts: [breaking, operator-action]
---

## What changes

Every system setting has a dotted key, and the environment variable that may
set it is derived from that key: the segments joined with `_`, each camelCase
word split, upper-cased (`email.fromAddress` is `EMAIL_FROM_ADDRESS`). One
resolver reads every setting in the same order: a set variable, then the value
stored in the administration, then the default. An empty variable counts as
unset, booleans accept exactly `true`, `false`, `1` or `0`, and the API refuses
to start, naming the variables, when one holds a value its setting does not
accept. A stored value outside a setting's range is refused by the features
that read it instead of falling back to the default; the API still starts, logs
the setting, and the administration marks it so a valid value can be saved.
Only known keys can be stored.

Renamed environment variables:

| Before                                                                                                         | After                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_FROM`                                                                                                   | `EMAIL_FROM_ADDRESS`                                                                                                                                                                        |
| `SMTP_PASS`                                                                                                    | `SMTP_PASSWORD`                                                                                                                                                                             |
| `SMTP_SECURE`                                                                                                  | `SMTP_SECURITY` (`starttls`, `tls` or `none`; see below)                                                                                                                                    |
| `MAPTILER_KEY`                                                                                                 | `MAPTILER_API_KEY`                                                                                                                                                                          |
| `AUTH_EMAIL_VERIFICATION`                                                                                      | `AUTH_EMAIL_VERIFICATION_REQUIRED`                                                                                                                                                          |
| `OPENMAPX_ALLOW_NONCOMMERCIAL`                                                                                 | `DATA_USE_ALLOW_NON_COMMERCIAL`                                                                                                                                                             |
| `OPENMAPX_ALLOW_GREY_AREA`                                                                                     | `DATA_USE_ALLOW_GREY_AREA`                                                                                                                                                                  |
| `LEGAL_NAME`, `LEGAL_STREET`, `LEGAL_POSTAL_CODE`, `LEGAL_CITY`, `LEGAL_COUNTRY`, `LEGAL_EMAIL`, `LEGAL_PHONE` | `LEGAL_CONTROLLER_NAME`, `LEGAL_CONTROLLER_STREET`, `LEGAL_CONTROLLER_POSTAL_CODE`, `LEGAL_CONTROLLER_CITY`, `LEGAL_CONTROLLER_COUNTRY`, `LEGAL_CONTROLLER_EMAIL`, `LEGAL_CONTROLLER_PHONE` |
| `LEGAL_SUPERVISORY_AUTHORITY`                                                                                  | `LEGAL_SUPERVISORY_AUTHORITY_NAME`                                                                                                                                                          |
| `LEGAL_SERVER_LOG_RETENTION_DAYS`                                                                              | `RETENTION_SERVER_LOG_DAYS`                                                                                                                                                                 |
| `LEGAL_DSAR_CASE_RETENTION_DAYS`                                                                               | `RETENTION_PRIVACY_CASE_DAYS`                                                                                                                                                               |
| `AUDIT_LOG_RETENTION_DAYS`                                                                                     | `RETENTION_AUDIT_LOG_DAYS`                                                                                                                                                                  |
| `ADMIN_JOB_RETENTION_DAYS`                                                                                     | `RETENTION_ADMIN_JOB_DAYS`                                                                                                                                                                  |
| `BACKUP_RETENTION_DAYS`                                                                                        | `RETENTION_BACKUP_DAYS` (also read by the operations agent and the CLI)                                                                                                                     |

The audit-log and admin-job periods are now settings that can also be changed
at `/admin/privacy-setup`; the backup period remains set only by the environment
or the platform configuration, since the operations agent and the CLI share it.
Every variable that sets a setting now reaches the API container; before, the
`LEGAL_*`, data-use and email-verification variables did not.

The SMTP setting `smtp.security` replaces the boolean "Use TLS / STARTTLS",
which a Compose install never applied. `starttls` (the default, for port 587)
upgrades the connection and refuses to send without encryption, `tls` (port 465) encrypts from the start, and `none` sends unencrypted.

Removed: the unread settings Instance URL (`PUBLIC_URL`), Default Locale
(`DEFAULT_LOCALE`) and Default Map Center, the unread `LEGAL_JURISDICTION_CITY`,
and Instance Name (`INSTANCE_NAME`), which only titled the test email. The
desired platform configuration is stored as `platform.configuration`.

## Who is affected

Every deployment and development setup with a `.env` that sets one of the
renamed or removed variables. No released installation exists.

## Required action

Rename the variables in `infra/docker/.env` and `apps/api/.env` as listed and
remove the deleted ones, then run `pnpm openmapx compose render`. Set
`SMTP_SECURITY=tls` for a server that expects encryption from the first byte
(port 465). Recreate development databases from the new baseline; settings
stored under the former keys are not read.
