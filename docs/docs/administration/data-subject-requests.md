---
description: Configure privacy operations and handle access and portability requests.
sidebar_position: 4
title: Data-subject requests
---

# Data-subject requests

People start Article 15 access and Article 20 portability requests from Account
settings or the published privacy contact. Operators handle cases at
`/admin/privacy`, which requires an `admin` account. The deployment owner
remains responsible for controller facts, processor instructions, deadlines and
independent review. A working export is not a compliance certificate.

## Request states

Every request is in one of five states:

| State                  | Meaning                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `open`                 | Received; the requester's identity is not yet verified       |
| `in_progress`          | Identity is known and the case is being worked               |
| `waiting_on_requester` | The operator asked the requester for something               |
| `completed`            | Answered, or withdrawn by the requester (reason `withdrawn`) |
| `refused`              | Refused with a recorded reason code                          |

Allowed moves: `open` to `in_progress`, `waiting_on_requester` or
`refused`; `in_progress` to `waiting_on_requester`, `completed` or `refused`;
`waiting_on_requester` to `in_progress`, `completed` or `refused`. `completed`
and `refused` are final and release the case's retention holds. Every move is
recorded as a case event with its reason code.

## Self-service download

A signed-in person selects **Download my data** in Account settings. The API
accepts the export only after a recent interactive sign-in (within ten minutes,
including a configured second factor). Otherwise it answers
`FRESH_SIGN_IN_REQUIRED`; the web app sends the person through a new sign-in
and continues the download when they return. That fresh sign-in is the
identity proof, so a self-service request starts `in_progress`.

The export creates the request, or reuses the person's active one of the same
kind, including an assisted case an administrator linked to the account, collects
every source and then streams the ZIP archive straight to the browser with
`Cache-Control: private, no-store`. Nothing is stored on the server. While the
archive is assembled, large sources pass through a short-lived encrypted spool
in the temporary directory with a per-process key; it is removed when the
download ends. If the download is interrupted, the request stays
`in_progress` and the person can download again.

The archive contains the full scope and the Article 15(1) information:
purposes, categories, recipients, retention, sources, rights and the
supervisory authority. Sources that only an operator can check
(`application-logs`, `redis-subject-controls`,
`data-manager-trigger-attribution`, `backup-retained-copies` and
`off-host-processor-sources`) do not block the download; the report lists them
as checked separately by the operator.

## Working a case in Privacy requests

Open **Privacy requests** at `/admin/privacy` with a real administrator
session. A version conflict retains your current draft, reloads the case and
requires another explicit confirmation.

- **Identity:** a self-service request is proven by the fresh sign-in. An
  assisted request linked to the person's account can be verified the same
  way: ask them to sign in and select **Download my data**. The fresh sign-in
  verifies the open case of the same kind (recorded as an `identity_verified`
  event with reason `account_session`), moves it to `in_progress` and
  downloads the export for that case. Otherwise, check the requester's
  identity outside OpenMapX (for example by letter), then record **Verify
  identity** with a reason code. This moves the case from `open` or
  `waiting_on_requester` to `in_progress`. A representative's authority is
  checked the same way and recorded in the reason code.
- **Operator-held sources:** each request has one task per source that only an
  operator can check. Check it outside OpenMapX and resolve it with one action
  and a reason code. A self-service request stays `in_progress` after the
  download until every task is resolved.
- **Deadlines and decisions:** inspect the original deadline and controller
  time zone. Record the actual notification time before extending a deadline;
  extensions cannot exceed two calendar months after the original deadline.
  Completion requires every task to be resolved, and refusal requires
  confirmation. Completing or refusing notifies a requester who has an account.
- **Export for an assisted request:** after a manual **Verify identity**,
  **Download export** streams the same archive for the case's subject account.
  It needs a fresh, purpose-bound administrator sign-in (`privacy.export`) for
  that case, used once. A case verified by the account holder's own sign-in
  cannot be exported by an administrator: that sign-in proves who holds the
  account, not who sent the request, and the account holder already received
  the archive themselves. An assisted request that names someone only by email
  or another reference has no account to export; answer it manually.
