---
description: Configure privacy operations and handle access and portability requests.
sidebar_position: 4
title: Data-subject requests
---

# Data-subject requests

People start Article 15 access and Article 20 portability requests from Account
settings or the published privacy contact. Operators handle cases at
`/admin/privacy`, which requires an `admin` account. The deployment
owner remains responsible for controller facts, processor instructions,
deadlines and independent review. A working export is not a compliance
certificate.

## Working a case in Privacy requests

Open **Privacy requests** at `/admin/privacy` with a real administrator session. Selecting a different case clears its evidence,
verification-code and delivery drafts. A version conflict retains your current
draft, reloads the case, and requires another explicit confirmation.

- **Identity and authority:** manual verification uses exceptional evidence,
  a reasonable-doubt code and a live identity attachment belonging to this case.
  Selecting an account-login or email method cannot prove identity. The subject
  supplies account-login proof in their own session; the caseworker completes
  the actual email-code flow. Representative authority and permission to receive
  the response are separate decisions backed by a live authority attachment.
- **Source tasks:** assign an active authorized operator, then record the actual
  source outcome, reason, reviewed record count and applicable redaction code.
  Assignment does not complete a task. Running collectors cannot be completed by
  a caseworker; unresolved required sources still block generation.
- **Deadlines and decisions:** inspect the original deadline and controller time
  zone. Record the actual notification timestamp before extending a deadline.
  Repeated extensions cannot exceed two calendar months after the original
  deadline. Refusal requires confirmation and blocks subsequent case delivery.
- **Evidence and supplements:** upload PDF, plain text, CSV, JSON, PNG or JPEG,
  up to 25 MiB. Files are encrypted and begin with pending rights review. Only
  approved processor responses or operator supplements enter exports; identity
  and authority evidence never does. Upload a separately redacted replacement
  with provenance and a redaction code, reject the original, then review the
  replacement. Downloads are passive and require a recent sufficiently assured
  login. Files are never displayed inline.
