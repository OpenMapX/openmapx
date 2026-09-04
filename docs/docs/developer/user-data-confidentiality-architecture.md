---
title: User-data confidentiality architecture
description: The accepted trust boundaries, threat model, and staged design for future client encryption.
sidebar_position: 4
---

# User-data trust boundaries and E2EE architecture decision

**Status:** Accepted design; security review required before implementation

**Date:** 2026-09-04

**Issue:** [#312](https://github.com/OpenMapX/openmapx/issues/312)

**Owners:** OpenMapX maintainers and security reviewers

## Decision summary

OpenMapX will use a **selective, staged confidentiality model**. We will not
describe the platform as end-to-end encrypted, and we will not add a single
"encrypt everything" layer.

The server must continue to read data that it needs to authenticate users,
contact integrations, calculate routes, search, synchronize devices, resolve
current bearer-link shares, and operate a self-hosted instance. Public
contributions remain public. Persistent private content may become
client-encrypted only where its product semantics can be preserved or changed
deliberately.

The target model has five protection classes:

1. **Public data:** content intentionally published to systems such as
   OpenStreetMap or Mangrove.
2. **Server-required secrets:** passwords, sessions, provider credentials,
   integration keys, and similar values that the server must validate or use.
   These are hashed when equality/verification is enough and encrypted with a
   server-held key when plaintext use is required.
3. **Server-readable private content:** synchronized content that the API must
   currently query, transform, share, or return. Infrastructure, database, and
   application operators are inside this trust boundary.
4. **Transient private inputs:** route, search, navigation, and timeline inputs
   that a processor must see but that OpenMapX should minimize and avoid
   retaining.
5. **Client-encrypted content:** opaque ciphertext whose content keys remain on
   enrolled client devices. This class will be introduced only after the key,
   recovery, sharing, and client-integrity gates in this decision are met.

This decision does not introduce a cryptosystem. It defines the trust claims,
target architecture, migration boundary, and review gates for later work.

## Why this is the chosen boundary

Three approaches were considered.

### Encrypt every user field on the client now

This would prevent the current server from searching saved content, expanding
live shares, calculating over stored locations, supporting users through
impersonation, or recovering accounts. The current browser application also
cannot honestly promise protection from an actively compromised application
server: hostile same-origin JavaScript can read data after the browser decrypts
it. The Web Cryptography specification explicitly treats script injection as
remote code execution in the application's origin and does not promise secure
key persistence.

**Rejected:** the product and threat model are not ready for this claim.

### Encrypt private database columns with the deployment key

This would improve resistance to a database-only or backup-only disclosure, but
the API and operator would still be able to decrypt the data. Queries, indexes,
rotation, and recovery would also require a versioned envelope design. Calling
this E2EE would be incorrect.

**Deferred as a separate defense-in-depth option:** useful for carefully chosen
fields after a server-envelope migration design, but not a substitute for E2EE.

### Stage client encryption by data class

Keep required server processing explicit, minimize transient processing, retain
existing client encryption where it is already honest, and make future
persistent private content eligible for a versioned client envelope.

**Accepted:** it improves the architecture without weakening current features or
making a misleading security promise.

## Current data inventory

"Server-readable" below means the running API and an operator with application
or database access can obtain the content. TLS protects transport, not either
endpoint. Storage-volume encryption, host hardening, and off-host backup
encryption remain deployment responsibilities unless a row below names an
application-layer control.

| Data | Storage and processors | Caches, logs, and backups | Current protection and deletion | Class and decision |
| --- | --- | --- | --- | --- |
| Account profile | PostgreSQL `user`; Better Auth and the API | Session/account data is excluded from public caches. Database backups contain it. Bounded logs may contain identifiers but request bodies and sensitive keys are redacted. | Access-controlled and removed from the live database by account deletion. | **3.** Keep server-readable; needed for account administration and communication. |
| Password | Better Auth `account.password` | Included in database backups as a hash. | Scrypt hash; the plaintext is not stored. | **2.** Hash, never client-encrypt. |
| Sessions | PostgreSQL `session`: token, IP address, user agent, expiry | Database backups contain active or expired rows present at snapshot time. | Session token and expiry are server-managed; account deletion cascades. Admins can revoke sessions. | **2.** Server authentication state. |
| Passkeys | PostgreSQL `passkey`: credential public key, identifier, transports, counter, device metadata | Database backups contain public credential material and metadata. | The authenticator's private key remains on the authenticator. A passkey authenticates; it does not encrypt ordinary OpenMapX data. | **2.** Authentication, with optional future PRF use only as one key-unlock mechanism. |
| Two-factor data | PostgreSQL `two_factor` through Better Auth | Database backups contain library-managed ciphertext. | TOTP secrets and backup codes are encrypted by Better Auth 1.7.1 with the authentication secret. | **2.** Retain server encryption; add explicit regression coverage if this configuration is customized. |
| Linked OAuth accounts | PostgreSQL `account`: provider identifiers and access/refresh/ID tokens | Database backups contain identifiers and encrypted token values. Tokens are not returned to the browser. | `account.encryptOAuthTokens` is enabled; Better Auth encrypts tokens with the authentication secret. Unlinking or account deletion removes the live rows. | **2.** The server must decrypt provider tokens to call providers. Not E2EE. |
| OpenMapX OAuth-server state | PostgreSQL OAuth client, consent, access-token, refresh-token, assertion, and resource tables | Database backups contain rows present at snapshot time. | Issued secrets/tokens use Better Auth's hash/encryption behavior; user-owned state cascades on deletion where the schema has a user relation. | **2.** Server authorization state. |
| Integration and service credentials | PostgreSQL `integration_secret` and `service_secret`; decrypted by the API only when invoking a service | Database backups contain ciphertext. Redaction removes secret-shaped fields and credentials from application logs. | AES-256-GCM under deployment-wide `OPENMAPX_SECRETS_KEY`. Current rows do not carry an envelope version or key identifier and are not bound to row context with AAD. | **2.** Keep server-readable; design a versioned, rotatable server envelope before changing fields. |
| Saved lists and places | PostgreSQL `saved_list`, `saved_place`, and `labeled_place`; saved API and sharing resolver | No shared Redis cache. Browser/client query state may hold returned values. Database backups contain content. | Names, coordinates, labels, notes, and place metadata are plaintext database fields protected by authorization. Account/list deletion cascades. | **3, future 5 candidate.** Defer client encryption until search, sharing, recovery, and migration semantics are accepted. |
| Routes | Active waypoints and calculated routes are primarily browser memory. An opted-in browser cache, browser navigation-session storage, mobile navigation database, or route share snapshot may retain them. Routing engines and API providers process coordinates. | Public routing/search responses can be cached only under the explicit recent-map-data setting. Browser navigation recovery and the mobile SQLite store retain an active session for bounded recovery. Route snapshot shares and database backups persist the shared payload. | There is no general saved-route table. Mobile termination removes location-bearing session rows; navigation sessions have bounded expiry. | **4** for calculation/navigation; **3** for snapshot shares. Future saved routes may use class 5, but server routing still sees submitted endpoints unless routing becomes local. |
| Vehicles and parking | PostgreSQL `personal_vehicle` and `parked_location`; vehicle and parking APIs | Browser state and database backups contain returned/current values. | Vehicle profile, EV details, coordinates, address, note, and expiry are server-readable. Only the current parking location is stored; account deletion cascades. | **3, future 5 candidate.** Encrypt only after cross-device, expiry, and sharing/query requirements are designed. |
| Personal Timeline connection | PostgreSQL `personal_timeline_connection`; OpenMapX API and selected Dawarich instance | Timeline response bodies are excluded from Redis, service-worker, persisted-query, and browser-storage caches. Database backups contain connection metadata and encrypted credential. | Public origin, display name, upstream user/email, and timezone are server-readable. API key uses the deployment AES-GCM envelope. Account deletion removes the OpenMapX connection; the Dawarich instance remains a separate deletion/retention boundary. | Metadata **3**, credential **2**, requested history **4**. Do not persist Dawarich history in OpenMapX. |
| Review signing key | PostgreSQL `mangrove_keypair` and wrap rows; browser Mangrove client | Database backups contain a public JWK plus either ciphertext or, after explicit opt-in, a plaintext private JWK. The decrypted key is held in browser memory until locked. | Recommended modes use age scrypt and/or WebAuthn PRF recipients. The explicit unencrypted mode places the operator inside the signing-key trust boundary. | **5** in encrypted modes; **3** in unencrypted mode. Preserve the precise claim and consider deprecating the unencrypted mode separately. |
| Reviews and images | Signed in the browser, relayed by OpenMapX, then published to Mangrove and its mirrors | Public external systems and mirrors may retain the content. | Public, pseudonymous content cannot be recalled reliably by deleting the OpenMapX account or local signing key. | **1.** Signing gives authenticity, not confidentiality. |
| OSM contributions | Draft in the client; submitted by the API using the linked OSM token; published to OpenStreetMap | A short-lived content-free deduplication record is stored in Redis or memory. OSM retains the public edit under its policies. | Provider token is server-encrypted. Permissions are rechecked with OSM before writes. | Contribution **1**, credential **2**, draft **4**. |
| Share links | PostgreSQL `share_link`; public bearer-link resolver | Route/list snapshots are stored in JSON and included in database backups. Live list shares read current saved-place rows. Public responses use `no-store`. | Raw random token is not stored; its SHA-256 digest is stored. Anyone with the URL is an intended reader until expiry or revocation. Account deletion cascades. | **3 with deliberate bearer disclosure.** A fragment-key encrypted share would be a different product design. |
| Social graph | Not implemented | None | No current promise or stored graph. | Define its class before implementation; default to **3/future 5 candidate**. |
| Live location | Not implemented. A "live" saved-list share is not continuous live location. | None | No current promise or stored stream. | Requires a separate threat model. Group membership changes and forward secrecy may justify MLS; do not reuse saved-list semantics. |
| Administrative audit | PostgreSQL `admin_audit_log` | Included in database backups. | Contains actor/target/action/details, IP address, user agent, and timestamp. Account deletion keeps the event but clears matching actor/target IDs, actor network/client metadata, and matching details. Default retention is 90 days. | Operational metadata outside E2EE; minimize and access-control. |
| Application logs | In-memory ring and PostgreSQL `app_logs` for warning and higher levels | Approximately 10,000 recent entries in memory; important levels persist and enter database backups. | Bounded sanitizer redacts bodies, queries, credentials, raw external URLs, email addresses, and user-ID/secret-shaped keys. Account deletion removes persisted rows containing the deleted ID/email; the general retention policy handles the remainder. | Operational metadata outside E2EE; keep redaction and explicit retention. |
| Client preferences and caches | Browser localStorage, IndexedDB, Cache Storage; mobile SQLite and OS-managed application storage | Stays on the device and may expose geographic interests. Browser cache is opt-in. Mobile backups are disabled; iOS file protection is configured for the app. | Device compromise after unlock can expose locally available plaintext. Clearing site/app data removes it; active navigation data also has lifecycle cleanup. | **3/4 at the client boundary.** Use platform storage protection and minimization; E2EE does not protect an already-unlocked compromised device. |

## Storage, retention, and deletion boundaries

### PostgreSQL and backups

PostgreSQL is the system of record for accounts and synchronized content. The
backup command captures the whole database with `pg_dump`; it does not transform
plaintext user fields into ciphertext. Therefore a backup is at least as
sensitive as the live database.

Deleting an account removes related live rows where the schema uses cascading
foreign keys and explicitly scrubs non-relational verification, settings, and
audit identifiers. It does not retroactively rewrite existing archives. Local
backups expire automatically (30 days by default), and a keyed pseudonymous
erasure journal outside PostgreSQL is replayed on restore. A restore is refused
when the archive is expired, predates journal coverage, or cannot validate the
journal/key. Operators must apply the same expiry to off-host copies.

Per-user cryptographic deletion is not used for ordinary synchronized content.
Those rows and historical backups were not encrypted with independent per-user
data-encryption keys, so destroying a key would not erase the existing copies.
Introducing that key hierarchy would add recovery, rotation, sharing, and loss
failure modes without replacing the backup retention and restore controls that
are required anyway.

Audit events may survive actor deletion, but matching actor/target identifiers,
IP address, user agent, and details are cleared. Persisted application logs that
match the deleted user ID or email are removed; all remaining logs are governed
by an operator-chosen retention policy. OpenStreetMap, Mangrove, external
Dawarich instances, and other processors have independent retention rules.

### Caches and local storage

Redis holds public/operational caches, not account records or Timeline response
bodies. When a user explicitly enables recent map-data retention, browser cache
storage may contain typed searches, geocoding results, route results, places,
and tiles. A resumable navigation session can include route geometry and
maneuvers. The mobile client stores an active navigation session and location
events in its SQLite database until termination or expiry.

Even public map tiles can reveal a user's area of interest when observed or
recovered together. Cache policy must therefore be based on data flow, not just
whether a response is publicly obtainable.

## Threat model

| Actor/event | Current guarantee | Target/limitation |
| --- | --- | --- |
| Passive Internet observer | TLS at the deployment edge and HTTPS upstream connections protect content in transit when correctly configured. | TLS terminates at Traefik. Internal container traffic may use HTTP on the private Docker network, and metadata such as endpoints, timing, and sizes remains observable. |
| Stolen database dump or backup without deployment secrets | Passwords and token digests remain one-way; application-encrypted credentials and encrypted Mangrove keys remain ciphertext. Ordinary synchronized content is exposed. | Server-envelope v2 can strengthen context binding and rotation. Client-encrypted content would remain opaque. |
| Database administrator | Can read ordinary private content and metadata; cannot necessarily use separately encrypted credentials without deployment keys. | Future class-5 content is opaque, subject to metadata leakage. |
| Infrastructure or backup operator | Can access container traffic, volumes, database snapshots, deployment secrets, and running processes according to host privileges. | This role is inside the trust boundary for classes 2–4. Class-5 content can remain opaque, but access patterns and other metadata remain visible. |
| Hosted OpenMapX operator | Can operate the API, access its plaintext processing, impersonate users through the admin feature, and deploy code. | Operator is trusted for classes 2–4. Client encryption can narrow database/operator access, but a web operator that can deploy JavaScript remains capable of targeting decrypted data. |
| Self-hosted operator | Same technical capabilities as a hosted operator; often the user or organization is deliberately its own trust root. | Documentation must not assume that self-hosting creates E2EE. It changes who the operator is. |
| Compromised application/API server | Can read all server-required and transient inputs, use loaded server keys, and alter responses. A compromised web origin can serve a client that steals decrypted data or substitutes public keys. | A strong active-server claim requires independently verifiable client code, authenticated key directories, and downgrade/rollback defenses. Signed native clients can provide a stronger delivery boundary than the current web app. |
| Compromised integration/routing provider | Sees the fields sent to that provider, such as query or route coordinates. | Minimize fields, use local providers where available, document processors, and avoid retaining request content. E2EE cannot preserve arbitrary server-side processing. |
| Stolen locked device | Protection depends on OS/browser storage and credential configuration. | Native keys should use non-exportable hardware-backed storage when available. Browser support is weaker and must be described honestly. |
| Stolen unlocked or malware-compromised device | Locally available plaintext and active keys may be read. | Out of scope for E2EE; offer remote device revocation for future access and rotate future resource keys. Revocation cannot erase previously decrypted copies. |
| Malicious client or recipient | Can submit malformed/stale ciphertext and can copy any content legitimately decrypted. | Authenticate envelopes, validate bounded metadata, enforce authorization, use version/epoch counters, and never claim recipient-side deletion. |

## Target client-key architecture

This is a protocol shape, not permission to implement it. A later proposal must
select audited libraries and publish interoperable test vectors.

### Keys and envelopes

- Generate a random 256-bit **account root key (ARK)** on an enrolled client.
  The server must never receive the ARK in plaintext.
- Give every device its own encryption key pair. Prefer non-exportable,
  hardware-backed platform storage in native clients. Document the weaker web
  storage boundary separately.
- Generate a random **content-encryption key (CEK)** per resource or collection.
  Encrypt content with a standard authenticated-encryption construction.
- Wrap the ARK or CEKs to each authorized device/recipient using a standardized,
  reviewed construction such as HPKE (RFC 9180). Do not implement primitive
  composition locally.
- Include authenticated envelope context: format version, suite identifier,
  tenant/deployment identifier, owner identifier, resource type and identifier,
  schema version, and monotonic key epoch. A future design must specify canonical
  encoding and which metadata stays outside the ciphertext.
- Separate encryption keys from signing/authentication keys. A Mangrove signing
  key does not become the general OpenMapX encryption root.

### Device enrollment and revocation

An existing enrolled device should approve a new device by authenticating its
public key and wrapping the necessary root/resource keys. Recovery may enroll a
device when no old device remains. The server maintains an authorization and
wrapped-key directory but cannot create a valid device identity unnoticed under
the strongest target model.

Revocation removes a device from future envelopes and increments the affected
key epoch. High-risk resources rotate to new CEKs. Revocation is not retroactive:
a device or recipient may have retained plaintext or old CEKs.

Multi-device consistency needs authenticated version counters and detection of
replayed or rolled-back ciphertext. Conflict resolution must not allow the
server to replace a newer key directory or resource envelope with an older but
validly authenticated one.

### Passkeys and recovery

WebAuthn PRF is optional. Authenticators may not support it, and an authenticator
may be unable to return a PRF result during credential creation. It may be used
as a convenient local wrapper only after capability detection; it must never be
the sole unlock or recovery mechanism.

Recovery should use a high-entropy, user-held recovery key. A human passphrase
may protect a recovery wrapper using Argon2id with versioned parameters, but it
must not silently replace adequate entropy. Recovery material must be printable
or exportable, verifiable before setup completes, and never recoverable by the
server without the user's secret.

Account and encryption recovery are separate events:

- Resetting a password, email, passkey, or OpenMapX account session does not
  recover encrypted content.
- Losing every enrolled device and the recovery secret permanently loses the
  content keys.
- A product flow may offer a destructive cryptographic reset: preserve the
  account, delete inaccessible ciphertext/wrapped keys after explicit consent,
  and start a new ARK generation. It must not pretend to recover old data.

### Key-directory authenticity

TLS and an authenticated account session are insufficient when the threat actor
is the application server itself: the server could substitute a recipient device
key. Before cross-user encrypted sharing claims active-server resistance, the
design must add a verification mechanism such as key transparency, auditable
consistency proofs, or user-verifiable safety codes.

For the current web client, the strongest honest near-term claim is protection
against database/backup disclosure and non-code-deploying operators. Protection
from an actively malicious web origin is deferred until client delivery and key
directory authenticity are independently verifiable.

## Feature compatibility matrix

| Feature | Server-readable model | Client-encrypted content | Decision |
| --- | --- | --- | --- |
| Cross-device synchronization | Server returns rows directly. | Server stores opaque blobs and wrapped keys; clients merge/version content. | Required before class 5 ships. |
| Server-side text/geospatial search | Full queries and indexes are possible. | Generally unavailable without leaking indexes or adopting specialized schemes. | Keep searchable fields server-readable or move search to the client; no custom searchable encryption. |
| Routing and rerouting | Server/provider sees submitted coordinates and preferences. | Stored waypoints may be decrypted locally, but server routing still sees submitted inputs. | Treat requests as transient class 4; local routing is a separate future option. |
| Bearer-link snapshot sharing | Server expands and returns plaintext snapshot. | Fragment-held key could let a browser decrypt without sending the key to the server. Server-side previews and moderation disappear. | Separate product proposal required; existing links remain class 3. |
| Live list sharing | Server reads the latest list on every request. | Owner must publish updated ciphertext and key material; revocation and caching semantics change. | Defer until sharing/ACL semantics are approved. |
| Recipient/account sharing | Not currently implemented. | Requires authenticated recipient devices, CEK wrapping, membership changes, and rollback protection. | Gate on key-directory authenticity. |
| Group/live-location sharing | Not implemented. | Needs epochs, membership changes, forward secrecy, bounded history, and traffic analysis review. | Consider MLS rather than creating a group protocol. |
| Federation/self-host transfer | Server can transform rows. | Ciphertext is portable only if identity, key-directory, recovery, and deployment binding rules are specified. | Design before federation; do not bind ciphertext irreversibly to one host unless migration is explicit. |
| Notifications | Server can include content. | Push service should receive only a wake-up or minimal opaque event; client decrypts after launch. | Content-free notifications for class 5. |
| Account support/impersonation | Admin may inspect user-visible server content. | Admin cannot decrypt class 5 without an explicit, user-authorized support export. | Accept reduced support capability. Never add escrow implicitly. |
| Backups | Restore returns usable rows and server-encrypted secrets if deployment keys are also restored. | Backups restore ciphertext and wrapped keys; user devices/recovery secrets remain necessary. | Restore testing must include key availability and cryptographic-reset cases. |

## Metadata and protocol abuse

Client encryption does not hide account identifiers, ciphertext sizes, update
times, device counts, sharing relationships, IP addresses, access patterns, or
push timing unless the system takes additional measures. Padding and batching
may reduce some leakage but add cost and latency; they require a separate
traffic-analysis decision.

Every future class-5 endpoint must handle:

- maliciously large or deeply nested envelopes;
- unknown algorithms and versions (fail closed, without destructive migration);
- nonce/IV reuse prevention delegated to the reviewed library or a specified
  allocation scheme;
- cross-resource ciphertext substitution through authenticated context;
- replay and rollback of resources, key directories, and membership epochs;
- malicious-client writes, including valid encryption of invalid domain data;
- downgrade from encrypted to plaintext storage or to an obsolete suite;
- schema evolution without requiring server plaintext access.

Authorization remains mandatory around ciphertext. Encryption is not a reason to
let one account enumerate or overwrite another account's opaque blobs.

## Migration and cryptographic agility

No existing plaintext column is overwritten in place during the first rollout.
A future migration must use a dual-format state machine:

1. Add versioned envelope and key-directory records alongside existing data.
2. Enroll and verify recovery before offering migration.
3. Have an authorized client encrypt a bounded batch and upload authenticated
   envelopes.
4. Read back and decrypt/validate the batch on a different enrolled device when
   available.
5. Mark the batch migrated with a monotonic version; retain plaintext only for a
   short, declared rollback interval.
6. Delete plaintext after verification and expiry. Backups age it out under the
   operator's policy rather than being rewritten silently.
7. Refuse silent downgrade. A destructive reset requires explicit user action.

Envelope versions identify the complete suite and parameter set. Readers may
support a bounded set of old versions; writers use the current version. Suite
retirement needs telemetry that reveals only aggregate format usage, a migration
path, and a published end date. This follows the cryptographic-agility principle
of replacing algorithms and parameters without redesigning the product.

## Encrypt now, defer, and exclude

### Keep or harden now

- Keep passwords and bearer/share tokens one-way where plaintext is unnecessary.
- Keep Better Auth encryption for OAuth tokens, TOTP secrets, backup codes, and
  library-managed private material.
- Keep deployment-key encryption for integration, service, Timeline, and mobile
  handoff credentials while a versioned server-envelope replacement is designed.
- Keep Timeline bodies out of shared and persistent caches.
- Enforce backup expiry and restore-time erasure replay; clear this browser's
  private OpenMapX state after confirmed account deletion.
- Correct documentation and UI text wherever authentication, TLS, signing, or
  server-side encryption could be mistaken for E2EE.

### Defer until the gates pass

- Client encryption of saved places, saved routes, vehicle/parking state, and
  future private timeline records.
- Encrypted sharing between accounts or deployments.
- Fragment-key bearer shares.
- Group or continuous live-location encryption.
- Searchable encryption, private information retrieval, or server computation
  over ciphertext.

### Exclude from E2EE

- Authentication and authorization state the server must verify.
- Provider and integration credentials the server must use.
- Content intentionally published to OSM, Mangrove, or another public network.
- Operational security metadata required for abuse prevention and audit, subject
  to minimization and retention.

## Required gates before an implementation issue

The maintainers must not open a broad "implement E2EE" task until all of these
are true:

1. The exact first data class and field set is named; "all user data" is not an
   acceptable scope.
2. Product owners accept the feature-matrix losses or client-side replacements,
   including support/impersonation changes.
3. Supported web and native clients have a documented key-storage boundary.
4. Device enrollment, revocation, recovery, destructive reset, and permanent
   loss UX have a tested prototype.
5. Passkey PRF is capability-detected and a non-passkey recovery path works on
   every supported platform.
6. Recipient/device key authenticity and rollback detection are designed.
7. Envelope schemas, canonical encoding, limits, algorithm identifiers,
   rotation, and plaintext migration/rollback rules are specified.
8. Test vectors and cross-client interoperability tests exist using maintained,
   reviewed cryptographic libraries.
9. Backup/restore, account deletion, revoked device, malicious client, and lost
   recovery cases are exercised.
10. An independent security review signs off on the protocol, implementation
    plan, user claims, and residual metadata leakage before production rollout.

## Documentation language

The following claims are approved:

- "Connections use TLS/HTTPS when the deployment is configured correctly."
- "Passwords are hashed; selected credentials are encrypted at rest with a key
  held by the OpenMapX deployment."
- "Ordinary synchronized content is not end-to-end encrypted. The OpenMapX
  server and operator can process it."
- "Encrypted Mangrove key modes keep that signing key encrypted in database
  storage, but a compromised web application could target the key after the
  browser unlocks it."
- "Passkeys authenticate you; registering a passkey does not encrypt your saved
  places, routes, vehicle, parking, or Timeline data."
- "Deleting live data does not rewrite an existing backup; retained erasure
  requests are replayed if that backup is restored."

Do not use "zero knowledge," "operator-proof," "E2EE," or "the server cannot
read your data" without naming the exact field, client, threat actor, and
remaining metadata.

## Standards and primary references

- [W3C Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/) — PRF
  capability and authenticator behavior.
- [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/) — same-origin
  script and key-storage security limitations.
- [NIST Key Management Guidelines](https://csrc.nist.gov/projects/key-management/key-management-guidelines)
  — lifecycle, rotation, protection, and recovery.
- [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final) — authenticated
  encryption with GCM, IV requirements, and additional authenticated data.
- [RFC 9180: HPKE](https://www.rfc-editor.org/rfc/rfc9180.html) — standardized
  recipient encryption/key wrapping.
- [RFC 9420: MLS](https://www.rfc-editor.org/rfc/rfc9420.html) — group membership
  epochs and message protection.
- [RFC 9106: Argon2](https://www.rfc-editor.org/rfc/rfc9106.html) — password-based
  key derivation guidance.
- [RFC 9958: Crypto Agility](https://www.rfc-editor.org/rfc/rfc9958.html) —
  versioning and algorithm replacement.
- [RFC 8446: TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html) — transport
  protection and traffic-analysis considerations.

## Consequences and follow-up work

This decision immediately makes the trust model reviewable and prevents broad
security claims. It does not hide existing server-readable content.

Follow-up issues should be small and independently reviewable:

1. Specify and migrate a versioned server-secret envelope with key identifiers,
   AAD context binding, and rotation for `OPENMAPX_SECRETS_KEY` users.
2. Decide whether to remove the explicit unencrypted Mangrove private-key mode.
3. Add automated assertions around cache classification and Better Auth's
   expected credential-at-rest behavior so dependency upgrades cannot silently
   weaken it.
4. Choose one initial class-5 content type only after the required gates pass;
   saved-place notes or a new private collection are smaller candidates than
   routes or live location.
5. Commission the required security review before implementing any client-key
   protocol.