- **Backups:** retained backups are not searched automatically. Follow the
  [manual restore runbook](./backup-and-restore.md#manual-backup-export-for-a-privacy-request)
  and resolve the `backup-retained-copies` task with its outcome.

Capability hints do not grant authority. Every mutation and byte response
checks the current server state.

## Notifications

Requesters with an account receive an acknowledgement and an email when their
request waits on them, is extended, completed or refused. Each active
administrator receives an alert for every new request, including assisted
requests without a subject account, and one reminder per request when its
deadline is near or past. Emails contain no request identifiers, links or
personal data.

## Initial setup

Sign in as an administrator and open **Privacy setup** at
`/admin/privacy-setup`. Enter the controller's name and postal address,
request contact, jurisdiction and supervisory authority. Configure the existing
email provider and use its explicit test action to check delivery. Review the
case retention (3 years by default) and declare the deployment's additional
sources. Environment values override saved settings and appear locked in the
editor. Public legal pages refresh their cached facts within about a minute.

Assisted requests store the requester's locator encrypted with
`OPENMAPX_SECRETS_KEY`. No other key or storage volume is needed.

## Operational checks

Configure the controller facts, privacy sources and retention settings before
the first request; an incomplete configuration answers exports with
`PRIVACY_CONFIGURATION_INCOMPLETE`. Investigate stale cleanup or notification
health, export failures (`privacy_export_failures`) and overdue cases. Case
retention cleanup runs hourly.

## Intake

The API records receipt time, locale, time zone, request type and a response
deadline. A request creates its case, the operator-held source tasks and
retention holds that keep matching source rows until the case closes.
Short-lived categories, such as sign-in verifications, sessions and rate-limit
controls, may expire under their own retention between the request and the
export; the response report names them.

The OpenMapX export uses one repeatable-read database snapshot. It includes
explicit, ownership-filtered OpenMapX projections and data from a connected
managed Dawarich instance. Independent controllers, off-host systems and
operator-held sources are never represented as searched.

Use the intake form for inaccessible or deleted accounts. Supply the exact
locator and the actual receipt time; do not create a replacement account. Case
updates use versions and idempotency keys; reload after a conflict rather than
applying a stale decision. Do not use free-text scans to match a person.

## Browser-only supplement

The **Download browser data** action creates a separate local JSON file. It
contains only an allowlisted preference snapshot and offline-map metadata. It
is never uploaded; cookies, sessions, query caches, credentials and raw map
archives are intentionally excluded.

## Operator checklist

1. Confirm the request scope. For an assisted request, check the identity
   outside OpenMapX and record it with a reason code.
2. Check every operator-held source and resolve its task with a reason code.
3. For an assisted request with an account, download the export and send it
   through the agreed channel.
4. Complete the request, or record a refusal with its reason.
5. Retain only the case records required by the configured legal retention.

## Legal references and review boundary

This implementation is a technical aid and does not replace a controller’s
legal assessment. Operators should review the current text of the [GDPR
(Regulation (EU) 2016/679)](https://eur-lex.europa.eu/eli/reg/2016/679/oj), in
particular Articles 12 (transparent communication), 15 (access), 20
(portability), 23 (lawful restrictions) and 30 (records of processing), before
enabling a deployment-specific workflow.

The response and redaction design follows the [EDPB Guidelines 01/2022 on the
right of access](https://www.edpb.europa.eu/documents/guideline/guidelines-012022-on-data-subject-rights-right-of-access_en).
The [CJEU judgment in C-487/21 (Österreichische Datenschutzbehörde and
CRIF)](https://curia.europa.eu/site/upload/docs/application/pdf/2023-05/cp230071en.pdf)
addresses when a faithful copy of source material is necessary, while [CJEU
judgment C-154/21 (RW v Österreichische Post)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A62021CJ0154)
addresses information about actual recipients. For German deployments, also
check the applicable [BDSG provisions, including Section
34](https://www.gesetze-im-internet.de/bdsg_2018/BJNR209710017.html), and
document the reason for any restriction or refusal.
