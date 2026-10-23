# Build bundles and target authority

`@openmapx/core/build-artifacts` is a server-only surface. It is intentionally absent
from the browser barrel. CLI bundle commands use the same bounded validator and
writer; uploaded archives never invoke shell extraction.

## Bundle contract

The five portable layouts are tileserver, OSRM, OTP, Pelias and MOTIS. Other services
must use their database or service-specific backup workflow. Safe version 1 records
remain readable, including optional `sourcePbf` metadata. Version 2 adds source
hashes and a SHA-256 over sorted `[path, sizeBytes, sha256]` tuples. Historical
version 1 records do not acquire invented source hashes.

`validateBuildBundle` takes a readable stream, an empty private staging directory,
`ArtifactArchiveLimits`, and an abort signal. It returns the manifest, archive and
manifest digests, expanded file bytes and artifact fingerprint only after exact
membership and streamed digest verification. It accepts plain tar and gzip by
magic, bounds tar/PAX/GNU metadata before payload creation, and rejects links,
special files, duplicate/unsafe names, inconsistent sizes and trailing streams.
Files are created exclusively through descriptor-anchored parents with 0600/0700
modes. Linux uses `/proc/self/fd`; macOS uses the held descriptor's `/.vol/dev/ino`
anchor. Unsupported platforms fail closed.

The defaults are 1 TiB upload, 2 TiB expanded/entry bytes, 4 TiB stage policy,
250,000 entries, 64 MiB manifest, 4,096 path bytes, depth 64, 16 KiB extended
headers and expansion ratio 1,000 after 64 MiB. Aggregate stage reservations,
free-space/inode preflight, concurrent transfer admission and process memory
qualification belong to the transfer store; the archive module does not substitute
its byte limits for that store's reservations.

MOTIS export requires `motis/live/portable-sources.json`, a strict object containing
`version: 1`, `sourceFingerprints: [{id, sha256, sizeBytes}]` and
`credentialRequirements: string[]`. This retained producer metadata contains no
credential values. Export retains source archives and the data subtree, omits
generated configuration/proxy files, and writes a version 2 manifest with
`runtimeMaterialization: "motis-target-credentials"`. Credential-bearing legacy
bundles fail with rebuild guidance. Import cannot declare readiness until the
future target credential materializer is installed; it must retain the original
bundle digest separately from the materialized fingerprint.

## Installation and process boundaries

Host `openmapx compose render` provisions exactly three Ed25519 role keys and one
public verifier bundle in `infra/docker/secrets`. Existing keys are validated and
reused; partial trust, changed roles, unsafe owners/modes, links and foreign
installation records are rejected. Keys and recovery records are never rotated
implicitly. `infra/docker/control-private/<role>` stays outside shared data mounts.
The agent's checkout mount masks sibling keys and recovery directories. The
external helper masks all role keys and uses the agent recovery directory plus a
fresh certified child key. Docker/host administrators remain trusted.

Services read their fixed role key and verifier mounts on startup. Missing or
conflicting trust disables signed-control admission with a fixed host recovery
prerequisite, while status/recovery access remains available. Recovery instructions
require stopping all relevant writers/helpers and inspecting exact retained
receipts and publication state; age or a missing PID never permits lock removal.

## Execution and lease lifecycle

Fixed adapters retain the complete admitted operation and immutable `ExecutionRef`
before effects. Both body and execution fingerprints remain distinct. A role-signed
owner certificate binds the physical data root and sorted target lock inodes; a
private ephemeral key signs its mutable journal. Assertions identify bounded signed
records, never paths or private keys. Each recipient independently verifies the
installation, role, complete chain, current tree, immutable identity, subset and
absolute deadline. Per-lease journal guards and private sequence high-water marks
reject conflicting writers and shared-record rollback.

Use `acquireArtifactTargetLease`, `delegateArtifactTargetLease`,
`adoptArtifactTargetLease`, `settleArtifactTargetLeaseChild`,
`releaseArtifactTargetLease` and `reconcileArtifactTargetLease`. All verified
contexts are nominal. An inherited borrower cannot expand targets or acquire a
second root. `withArtifactTargetLease` checks forward permission and retains fences
on failure; its callback must produce durable own-effect evidence before release.
Acquisition has one five-second budget. The limits are 256 registered targets,
64 child intents, 128 KiB per lease ledger and 256 unsettled leases. Settled
receipts remain retained; this foundation performs no age-based garbage collection.

Host ordering is target lease, nonblocking transit reservation, configuration
writer, then release store. A busy reservation must settle an unused owner without
effects; a borrower settles its own node and never releases the parent. No writer
is held while awaiting a child that needs that same writer.

Only the fixed protocol graph is accepted, with borrowed depth at most two. Phase
keys derive from the original operation key and immutable plan ordinal. A lost
response never changes the phase key. Both peer directions and fixed CLI children
use the original identity/deadline. Fixed CLI spawn intents bind exact command
arguments and a fresh private child key; entry consumes a one-use start marker
before adoption can lead to effects. Unrelated subprocesses receive no authority
variables. Deadline-only Full Update forwarding owns no target lease.

Settlement requires signed retained structured evidence from the fixed executor:
a parsed typed result, exact fixed-command completion, or an execution that has
never started effects. Errors alone produce unknown evidence. Arbitrary text,
caller booleans, IDs, expired deadlines and dead processes cannot release targets.
Private effect bodies remain outside shared journals. Known committed evidence
cannot be erased by a later response/journal failure. Startup restores original
admissions/adoptions and performs settlement from retained evidence, never dispatch.

Terminal maintenance and handoff preparation retain ownership. The preparer can
certify preparation only by reading its exact succeeded journal entry. The helper
may adopt early but `verifyConfigurationHelperReady` refuses drain until that
signed terminal preparation exists. Maintenance continuations remain frozen,
one-use subsets; helper descendants have no further edge.

## Deferred product consumers

Task02.3 owns durable data-manager HTTP/row admission and containment. The existing
managed CLI mutation gate and data-manager control-header gate remain closed until
that receiver lands. Task01.2 owns maintenance decisions and orchestration;
Task05.3 owns durable paired-pin approval; Task08.3 owns configuration helper drain
and same-image recreation. Legacy ref-only approval now returns not-wired instead
of bypassing paired publication. These future consumers must use the fixed
constructors and original retained identities; named graph slots do not register
new executable operations or advertise transfer readiness.
