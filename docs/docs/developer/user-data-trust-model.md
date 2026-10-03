---
sidebar_position: 8
title: User-data trust model
---

# User-data trust model

Ordinary synchronized OpenMapX content is **not end-to-end encrypted**. The API
and an operator with application or database access can read saved places,
vehicle and parking data, and shared snapshots. TLS protects transport;
server-held encryption keys protect stored credentials against a database-only
exposure, but do not exclude the running server from the trust boundary. A
passkey authenticates an account; it does not encrypt ordinary saved content.

The [confidentiality architecture decision](./user-data-confidentiality-architecture.md)
contains the complete data inventory, threat model and prerequisites for future
client encryption. Use the following classes when reviewing a new field.

## Protection classes

| Class                           | Classification rule                                                                 | Current examples and handling                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public data                     | The subject deliberately publishes the content for public use.                      | Submitted OSM contributions and public Mangrove reviews. Public visibility does not make private credentials or unpublished drafts public.                                                                                                         |
| Server-required secrets         | The server must validate or use the value to authenticate or contact a provider.    | Password hashes, sessions, OAuth tokens and integration credentials. Hash when verification is sufficient; use server-held encryption when plaintext use is required. Never expose secret material in public responses or exports.                 |
| Server-readable private content | The server must query, synchronize, transform or return persistent private content. | Account metadata, saved places, vehicles, parking and share snapshots. Require ownership-based access and explicit processor, retention and deletion rules. Operators remain inside this boundary.                                                 |
| Transient private inputs        | Processing needs the input, but durable retention is not part of the feature.       | Search queries, route endpoints, navigation fixes and timeline requests. Minimize processing and retention; justify any persistence or cache separately. A persisted share snapshot is server-readable private content.                            |
| Client-encrypted content        | Content keys remain on client devices; the server stores ciphertext.                | Mangrove signing keys in the existing encrypted modes. Its explicit unencrypted mode is server-readable. Extending this class to ordinary saved content requires the ADR's key management, recovery, sharing, migration and security-review gates. |

Classify the **field and its purpose**, rather than assigning one class to a whole
feature: an OSM edit has public content, a server-required credential and a
transient draft. Record any transition between classes, such as deliberately
publishing a private snapshot through a bearer link. Anyone holding that link is
an intended reader until expiry or revocation.

## Maintainer review checklist

For each new or changed field, record:

- Its protection class, purpose, ownership and readers, including operators and
  external processors. Identify the server work that requires plaintext.
- Every storage location: database, browser or device, logs, metrics, caches and
  backups. Keep secrets and private inputs out of public cache entries and log
  projections; document any intentional retention.
- The access checks and explicit response/export projections. Authentication
  alone does not establish ownership. Encryption with a server-held key does
  not establish end-to-end confidentiality.
- Retention, expiry and deletion behavior for live rows, client state, processor
  copies and backups. Deleting a live row does not rewrite existing snapshots;
  operators must control backup access and expiry and apply erasure handling
  during restore.
- Consistency with the processing registry and the English/German privacy
  disclosures. Add verification for the relevant ownership, disclosure,
  redaction and deletion boundaries.

An actively compromised web origin can change the client code and attack data or
keys after they are unlocked. Existing encrypted-key storage must not be
presented as protection against that threat. Changes to client encryption must
meet the ADR's review gates before introducing stronger guarantees.

## Privacy export boundary

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
