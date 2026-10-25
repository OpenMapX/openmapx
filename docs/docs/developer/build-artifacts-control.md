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

New root authority uses `opk1_t1_<14 lower-case hex expiry>_<22 canonical
base64url nonce>` keys. The nonce contains 16 random bytes; the expiry is an exact
millisecond deadline, explicitly supplied before first submission and no more
than seven days ahead. The browser-safe `@openmapx/core/ops/control-root-key`
entry point formats and parses these keys without Node imports. The runtime may
clamp its execution budget independently. Existing undated admissions remain
available for observation, cancellation and settlement; a missing undated root
returns `control_upgrade_required` before effects. Retrying an opaque intent with
a newly minted timed key is not recovery.

A version 2 signed admission, witness, lease certificate or grant binds the
original `{version, rootKey, issuer, notAfter}` origin. Descendants, including a
child's independent lease, inherit this origin through verified parent authority.
Raw caller JSON cannot supply it. Each role holds a signed private retirement
clock and high-water record. A zero floor is provisioned only with a verified new
installation's trust bundle. Missing, corrupt or rolled-back state in an existing
installation requires supervised recovery; provisioning never resets its floor.
A backward wall clock blocks new forward work and collection while retained
observation and settlement stay available.

`CONTROL_RETENTION_LIMITS` bounds retained state and admission work:

- Each role has 1,024 reusable origin-family slots. The physical installation has
  256 active lease slots and 1,024 retained lease-history slots. Slot identities
  include both inode and generation; partial reservations consume capacity.
- An origin permits 128 executions and 256 attempted intents, with at most 64
  children per node and the fixed protocol depth of two. Fixed-child keys have a
  direct digest index, not a scan through historical keys.
- Each role-family has at most 4,096 indexed records in 64 pages of 64 entries,
  each page at most 16 KiB. Its ordinary index, proof, acknowledgement and progress
  metadata together are capped at 2 MiB. The 19 fixed private receipt namespaces
  each permit at most 65,536 records of at most 128 KiB. Namespace creation
  counters and high-water records reserve capacity before publication.
- Retirement cells are reserved before effects and remain writable outside the
  ordinary record quota. A capacity refusal occurs before effects. Reconciliation
  examines at most 16 families by default, accepts 1–64, saves a round-robin cursor
  past pending families, and reads index pages incrementally.

A family becomes eligible only after its origin expires, at least 72 hours after
its latest authoritative terminal receipt, and after every attempted execution,
child and independent lease is known contained. Target locks must have been
physically released. Live helpers, journal workers, effect writers and streams
keep it pending. An unaccepted attempted child, unknown effect, corrupt index,
offline participant, missing proof or unknown writer keeps the original evidence
regardless of age or PID.

The origin's coordinator freezes a signed manifest. The coordinator raises its private durable expiry floor before preparing the
manifest. Each actual participant retains its exact proof copy, then signs ready. All ready acknowledgements and any API terminal-copy acknowledgement
are required before commit. Each role raises its private durable expiry floor before deleting its own private
indexed records and signing clean. Shared semantic evidence is removed only after every
participant is clean and a signed final proof exists. Each participant retains a
private final proof before release; the shared family slot is reusable only after
all required releases. Participants never open sibling-private directories.
Namespace deletion records `planned`, `unlinked`, `counted` and `item_done` in a
preallocated exact-identity transaction. Only an already retained matching plan
can resume an absent unlink. Counter decrements and slot reuse check the original
family, generation, manifest, ordinal and inode. A killed unknown writer is never
stolen automatically. Target release progress uses a certified sorted-target
prefix count and a pending target index, so all 256 maximum-length target IDs fit
within the signed admission journal's 4 KiB read/write budget. Writes validate the
actual schema and byte limit. Retained signed name-list progress within that
budget is checked against the exact certified prefix before compact recovery.

On agent startup, terminal retention repair rejoins the original signed admission
and exact authenticated own-effect proof. A known result must match the signed
result body; a known failure needs signed never-started evidence. Borrowed workers
also need their exact retained settled lease proof. Configuration workers require
the fixed authenticated, inode-checked startup claim cleanup capability. Loaded
terminal state, age and missing processes do not prove containment. Missing,
mismatched or unknown proof keeps the fence. Repair publishes only the missing
canonical terminal digest and journal completion, preserving original admission,
result/failure, deadline and terminal time; duplicate restarts do not restart work
or postpone the 72-hour retention window.

### API parent checkpoints and terminal receipt delivery

Owned administrative jobs use `OpsProjection` version 3. A timeless logical step
address resolves its retained entry before time, body preparation or configuration
publication. A new step chooses its final timed key and requested deadline, then
atomically checkpoints that mapping, full operation, attempt and API parent under
the current database owner/version, active status, cancellation and absence
fences. Both current maps have a 64-entry capacity limit. Same-address contenders
observe the durable winner even at capacity; distinct contenders cannot erase
siblings or exceed the current row's limit. Parent preparation is pure until the
checkpoint succeeds. Unknown checkpoint outcome sends no POST.

Before consuming any authority-bearing terminal result, failure or cancellation,
the API checkpoints a bounded copy and `receiptDelivery: pending`. It then sends
the API-only, no-effect `controlRetention.acknowledge` operation with a canonical
HMAC proof using the existing API token. The terminal digest covers exact typed
version 2 terminal identity and result/failure fields, excluding changing progress
and diagnostic fields. Acknowledgement has a separate 15-second signal so a
stopped worker cannot strand a copied receipt. Only a confirmed checkpoint allows
return or throw of the terminal outcome. Pending copies keep the parent running
or `cancel_pending` with `receipt_delivery`; both completion SQL and actual expiry
cleanup preserve them. Terminal version 3 parents are retained for at least 72
hours. After full family collection, an exact valid acknowledgement retry is
accepted without creating records only when no retained/index/semantic evidence
remains and the timed root's expiry is covered by the private floor.

Current owned-job adapters persist the new root identity. Fixed CLI entry retains
its original phase key and verified inherited origin; it does not issue a new root.
Unowned direct mutation calls through `executeAndWait`, including direct
configuration mutation routes, return the explicit client-upgrade prerequisite
before POST or configuration preparation. These older producers need a durable
owned-job handoff before they can mutate; they do not receive a replacement root
from an opaque intent. Sync reads and retained legacy observations remain
available. The future receiver prerequisites below stay closed.

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
