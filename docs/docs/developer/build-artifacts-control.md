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
Inspection and forward checks acquire that same per-lease guard before reading
and publishing their private high-water observations. A busy/crashed writer fails
closed; read-only inspection cannot overwrite a newer process's observation.

The data-manager-to-agent HTTP receiver derives the required targets from the
parsed operation: primary stop/restart/promotion require `motis`, staging
stop/restart require `motis-staging`, and proxy validation/reload requires
`motis-feed-proxy`. Restart does not start dependencies and promotion uses
`--no-deps`. The signed grant must contain those targets, independently of its
body fingerprint and resource policy. Other operation families remain unavailable
through this receiver until their fixed manifest/generation resolver exists.

Use `acquireArtifactTargetLease`, `delegateArtifactTargetLease`,
`adoptArtifactTargetLease`, `settleArtifactTargetLeaseChild`,
`releaseArtifactTargetLease` and `reconcileArtifactTargetLease`. All verified
contexts are nominal. An inherited borrower cannot expand targets or acquire a
second root. `withArtifactTargetLease` checks forward permission and retains fences
on failure; its callback must produce durable own-effect evidence before release.
Acquisition has one five-second budget. The limits are 256 registered targets,
64 child intents, 128 KiB per lease ledger and 256 unsettled leases. Settled
receipts remain retained under the capacity policy below.

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
Its separate signed lifecycle binds the original execution, monotonic sequence,
phase and at most 64 child-intent digests. Each transition persists its private
fence before shared publication under the execution writer guard. Terminal effect
receipts fence new grants; `cancelControlExecution` persists cancellation and
returns the original attempted identities for the future runtime's authenticated
cancellation/lookup adapter. `assertControlExecutionForward` and
`beginControlEffect` validate the complete deadline-only ancestry. New adoption
and effect-start intent share the lifecycle guard with cancellation. Exact
already-adopted duplicates remain usable for observation/settlement after cancel,
terminal state or expiry, and do not renew forward permission.
Acquiring a child's independent target lease and forward use of its bound handle
also check this lifecycle. Terminal maintenance/handoff preparation has only its
explicit frozen delegation exception: current signed terminal preparation,
unexpired identity, original admitted plan and held lease ancestry are all still
required. It cannot restart ordinary effects.

Target borrowers also check every intermediate ancestor. Canceling an intermediate
borrower fences its retained descendants and returns their original attempted
identities without deleting or settling any descendant evidence.

### Authority storage capacity and retirement

The lifetime limits below are an interim fail-closed bound. They are not an
accepted policy for routine administration: renewable retention remains
unimplemented pending the control-identity contract described below.

`CONTROL_RETENTION_LIMITS` currently fixes these installation lifetime limits:

- At most 1,024 admitted executions per role recovery root, including fixed
  children sharing the agent root. A signed immutable admission reserves capacity
  before witness publication or effects. Existing identities and settlement remain
  accessible when admission is full.
- At most 1,024 lease histories across the physical installation and 256 active
  leases. Exclusive fixed admission slots reserve both before target acquisition;
  only authoritative root release removes an active slot. Terminal histories and
  partial published histories keep their retained slot. Acquisition starts its
  five-second budget before admission work and probes at most 1,024 history slots
  plus 256 active slots, without listing or opening historical ledgers.
- Exactly 18 fixed private receipt namespaces, each capped at 65,536 records
  (1,024 executions times 64 intents); the execution namespace has the stricter
  1,024 limit. Each private record is at most 128 KiB, so even the conservative
  aggregate private record ceiling is finite, below 145 GiB per role, excluding
  filesystem overhead. Actual typed key/admission/effect records have tighter
  schema limits. Durable private counters reserve creation before publication;
  bounded streaming enumeration is needed only to initialize a missing counter.
  Failed reservations consume capacity rather than allowing undercount/reuse.
- Fixed-child keys use a direct public-key-digest index plus exact challenge read,
  never a historical key-directory scan. Each execution may allocate at most 64
  keys and no more than its admitted plan length. Shared witnesses are bounded by
  the admitted execution count: immutable witness, lifecycle and attempted-child
  map each at most 64 KiB, plus at most 4 KiB of key identities and a bounded
  prepared witness. Lease ledgers remain capped at 128 KiB/64 children.

There is **no online retirement** of terminal records or key/identity slots.
Terminal records therefore survive at least 72 hours; unresolved records survive
regardless of age, deadline or PID. This deliberately trades lifetime throughput
for exact one-use/replay evidence: exhaustion refuses new work and requires
supervised offline capacity planning/recovery after all relevant writers/helpers
stop. No constructor resets counters, deletes aged evidence or rotates trust to
make room. Automatic bounded retirement with sustained throughput is not supplied
by this foundation. Older lease layouts without the admission index require
supervised indexing; startup never silently excludes their fences. A crashed
metadata guard likewise requires supervised recovery.

#### Renewable retention and operation identity

The current protocol accepts opaque `opk1_` keys and permits an unparented root
to omit its requested deadline. On first admission that root receives a deadline
based on the current admission time. A duplicate instead needs its original
admission time; an expired missing attempt must remain unknown and must not be
retried as a new mutation (control protocol section 2). Section 3.2 also requires
producers never to reuse keys.

After the per-key admission details are reclaimed, the same root operation/key
without a requested deadline is indistinguishable from a first admission. Fresh
normalization gives it a new deadline and fingerprint. A timestamp retirement
floor cannot identify that old key: both newly assigned times exceed the floor.
Keeping every spent key would recreate unbounded history; a bounded spent-key
cache eventually loses this exact recognition. Deadline expiry still rejects
the original unchanged signed child grant, but does not solve this root case.

The proposed minimal protocol amendment is an issuer-controlled monotonic birth
sequence encoded in control root keys, with that origin certified through the
existing child authority chains. A durable private retirement floor, with bounded
exceptions for unresolved original authorities, can then reject retired origins
without remembering every old key. The fixed child phase-key hash can remain
unchanged if signed origin evidence accompanies derived child keys. Legacy
undated roots need an explicit cutover rule: retained originals remain readable,
and missing old roots cannot be normalized into fresh authority. Ordinary
transport timestamps are not this birth evidence.

This is a proposed amendment, not an implemented protocol or a renewal guarantee.
The protocol owner must define the root issuance/cutover and signed origin
binding before retirement can reclaim terminal details and keys. Any resulting
collector must still retain terminal evidence for at least 72 hours and through
authority validity, preserve every unresolved dependency, and coordinate signed
cross-role settlement and crash-safe counters/indexes before reuse. No expiry,
PID check or counter reset is settlement proof.

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
