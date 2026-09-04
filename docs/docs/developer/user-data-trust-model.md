---
title: User-data trust model
description: What OpenMapX encrypts, what the server can read, and how to classify new user data.
sidebar_position: 3
---

# User-data trust model

OpenMapX does not currently provide end-to-end encryption for ordinary
synchronized content. The API and the operator of an OpenMapX deployment can
process saved places, vehicles, parking positions, share payloads, and account
metadata. Passkeys authenticate an account; they do not encrypt that content.

Selected credentials are encrypted at rest with keys held by the deployment.
Passwords and bearer tokens are hashed where the server only needs to verify a
value. Mangrove private signing keys are the existing exception: in either
encrypted mode the browser encrypts the private key before upload, while the
explicit unencrypted mode stores it as plaintext.

The complete decision, inventory, threat model, feature matrix, and future key
architecture live in the
[user-data confidentiality architecture](./user-data-confidentiality-architecture.md).
This page is the shorter operational reference.

## The five data classes

Use one of these classes whenever a schema, cache, integration, or client store
starts retaining new user data:

| Class | Meaning | Examples | Required treatment |
| --- | --- | --- | --- |
| 1. Public | The user intentionally publishes the content. | OSM edits, Mangrove reviews and images | Confirm the publication boundary and external retention. Signing is authenticity, not confidentiality. |
| 2. Server-required secret | The server must verify or use the value. | Password hashes, sessions, OAuth tokens, integration credentials, TOTP secrets | Hash where verification is enough; otherwise use reviewed server-side encryption. Never call this E2EE. |
| 3. Server-readable private | The API must query, transform, synchronize, or share the value. | Saved places, vehicles, parking, snapshot/live shares | Enforce authorization, minimize fields, exclude from public caches/logs, and protect databases/backups. State operator access plainly. |
| 4. Transient private input | A processor needs plaintext briefly but OpenMapX should not retain it. | Search text, route endpoints, navigation fixes, requested Timeline history | Send only to necessary processors, use no-store/private cache policy, redact logs, and bound any recovery storage. |
| 5. Client-encrypted | Enrolled clients hold the content keys; the server stores opaque authenticated ciphertext. | Encrypted Mangrove key modes; future eligible private collections | Requires device/recovery/key-authenticity/migration design and security review. Do not add ad-hoc envelopes. |

Encryption at rest, TLS, client-side signing, and E2EE are different controls:

- **TLS** protects data between endpoints; each endpoint still receives
  plaintext.
- **Server-side encryption** can protect a stolen database or backup when the
  deployment key is separate, but the running server can decrypt it.
- **Signing** proves who authorized content and detects modification; it does
  not hide content.
- **Client encryption** can hide content from database operators, but the claim
  is only as strong as client delivery, key storage, recovery, recipient-key
  authenticity, and metadata protection.

## Current boundaries

### Authentication and credentials

Better Auth owns account, session, passkey, two-factor, and OAuth state.
Passwords are stored as hashes. OAuth provider tokens, TOTP secrets, backup
codes, and library-managed private material are encrypted with the deployment's
authentication secret under the current Better Auth configuration. The
authenticator retains a passkey's private key; the database stores its public
credential and metadata.

OpenMapX encrypts service, integration, Timeline, and short-lived mobile-handoff
credentials with AES-256-GCM under `OPENMAPX_SECRETS_KEY` or a purpose-derived
key. These are server envelopes: the API can decrypt them to do its job. The
current general-purpose envelope has no stored format version or key identifier,
so rotation and authenticated row-context binding require a separate migration
design.

### Synchronized content

Saved lists/places and labeled places are ordinary PostgreSQL rows. Place names,
coordinates, labels, notes, and associated metadata are server-readable.
Vehicle profiles and the current parking coordinates/address/note are also
server-readable. Authorization scopes queries to the account, but an operator
with administrative or database access is inside the trust boundary.

OpenMapX has no general saved-route table. Route data may nevertheless be
retained in a bearer-link snapshot, the optional recent-map-data browser cache,
a resumable browser navigation session, or the active mobile navigation
database. Routing services must receive endpoints and relevant preferences to
calculate or update a route.

The Personal Timeline integration stores connection metadata in plaintext and
the Dawarich API key in a server envelope. Requested Timeline bodies pass
through the API but are excluded from Redis, Service Worker, persisted query,
and browser-storage caches. Dawarich is a separate storage and deletion
boundary.

### Shares and public systems

Share URLs are bearer credentials. OpenMapX stores a SHA-256 digest rather than
the raw token, but stores route/list snapshot payloads as server-readable JSON.
A live saved-list share asks the server to read and return the current list.
Anyone holding a valid URL is an intended recipient until revocation or expiry.
The response is `no-store`; that does not make its source payload E2EE.