- **Backups:** retained backups are not searched automatically. Handle the
  retained-backup source task manually, as described in
  [Backup and restore](./backup-and-restore.md#personal-data-in-backups), and
  record its outcome on the task.
- **Assisted delivery:** confirm the artifact, delivery channel and reason, then
  sign in again at `/auth/privacy/admin` and complete verification after returning
  to the case. Use the explicit Download action once. The browser owns supported
  same-origin downloads; other supported configurations use a user-selected file
  sink with bounded streaming. An unsupported browser/client disables delivery
  before consuming the one-use challenge. After an uncertain or interrupted
  transfer, refresh the server status and start a new deliberate ceremony.

Capability hints do not grant authority. Every mutation and byte response
checks the current server state.

## Initial setup

Sign in as a full administrator and open **Privacy setup** at
`/admin/privacy-setup`. The setup groups controller and contact details,
notification delivery, and retention and source declarations. Privacy
administrators handle requests; changing deployment settings requires a full
administrator.

Enter the controller's name and postal address, request contact, jurisdiction
and supervisory authority. Configure the existing email provider and use its
explicit test action to check delivery. Review the prefilled retention periods:
7 days for export artifacts, 30 days for identity evidence and 3 years for case
records. Set these to the deployment's actual policy and declare its additional
sources. Environment values override saved settings and appear locked in the
editor; remove the environment override to manage that value in the UI. Public
legal pages refresh their cached facts within about a minute.

The CLI provisions the managed encryption key and private export volume.
Exclude the export storage from every backup policy, including operator-managed
copies. Self-service export does not depend on a release approval or build
fingerprint: once the settings above are complete, requests are generated as
soon as each case's own source tasks allow it.

## Operational checks

Configure the controller name, postal address, request contact, jurisdiction,
supervisory authority, privacy sources and retention settings before generation.
Keep encrypted artifact storage excluded from backups and protect the managed
key file. Investigate failed storage/key probes, stale cleanup or notifications,
unsupported collectors and overdue cases. Cleanup runs hourly;
physical deletion failures must remain visible until resolved. Key loss makes existing ciphertext unrecoverable. Recover the original ring from a separately protected copy, preserving owner and permissions, then recreate the API. If no valid copy exists, record the affected source/artifact as unavailable and use reviewed casework; do not invent a replacement key and claim recovery.

## Export-key provisioning and rotation

Managed compose rendering creates a dedicated key at
`infra/docker/secrets/subject-exports-master-key` and mounts it read-only into
`app-api`. Keep it owner-readable only (`0400`), with the configured app UID,
without symlinks or extra hard links. The file always contains a bounded JSON
key ring, including when it holds only the initial version-1 key. Unversioned
key files are rejected. Production requires
`OPENMAPX_EXPORTS_KEY_FILE`; the raw `OPENMAPX_EXPORTS_KEY` fallback is for
explicit development environments only.

For overlapping rotation, add a new version while retaining the existing key.
The following shows the structure only. Replace descriptions with canonical
32-byte base64url key material, then serialize the object as compact JSON with
no trailing newline. A pretty-printed file copied directly from this example is
rejected:

```json
{
  "formatVersion": 1,
  "activeVersion": 2,
  "keys": [
    { "version": 1, "key": "existing canonical 32-byte base64url key" },
    { "version": 2, "key": "new canonical 32-byte base64url key" }
  ]
}
```

The ring accepts at most eight distinct positive key versions. Prepare the
replacement privately on the same filesystem, preserve the existing version
exactly, set its owner and `0400` permissions, and replace the managed file
atomically. Recreate the API container to load the new ring. New encrypted
material uses the active version;
retained older versions can still decrypt authorized existing material.

Do not remove an old version merely because the normal artifact window has
passed. Request locators, protected notes, attachments and
pending identity challenges can still require it. Confirm that all material
referencing that version has expired and been physically cleaned, or has been
safely re-encrypted through a separately reviewed migration, before removing it.
There is no automatic database-wide rewrapping command in this release. Keep
necessary key recovery copies separately protected and outside ordinary
application/database backups. Never put keys into a case attachment, log,
command argument or document.

## Intake and response

An authenticated person starts a request from Account settings or contacts the
published privacy address. The API records receipt time, locale, time zone,
request type and a response deadline. A request creates a case with its receipt details, source tasks and preservation records. Disclosure and collection
require verified identity. Staff must record any clarification,
restriction, extension or refusal with a reason code.

Sources are collected when the export is generated, not at registration.
Short-lived categories, such as sign-in verifications, sessions and rate-limit
controls, may expire under their own retention between the request and
collection. The response report names these categories from the catalogue.

The live OpenMapX export uses one repeatable-read snapshot. It includes explicit,
ownership-filtered OpenMapX projections and requests data from a connected
managed Dawarich instance when that processor is configured. Independent
controllers, off-host systems and operator-controlled sources become visible
review tasks; they are never silently represented as searched or complete.

## Delivery controls

Archives are encrypted at rest with an envelope-encrypted data key. The subject must complete a fresh sign-in (including their configured second factor) for each download. Authorization is consumed once; a link alone does not grant access.
The response rejects range requests, sets `Cache-Control: no-store`, and the
artifact expires under its retention policy. The hourly privacy cleanup job removes ciphertext; failed physical deletion remains visible for retry. If a download is interrupted, the subject starts a new
reauthentication challenge.

No archive, nonce, credential or personal-data summary is sent by email.
Status notifications invite the recipient to sign in. Identity-verification
messages contain a short-lived, case-bound code sent only to the authoritative
contact. The service records delivery after the HTTP response finishes; an
interrupted stream does not count as successful delivery. Each subsequent
download requires fresh authentication. Close the case after confirming the
response channel.

## Assisted and representative requests

Use the privacy-admin intake form for inaccessible or deleted accounts. Supply
an exact protected locator and the actual receipt time; do not create a
replacement account. Prefer a fresh authenticated account proof, followed by a
verified email challenge. Codes are rate-limited, expire, and cannot be reused
for another case or party. Failed delivery remains visible for retry; operators
cannot choose a different destination while issuing a challenge.

A representative must prove their own delivery identity and have their
authority reviewed separately. Review exceptional identity evidence only when
recorded reasonable doubt justifies it. Case updates use versions and
idempotency keys; reload after a conflict rather than applying a stale decision.
An unavailable exact account match requires explicit manual source outcomes
and reviewed supplements, never an invented user ID.

Retained backups are not extracted automatically; the operator handles a
request for backup data manually. Unknown off-host copies, processor responses
and generic text logs remain operator tasks. Do not use
free-text scans to match a person.

## Browser-only supplement

The **Download browser data** action creates a separate local JSON file. It
contains only an allowlisted preference snapshot and offline-map metadata. It
is never uploaded; cookies, sessions, query caches, credentials and raw map
archives are intentionally excluded.

## Operator checklist

1. Confirm the request identity and scope; do not accept arbitrary identifiers
   in notes or collector commands.
2. Preserve applicable sources and inspect every required task. Resolve
   processor, external-source and retained-backup tasks explicitly.
3. Generate the encrypted artifact, inspect the bounded manifest and record
   any redactions or rights-of-others decisions.
4. Ask the subject to sign in again, deliver once, and verify that the case and
   artifact expiry timers are active.
5. Retain only the case evidence required by the configured legal retention;
   run cleanup and investigate any failed physical deletion.

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
