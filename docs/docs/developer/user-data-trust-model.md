---
sidebar_position: 8
title: User-data trust model
---

# User-data trust model

The privacy export boundary is intentionally narrower than the database. A
registry entry declares the purpose, legal basis, origin, recipients,
retention, portability decision and secret policy. A collector must then use
an ownership-first projection and a bounded, repeatable-read snapshot. It may
emit metadata about secrets, but never secret material, bearer tokens,
password hashes, private keys or artifact keys.

## Source classes

- **OpenMapX live database:** explicit account, authentication, content,
  vehicle, sharing, timeline, mobile and audit projections.
- **Managed Dawarich:** a pinned, versioned source contract and an authenticated
  streaming tar response. The API validates each source manifest and never
  treats an unavailable processor as an empty result.
- **Retained backups:** reviewed per snapshot. Only verified v2 manifests and
  compatible collectors may be extracted in a new, egress-free scratch
  environment; production volumes, secrets and the Docker socket are not
  mounted into that environment.
- **External/off-host sources:** operator tasks and encrypted case
  attachments. Their provenance, cutoff and redactions must be recorded.
- **Browser-only data:** a local allowlist export, kept separate from
  controller-held data.

## Integrity and authorization

Export artifacts are written atomically as encrypted ciphertext. Plaintext and
ciphertext digests are recorded in metadata and checked in a first pass before
the second-pass response. Downloads require the subject-owned artifact,
current request state, a fresh session assurance and a one-time challenge.
Range requests and reusable URLs are not supported.

The API is the policy boundary. The ops agent accepts only fixed operation
contracts and, for historical extraction, a short-lived HMAC capability bound
to request, task, backup digest, cutoff and collector contract. It does not
accept paths, SQL, image names or Docker flags from the browser.

## Completeness

`GdprExportReadiness` is fail-closed. It reports registry coverage, encryption,
retention cleanup, backup review, monitoring, notification, OpenAPI/policy and
current human approvals. A failed check permits intake and an honest partial
response, but prevents wording that the deployment is automatically “GDPR
compliant.”