OSM contributions and Mangrove reviews become public records governed by those
systems. Deleting the OpenMapX account cannot reliably remove public copies or
mirrors. Mangrove's encrypted key modes protect the private signing key in a
database-only disclosure. They do not make a public review confidential.

### Logs, caches, devices, and backups

Application-log fields are bounded and sanitized before entering the in-memory
ring or the `app_logs` table. Request bodies, credentials, queries, and raw
external URLs are redacted. Warning-and-higher records persist until the
operator's retention process removes them. The admin audit log stores actor,
target, action, IP address, user agent, and details; its default retention is 90
days, and an actor deletion leaves the event with a null actor.

Account deletion removes persisted application logs that match the deleted ID
or email. It retains an audit event only after clearing matching actor/target
IDs, actor IP address and user agent, and matching details.

The recent-map-data browser cache is opt-in, but cached routes, searches, places,
tiles, and navigation recovery state can still reveal geographic interests.
Mobile active-navigation storage can include route and location state until
termination or expiry. A stolen, unlocked client is outside what E2EE can solve.

The backup system snapshots PostgreSQL and Redis volumes. A database backup
contains the same plaintext user fields and encrypted credentials that existed
in the live database. Account deletion does not rewrite older archives, so
OpenMapX enforces a backup age limit and keeps an HMAC-pseudonymised erasure
journal outside PostgreSQL. Restore fails if journal coverage is incomplete and
replays retained requests before completing. Operators must still restrict and,
where appropriate, encrypt off-host copies and apply the same expiry there.

## Threat claims

Be precise about the actor:

- A passive **Internet observer** should see TLS metadata, not browser request or
  response content, when the deployment and upstream connections use HTTPS
  correctly. TLS terminates at Traefik; internal container traffic may use HTTP
  on the private Docker network.
- A **database-only attacker** sees server-readable content. Separately
  encrypted credentials and encrypted Mangrove keys require keys not present in
  the dump.
- A **hosted or self-hosted operator** can run the server, access its processing,
  administer the database, and—if authorized as an admin—use account
  impersonation. Self-hosting changes who the operator is; it does not create
  E2EE.
- An **infrastructure or backup operator** may additionally access private-network
  traffic, volumes, snapshots, deployment secrets, and running processes. This
  role is inside the current trust boundary for server-required secrets,
  server-readable content, and transient processing.
- A **compromised API process** can use loaded server keys and observe transient
  requests.
- A **compromised web application server** can additionally deliver hostile
  same-origin JavaScript that targets keys or plaintext after decryption. Strong
  protection from this actor requires independently verifiable client delivery
  and an authenticated key directory, not just Web Crypto.
- A **malicious recipient or compromised unlocked device** can retain plaintext
  it legitimately decrypted. Revocation only limits future access.

## Review checklist for new data

Before merging a feature that stores or transmits user-related data, answer all
of the following in its design or pull request:

1. Which of the five classes applies to each field? Separate content,
   credentials, identifiers, and operational metadata.
2. Why must each server or third-party processor receive the field? Can the
   field be omitted, coarsened, or processed locally?
3. Where can it persist: PostgreSQL, Redis, logs, metrics, browser storage,
   service-worker caches, mobile storage, notification payloads, and backups?
4. What are the live retention, expiry, account-deletion, external-deletion, and
   backup-aging behaviors?
5. Which users, admins, operators, recipients, and integrations can read or
   change it? Is impersonation relevant?
6. Is the security control a hash, transport encryption, server encryption,
   signing, or client encryption? Does the product text name it correctly?
7. What happens after a device is lost, a recipient is removed, an account is
   reset, a key is rotated, or the server replays older data?
8. Do English and German privacy disclosures and feature documentation still
   match the implementation?

Class 5 additionally requires the security gates in the architecture decision.
In particular, do not derive a general data-encryption key directly from a
passkey, reuse a signing key for encryption, build searchable encryption, or
compose cryptographic primitives in OpenMapX code without an approved protocol
and independent review.

## Approved language

Use claims with a named boundary:

- "Passwords are hashed. Selected credentials are encrypted at rest with a key
  held by this OpenMapX deployment."
- "Ordinary synchronized content is not end-to-end encrypted; the server and
  operator can process it."
- "A passkey authenticates you. It does not encrypt saved content."
- "In an encrypted Mangrove mode, a database disclosure reveals ciphertext for
  the private signing key. A compromised web application may still target the
  key after unlock."
- "Deleting live rows does not immediately remove copies in existing backups."

Do not say "zero knowledge," "operator-proof," "the server cannot read your
data," or "E2EE" without naming the exact fields, clients, threat actor, and
remaining metadata.
