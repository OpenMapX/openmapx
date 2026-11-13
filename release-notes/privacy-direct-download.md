---
impacts: [breaking, operator-action]
---

## What changes

The data-subject export is now a direct download. A signed-in person who
signed in within the last ten minutes downloads the ZIP archive straight from
**Account settings**; nothing is stored on the server. The stored, encrypted
export artifacts, their key ring, the `openmapx-subject-exports` volume, the
background export runner, regenerate and revoke, and the export
reauthentication cookie are gone.

Requests use five states (`open`, `in_progress`, `waiting_on_requester`,
`completed`, `refused`). Identity evidence, attachments, the email identity
challenge, representative authority review and task assignment are removed;
an administrator records a manual identity check with a reason code instead.
Each new request alerts every administrator by email, and each request due
soon or overdue sends one reminder per administrator.

The `privacy_admin` role is removed. Privacy casework now requires a full
administrator.

## Who is affected

Every installation. Former privacy caseworkers become ordinary users. API
clients of the removed privacy routes (`/api/privacy/data-requests` creation,
artifact download, reauthentication, regenerate, assisted account-login proof,
the admin identity, email-challenge, attachment, assignment, operator and role
routes) get 404.

## Required action

After updating, optionally remove what the API no longer reads:

- the secret file `infra/docker/secrets/subject-exports-master-key`;
- the Docker volume `openmapx-subject-exports` (`docker volume rm
<project>_openmapx-subject-exports`);
- the environment variables `OPENMAPX_EXPORTS_KEY`, `OPENMAPX_EXPORTS_KEY_FILE`,
  `OPENMAPX_EXPORTS_KEY_UID`, `OPENMAPX_EXPORT_STORAGE_DIR`,
  `PRIVACY_RUNNER_INTERVAL_MS`, `PRIVACY_RUNNER_MAX_ATTEMPTS`,
  `PRIVACY_RUNNER_RETRY_DELAY_MS`, `PRIVACY_RUNNER_DEFER_DELAY_MS`,
  `PRIVACY_ESCALATION_INTERVAL_MS`, `PRIVACY_ESCALATION_RECIPIENT_USER_IDS`,
  `LEGAL_IDENTITY_EVIDENCE_RETENTION_DAYS` and
  `LEGAL_EXPORT_ARTIFACT_RETENTION_HOURS`.

`PRIVACY_DEADLINE_REMINDER_INTERVAL_MS` replaces the escalation interval.
Assisted requests encrypt the requester's locator with the existing
`OPENMAPX_SECRETS_KEY`. Give a person who used `privacy_admin` the `admin` role
if they should keep handling privacy cases.
