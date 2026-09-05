---
sidebar_position: 4
title: Data-subject requests
---

# Data-subject requests

OpenMapX provides a self-service Article 15 access and Article 20 portability
workflow. It is an operational process, not an automatic legal-compliance
claim: the deployment owner remains responsible for the controller record,
processor instructions, deadlines and human review.

## Intake and response

An authenticated person starts a request from Account settings or contacts the
published privacy address. The API records receipt time, locale, time zone,
request type and a response deadline. A request creates an immutable case,
source tasks and preservation records. Minimal safe receipt projections may be
preserved before identity review; disclosure and broader collection require
verified identity. Staff must record any clarification,
restriction, extension or refusal with a reason code.

Short-lived authentication and offline-control metadata is captured into bounded
encrypted source snapshots at registration. Credentials and usable tokens are
excluded. Missing capture dependencies create review tasks; later live data is
not substituted for an expired receipt snapshot.

The remaining live OpenMapX export uses one repeatable-read snapshot. It includes explicit,
ownership-filtered OpenMapX projections and requests data from a connected
managed Dawarich instance when that processor is configured. Independent
controllers, off-host systems and operator-controlled sources become visible
review tasks; they are never silently represented as searched or complete.

## Delivery controls

Archives are encrypted at rest with an envelope-encrypted data key. The
download is not a bearer link: the subject must complete a fresh sign-in (and
configured second factor), and a successful authorization is consumed once.
The response rejects range requests, sets `Cache-Control: no-store`, and the
artifact is automatically expired and physically removed by the privacy
cleanup job. If a download is interrupted, the subject starts a new
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

Backup extraction warnings require a separate decision bound to that exact
review and manifest. Read the proposed omissions before accepting them. A
changed backup or warning set requires a new review. Unknown off-host copies,
processor responses and generic text logs remain operator tasks. Do not use
free-text scans to match a person.

## Release and operational gate

The source release must pass repository tests, real database and configured
Docker collector fixtures. From that exact checkout, run:

```bash
pnpm validate:privacy-release /absolute/path/privacy-release-validation.json
```

Mount the generated file read-only and set
`PRIVACY_EXPORT_VALIDATION_EVIDENCE_FILE` to its absolute container path. It
contains no personal data or keys. It binds successful translation, OpenAPI
and policy checks to the source fingerprint embedded in the API image; a stale
file cannot enable the release. Set `PRIVACY_EXPORT_EVIDENCE_VERSION` to an
attributable review label and `PRIVACY_EXPORT_IMPLEMENTATION_ACTOR_IDS` to the
actual implementation owners' user IDs.

A full administrator records independent human reviews for `legal-content`,
`dsar-process` and `security-review` against the evidence version returned by
`GET /api/privacy/admin/readiness`. Do not copy an approval from another build
or deployment, enter one on another person's behalf, or treat an environment
flag as evidence. Missing, expired or superseded approvals keep automatic and
admin-triggered generation disabled. Intake, identity review, manual casework
and authorized access to an already-issued artifact remain available.

Configure the controller name, postal address, request contact, jurisdiction,
supervisory authority, privacy sources and retention settings before generation.
Keep encrypted artifact storage excluded from backups and protect the managed
key file. Investigate failed storage/key probes, stale cleanup or notifications,
unsupported collectors and overdue cases in readiness. Cleanup runs hourly;
physical deletion failures must remain visible until resolved. Key loss makes
existing ciphertext unrecoverable, so follow the managed key recovery procedure
without copying keys into a request or its evidence.

## Export-key provisioning and rotation

Managed compose rendering creates a dedicated key at
`infra/docker/secrets/subject-exports-master-key` and mounts it read-only into
`app-api`. Keep it owner-readable only (`0400`), with the configured app UID,
without symlinks or extra hard links. The file always contains a bounded JSON
key ring, including when it holds only the initial version-1 key. Unversioned
key files are rejected. Production requires
`OPENMAPX_EXPORTS_KEY_FILE`; the raw `OPENMAPX_EXPORTS_KEY` fallback is for
explicit development environments only.

For overlapping rotation, add the new key to the JSON ring, for example: The file must be compact JSON without a trailing newline; replace
the descriptions with securely generated key material:

```json
{"formatVersion":1,"activeVersion":2,"keys":[{"version":1,"key":"existing canonical 32-byte base64url key"},{"version":2,"key":"new canonical 32-byte base64url key"}]}
```

The ring accepts at most eight distinct positive key versions. Prepare the
replacement privately on the same filesystem, preserve the existing version
exactly, set its owner and `0400` permissions, and replace the managed file
atomically. Recreate the API container to load the new ring. Readiness detects
a disk ring that differs from the running ring and stays closed until the
configured key state matches. New encrypted material uses the active version;
retained older versions can still decrypt authorized existing material.

Do not remove an old version merely because the normal artifact window has
passed. Request locators, protected notes, receipt snapshots, attachments and
pending identity challenges can still require it. Confirm that all material
referencing that version has expired and been physically cleaned, or has been
safely re-encrypted through a separately reviewed migration, before removing it.
There is no automatic database-wide rewrapping command in this release. Keep
necessary key recovery copies separately protected and outside ordinary
application/database backups. Never put keys into a case attachment, log,
command argument or release-evidence document.

## Browser-only supplement

The **Download browser data** action creates a separate local JSON file. It
contains only an allowlisted preference snapshot and offline-map metadata. It
is never uploaded; cookies, sessions, query caches, credentials and raw map
archives are intentionally excluded.

## Operator checklist

1. Confirm the request identity and scope; do not accept arbitrary identifiers
   in notes or collector commands.
2. Preserve applicable sources and inspect every required task. Resolve
   processor, external-source and backup-review tasks explicitly.
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
