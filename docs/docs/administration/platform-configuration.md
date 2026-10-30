---
title: Platform configuration
description: Review and apply domain, TLS contact, release and retention settings with explicit ownership and recoverable jobs.
sidebar_position: 3
---

# Platform configuration

Open **Admin → Settings → Platform configuration**. The form shows effective values
and their current source. Host-owned fields are locked. Choose **Manage … in UI**
to adopt a supported field, or **Return … to host** to use the current host value
again. Editing and previewing do not save or restart anything.

| Field              | Host default                                | When an applied change takes effect                                                            |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Domain             | `DOMAIN`, otherwise `localhost`             | Coordinated routing, API/auth origin and web runtime configuration                             |
| ACME contact email | `ACME_EMAIL`, otherwise `admin@example.com` | Applied certificate configuration                                                              |
| Release selector   | `OPENMAPX_RELEASE`, otherwise `main`        | The next explicit release check/selection; existing image pins stay selected                   |
| Default region     | `OPENMAPX_REGION`, otherwise unset          | Subsequent data/build operations without an explicit region; deployment allowlists still apply |
| Backup retention   | `BACKUP_RETENTION_DAYS`, otherwise 30 days  | Subsequent creation, restore validation and scheduled/manual pruning                           |

Use **Preview changes** to review the exact origin, affected services and warnings.
The preview expires after ten minutes. Changing the draft invalidates the preview.
Apply uses that exact preview and current configuration revision. A source, policy
or revision conflict requires a new preview; a failed request preserves the draft.
Service resource fields remain in the individual service configuration form. See
[Operator settings and resource limits](./services-administration.md#operator-settings-and-resource-limits).

## Changing the domain

Prepare DNS and TLS, update OAuth callback URLs, and arrange recovery for passkeys
bound to the old domain. The preview lists the new address. Keep host access and
an alternate login available before applying.

Confirm the listed acknowledgments and verify a fresh supported password login
with the account's effective second factor. A passkey-only or OAuth session cannot
authorize this change. Establish and prove the supported alternate login first.
The sign-in confirmation is bound to the exact preview and cannot be reused for
another domain or policy. Return to Settings after sign-in to complete the review.

After applying, reconnect at the reviewed admin address. Browser disconnection is
an observation failure, not cancellation or evidence that the change failed.

## Operation status and recovery

Accepted changes are durable jobs. Settings reconnects to retained platform jobs;
Activity shows the original job, outcome and logs. The application coordinates the
configuration generation, Data Manager guard, protected service helper and image
verification before reporting completion. The agent is replaced last during a
checked release update. Images must provide the supported configuration helper;
older installations receive a host-upgrade prerequisite before application.

A cancel request does not undo an already committed update. If work has committed,
the original verified completion wins. A failed pull, interrupted helper, missing
mount or uncertain publication can leave the operation fenced as requiring recovery.
The system does not claim a rollback from an error message or an old overlay alone.
It releases ownership only after proving the original operation settled.

Inspect the original job and host ops-agent journal. Do not delete locks, fabricate
completion, or submit repeated fresh updates while an outcome is unknown. Restore
connectivity and observe the original operation; where exact recovery is unavailable,
use host access to diagnose and recover the deployment. Initial Docker installation,
bootstrap credentials, offline agent recovery and destructive full-stack shutdown
remain host operations. The UI does not expose arbitrary environment variables,
mount paths, executable options or Docker socket access.
