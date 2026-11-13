---
title: Build bundles and target authority
description: "What the update control plane guarantees, the terms it uses, its current state machines and the target design that replaces the signed layer."
---

# Build bundles and target authority

`@openmapx/core/build-artifacts` is a server-only surface. It is intentionally absent
from the browser barrel. CLI bundle commands use the same bounded validator and
writer; uploaded archives never invoke shell extraction.

This page has two halves. The first describes what the update control plane
guarantees, the words it uses and the states it moves through today. The second
records the bundle contract and the signed authority layer as implemented. The
section [Target design (not yet implemented)](#target-design-not-yet-implemented)
describes the simpler design that replaces the signed layer; each change that
implements part of it moves the affected rows into the current sections.

## Guarantee matrix

The matrix assumes one Docker host and one maintainer. Host and Docker
administrators are trusted. The threat is a compromised application service (API,
data-manager or a community service) or a crash of any process at any point.

The verdict says what happens to each mechanism group in the replacement. "Keep"
means the mechanism stays as it is. "Simplify" keeps the guarantee and replaces
the form. "Cut" removes the mechanism because the guarantee it protects comes from
elsewhere. The last column names the crash-point scenarios that are to show the
guarantee survives the replacement, each with its status in the suite's catalogue
(`apps/api/src/services/__tests__/crash-points/README.md`). "Pinned" scenarios
pass today. An "expected failure today" is committed with its full expectations
and listed as a known failure: it fails today with a recorded signature and must
pass once the replacement removes the defect. "Not yet pinned" names a scenario
the suite cannot express yet; the guarantee has no crash-point evidence until
it is.

| Mechanism group                                                                                                               | Failure prevented                                                                                                           | How credible                                                                                                                                                                                                                                                                                                                                                    | Verdict                                                          | Crash-point scenario (status)                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typed agent operations, per-role agent and data-manager tokens with route allowlists, resource policy, owned-service resolver | A compromised API or data-manager runs arbitrary Docker commands or widens the targets it may touch                         | The real boundary against a compromised service                                                                                                                                                                                                                                                                                                                 | Keep                                                             | Same key with a different body is a conflict (pinned); each data-manager token reaches only its own routes (pinned)                                                                                                                                                                                                                                    |
| Separate Postgres roles for the API and data-manager                                                                          | A compromised data-manager forges API rows: accounts, administrative jobs or desired configuration                          | Real against data-manager: PostgreSQL privileges, a command allowlist and restores that recreate each role's objects as that role. A compromised API can still make data-manager, OpenConditions' roles or the tile owner run its functions through `public`, never the superuser; an operator's superuser session can run a role's code (see Known weaknesses) | Keep                                                             | Restore of the pre-update backup (not yet pinned). Until it is, the PostGIS entrypoint test (`scripts/postgis-entrypoint.test.ts`), the database role test (`apps/api/src/db/__tests__/database-roles-postgres.test.ts`) and the owners-and-grants restore test (`packages/cli/__tests__/backup-restore-postgres.integration.test.ts`) cover the roles |
| Agent job journal and idempotent operation keys                                                                               | A retry after a lost reply applies an operation twice                                                                       | Observed need: an earlier missing journal caused an eight-hour outage                                                                                                                                                                                                                                                                                           | Keep                                                             | Lost reply on configuration prepare (expected failure today); lost reply on data fence prepare and settle (pinned)                                                                                                                                                                                                                                     |
| Drain before self-replacement, ordered recreate, agent last                                                                   | A self-update leaves services half-replaced, or the agent replaces itself while work is in flight                           | Observed need                                                                                                                                                                                                                                                                                                                                                   | Keep, simplify the helper                                        | Helper killed mid-recreate (pinned); agent restarted while the helper runs (pinned); CLI command while the helper runs (expected failure today)                                                                                                                                                                                                        |
| Configuration generations, one atomic pointer, retention against live containers                                              | A crash leaves a half-written configuration, or pruning removes files a running container still uses                        | Observed need                                                                                                                                                                                                                                                                                                                                                   | Keep                                                             | API killed between saving desired rows and applying the generation (expected failure today)                                                                                                                                                                                                                                                            |
| Pre-pull, release manifest digests, post-recreate verification                                                                | An unavailable registry or an unhealthy image is discovered after the old containers are gone                               | Real failures, about the right size                                                                                                                                                                                                                                                                                                                             | Keep                                                             | Registry outage before maintenance (pinned); new image unhealthy after recreate (pinned)                                                                                                                                                                                                                                                               |
| Confined hardlinks, archive validation, descriptor-anchored paths on shared data                                              | A peer plants a symlink on `/data` and redirects an agent write                                                             | Real: data-manager can write `/data`                                                                                                                                                                                                                                                                                                                            | Keep, narrowed                                                   | Unit tests only                                                                                                                                                                                                                                                                                                                                        |
| Backup workflow and administrative job runner with one job owner                                                              | Two API processes run the same job, or a double-submitted update creates two jobs                                           | Real, about the right size                                                                                                                                                                                                                                                                                                                                      | Keep                                                             | Concurrent admissions (pinned); API killed after the job is claimed (expected failure today)                                                                                                                                                                                                                                                           |
| "Unknown never releases", effect-started record, cancellation fence                                                           | A crash after an effect began is mistaken for "nothing happened" and the targets are released or the effect is repeated     | The most valuable rule in the layer                                                                                                                                                                                                                                                                                                                             | Keep the rule, simplify the form to one journal row              | Agent killed while a Compose effect is in flight (expected failure today); agent killed after accepting, before the effect (pinned); cancelled during the fence settle (pinned); cancelled mid-recreate (expected failure today); deadline variants (not yet pinned)                                                                                   |
| Target leases and the child inventory                                                                                         | Two writers (agent, host CLI, data job, helper) change one service at once, or a surviving delegated writer loses its claim | Real guarantee; a kernel lock cannot cover a surviving helper                                                                                                                                                                                                                                                                                                   | Simplify to durable rows in one agent-private store              | Concurrent admissions (pinned); a surviving data-manager child after an agent restart (not yet pinned)                                                                                                                                                                                                                                                 |
| Data-job fence                                                                                                                | Configuration maintenance runs while a data job writes the same data                                                        | Postgres is the right tool                                                                                                                                                                                                                                                                                                                                      | Simplify to one SQL row under the existing advisory lock         | Data-manager restarted while the fence is held (pinned); an update requested while a data job runs (pinned); data-manager killed during a data job while the agent is down (not yet pinned)                                                                                                                                                            |
| Maintenance state machine and candidate lifecycle                                                                             | A crash between saving and applying configuration leaves rows and files disagreeing                                         | Real guarantee, very large form                                                                                                                                                                                                                                                                                                                                 | Simplify to one record and three phases                          | API killed between saving desired rows and applying the generation (expected failure today)                                                                                                                                                                                                                                                            |
| Configuration writer lock and artifact-store lock                                                                             | Two writers render or publish at once                                                                                       | Real; today a crash inside the lock needs a manual `rmdir`                                                                                                                                                                                                                                                                                                      | Simplify to a recoverable lock never held across a Docker effect | Concurrent admissions (pinned); CLI command while the helper runs (expected failure today)                                                                                                                                                                                                                                                             |
| Release overlay and selection receipts                                                                                        | Images and configuration drift apart                                                                                        | Two pointers where one suffices                                                                                                                                                                                                                                                                                                                                 | Simplify to image pins inside the generation                     | Registry outage before maintenance (pinned)                                                                                                                                                                                                                                                                                                            |
| Two data-manager admission models                                                                                             | A crashed legacy data job blocks all data work                                                                              | The second model caused that failure                                                                                                                                                                                                                                                                                                                            | Merge                                                            | Data-manager killed during a data job while the agent is down (not yet pinned)                                                                                                                                                                                                                                                                         |
| Role keys, certificates, per-lease and child keys, signed assertions, witnesses                                               | A role forges another role's lease records on the shared ledger                                                             | Exists only because lease state sits on shared `/data`                                                                                                                                                                                                                                                                                                          | Cut once lease state moves to the agent store                    | Covered by the authority gate (agent state mounted nowhere else) and the pinned scenarios above                                                                                                                                                                                                                                                        |
| Sequence numbers, retention clock, quotas, retention families, retirement commits, byte budgets, `mkdir` guards               | Unbounded growth of signed records, replay after deletion                                                                   | Self-inflicted by the signed records; a time-based prune replaces it                                                                                                                                                                                                                                                                                            | Cut                                                              | Agent state filesystem full right after an effect (pinned)                                                                                                                                                                                                                                                                                             |
| Settlement cells and slots, the no-guard closure, recovery proofs                                                             | A lost settle reply leaves the fence held forever                                                                           | Third-order machinery                                                                                                                                                                                                                                                                                                                                           | Cut, replaced by an idempotent settle and an operator exit       | Lost reply on data fence settle (pinned)                                                                                                                                                                                                                                                                                                               |
| Sealed configuration snapshot queue and its lock                                                                              | The agent applies a configuration the API did not approve                                                                   | File transport created the need                                                                                                                                                                                                                                                                                                                                 | Cut, the payload travels in the authenticated operation          | API killed between saving desired rows and applying the generation (expected failure today)                                                                                                                                                                                                                                                            |

## Glossary

- **Target.** A service ID, such as `motis` or `app-api`, whose containers a writer
  may change. Writers claim targets before any Docker effect.
- **Lease.** A durable claim on a set of targets by one execution. While it is
  held, no other writer may begin an effect on those targets. Today a lease is a
  signed owner certificate plus target lock files in the shared ledger under
  `infra/docker/data/.admin-target-control/`.
- **Child.** A delegated unit of work recorded under a lease before it starts: a
  fixed CLI child, a data-manager job or the configuration helper. A lease cannot be
  released until every attempted child is settled.
- **Adoption.** The step in which a child process or peer verifies the child intent
  recorded for it and takes it over. A child may begin effects only after adoption.
- **Settlement.** Recording the final outcome of a child or effect from structured
  evidence, so that its lease or fence can be released. Errors alone, expired
  deadlines and dead processes do not settle anything.
- **Fence.** The data-job fence: a `data_manager.jobs` row with
  `kind = 'configuration-maintenance'` that blocks data-job admission while
  configuration maintenance holds it. Its `guardState` is the fence's state.
- **Guard.** Either the fence's `guardState`, or a `mkdir` writer guard: a
  directory whose existence excludes a second writer from a record family. A crash
  inside a `mkdir` guard leaves the directory behind until an operator removes it.
- **Generation.** An immutable rendered configuration directory under
  `infra/docker/state/ops-agent/configuration/generations/`, named `cfg1_…`.
- **Pointer.** The symbolic link `infra/docker/state/ops-agent/configuration/current`
  that names the live generation. Switching generations is one atomic rename of the
  pointer.
- **Journal.** The agent's job journal, `infra/docker/state/ops-agent/jobs-v1.json`,
  written by atomic rename. It holds every operation the agent admitted and its
  state.
- **Operation key.** The caller-chosen idempotency key of an agent operation,
  `opk1_…`. New root operations use timed keys, `opk1_t1_<expiry>_<nonce>`. The same
  key with the same body returns the original operation; with a different body it
  is a conflict.
- **Origin.** The `{rootKey, issuer, notAfter}` identity of the root operation that
  started a tree of executions. Descendants inherit it.
- **Family.** All retained signed records that share one origin. Retention
  collects records family by family.
- **Receipt.** A signed record of an execution's terminal outcome, retained so that
  another role can verify it.
- **Witness.** A signed observation of host configuration sources, used to show
  that the sources a plan was approved against have not changed.
- **Role** and **principal.** A role is one of the processes that hold authority:
  API, data-manager, ops-agent, host CLI and the helper. A principal is the role a
  caller has authenticated as at a receiver, for example the role behind a
  data-manager bearer token.
- **Attempted.** An operation or child that was recorded as about to begin. From
  this point a crash cannot prove that nothing happened.
- **Effect started.** The record written immediately before the first host effect,
  such as a Docker call.
- **Unknown.** The outcome of an attempted operation that has no structured terminal
  evidence. Unknown never releases a target or a fence.
- **`recovery_required`.** The state of an operation whose outcome is unknown after
  a restart or lost evidence. It is never re-dispatched automatically; it holds its
  targets until an operator or a forward recovery path resolves it.

## Current transition tables

### Agent job states

`OpsJobState` in `@openmapx/core/ops/contract`, journaled by `apps/ops-agent`.
Terminal states carry `errorClass` when they are not `succeeded`.

| From                                       | Event                                                       | To                                                              |
| ------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------- |
| (none)                                     | Operation admitted and journaled                            | `queued`                                                        |
| `queued`                                   | Worker starts                                               | `running`                                                       |
| `running`                                  | Typed result                                                | `succeeded`                                                     |
| `running`                                  | Classified failure                                          | `failed` with its `errorClass`                                  |
| `queued`, `running`                        | Cancellation request or deadline while the worker is active | `termination_pending`                                           |
| `termination_pending`                      | Deadline passed and the worker stopped                      | `timed_out` (`errorClass: timeout`)                             |
| `termination_pending`                      | Cancellation completed                                      | `failed` (`errorClass: runtime`)                                |
| `termination_pending`                      | A fixed leaf handler had already committed its host call    | `succeeded`                                                     |
| `queued`, `running`, `termination_pending` | Agent restart finds the entry unfinished                    | `failed` (`errorClass: recovery_required`); never re-dispatched |
| Any non-terminal                           | Recovery forced while the worker is active                  | `termination_pending`, then `failed` (`recovery_required`)      |

### Data-manager fence states

`guardState` in the fence row's `metadata.configurationMaintenance`, mirrored in a
signed record under `control-private/data-manager/configuration-maintenance/`.

| From                        | Event                                               | To                             |
| --------------------------- | --------------------------------------------------- | ------------------------------ |
| (none)                      | Agent prepares maintenance; row inserted            | `preparing`                    |
| `preparing`                 | Signed mirror and row both written                  | `prepared`                     |
| `prepared`                  | Agent settles; mirror written before the row update | `settling` (mirror only)       |
| `settling`                  | Row updated with the settlement control             | `settled`                      |
| Missing or unreadable state | Read by admission or inspection                     | treated as `recovery_required` |

Data-job admission refuses while any fence row is not `settled`.

### API administrative job status

`admin_job.status` in `apps/api`.

| From                        | Event                                                        | To                                    |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| (none)                      | Job created                                                  | `queued`                              |
| `queued`                    | Cancel with no pending receipt delivery or managed operation | `canceled`                            |
| `queued`                    | Claimed by a job owner                                       | `running`                             |
| `running`                   | Job completed                                                | `success`                             |
| `running`                   | Job failed                                                   | `failed`                              |
| `running`, `cancel_pending` | Cancel requested                                             | `cancel_pending`                      |
| `cancel_pending`            | Agent operations contained                                   | `canceled`                            |
| `cancel_pending`            | Recovered failure that still needs candidate cleanup         | `running`, with observation `unknown` |

### API observation state

`admin_job.result.observation` records why a running job is waiting instead of
finishing. A job with an observation, or with status `cancel_pending`, is picked up
again when `nextCheckAt` passes.

| Observation state  | Reason                                                                                     | Set when                                                                           | Cleared when                                                       |
| ------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `unknown`          | `transport`, `observer_deadline`, `recovery_required`, `unavailable` or `invalid_identity` | The API cannot yet read a terminal agent outcome                                   | A later observation reads the terminal outcome and the job settles |
| `receipt_delivery` | `receipt_delivery`                                                                         | A terminal outcome is copied but its acknowledgement to the agent is not confirmed | The acknowledgement is confirmed                                   |

Retries back off from 5 seconds to at most 60 seconds.

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
bundles fail with rebuild guidance. Import materializes the target's credentials
into a private candidate before it can declare readiness, and retains the original
bundle digest separately from the materialized fingerprint.

## Installation and process boundaries

Host `openmapx compose render` provisions exactly three Ed25519 role keys and one
public verifier bundle in `infra/docker/secrets`. Existing keys are validated and
reused; partial trust, changed roles, unsafe owners/modes, links and foreign
installation records are rejected. Keys and recovery records are never rotated
implicitly. `infra/docker/control-private/<role>` stays outside shared data mounts.
The agent mounts `infra/docker` and several of its subtrees; bind mounts over the
data-manager and host CLI keys and private directories hide those inside the agent
container. The external helper masks all role keys and uses the agent recovery
directory plus a fresh certified child key. Docker/host administrators remain
trusted.

Data-manager authenticates each HTTP caller by its own bearer token: `api`,
`ops-agent` (including the fixed CLI children the agent runs) or `host-cli`. The
route contract lists the callers each route admits; the configuration fence is
`ops-agent` only. Signed-control receivers pass that authenticated caller to
`verifyControlPeer` as the transport principal.

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
second root. Acquisition has one five-second budget. The limits are 256
registered targets, 64 child intents, 128 KiB per lease ledger and 256 unsettled
leases. Settled receipts remain retained under the capacity policy below.

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
returns the original attempted identities for the authenticated cancellation and
lookup adapter. `assertControlExecutionForward` and
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
  metadata together are capped at 2 MiB. The 22 fixed private receipt namespaces
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

Before an agent publishes a terminal journal row, its fixed live producer signs
the complete canonical terminal tuple digest and original terminal time in a
preallocated private `observations` record. This uses the existing role key,
namespace quota, family index and collection path. Own-effect settlement and
canonical terminal publication have separate digests. Configuration cleanup can
refine a prepared result while public status remains running, preserving its
first terminal time; sealing the canonical receipt freezes its tuple and time.
An already canonical digest cannot be replaced by either settlement or repair.

On agent startup, terminal retention repair rejoins the original signed admission,
exact authenticated own-effect proof and existing signed terminal commitment.
Every canonical tuple field and the original terminal time must match that
commitment; startup cannot sign a new tuple from the loaded public row.
A known result must match the signed
result body; a known failure needs signed never-started evidence. Borrowed workers
also need their exact retained settled lease proof. Configuration workers require
the fixed authenticated, inode-checked startup claim cleanup capability. Loaded
terminal state, age and missing processes do not prove containment. Missing,
mismatched or unknown proof keeps the fence. Repair publishes only the missing
canonical terminal digest and journal completion, preserving original admission,
result/failure, deadline and terminal time; duplicate restarts do not restart work
or postpone the 72-hour retention window.
Legacy families without the terminal authentication record or canonical
publication reservation remain observation/recovery-required; startup does not
upgrade them by trusting their public journal.

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
available.

Settlement requires signed retained structured evidence from the fixed executor:
a parsed typed result, exact fixed-command completion, or an execution that has
never started effects. Errors alone produce unknown evidence. Arbitrary text,
caller booleans, IDs, expired deadlines and dead processes cannot release targets.
Private effect bodies remain outside shared journals. Known committed evidence
cannot be erased by a later response/journal failure. Startup restores original
admissions/adoptions and performs settlement from retained evidence, never dispatch.

The fixed maintenance inspector checks every mount's source, access mode and
mounted configuration/secret contents before it returns evidence. The signed
inspection retains a keyed digest and count of that complete canonical mount set;
it does not repeat each mount record inside the owner. Older canonical inspection
details remain readable. Record-size caps and all verification checks are unchanged.

Terminal maintenance and handoff preparation retain ownership. The preparer can
certify preparation only by reading its exact succeeded journal entry. The helper
may adopt early but `verifyConfigurationHelperReady` refuses drain until that
signed terminal preparation exists. Maintenance continuations remain frozen,
one-use subsets; helper descendants have no further edge.

The detached configuration helper may wait up to five seconds per source read or
initial adoption attempt sequence, within its original deadline, for family or
lease journal writer contention. Adoption retries cover only journal-entry and
initial-observation contention, before any adoption record is written; later
failures remain recovery-required. Waiting never removes locks or renews authority.

## Known weaknesses

**HMAC keys come from the signing keys.** The configuration source witness
(`configuration-source-witness.ts`) uses the PKCS #8 bytes of a role's or child's
Ed25519 private key directly as an HMAC-SHA-256 key for observation digests. One
key therefore serves two algorithms. No attack is known, but key separation is the
standard practice. The change that removes role keys and witnesses removes this
use; until then, treat any exposure of an HMAC digest's inputs and key handling as
exposure of the signing key.

**Database roles stop data-manager, not a compromised API.** Data-manager may
create only tables, indexes, sequences, its schemas and views without code. A
restore recreates each role's objects and loads its tables in a session of that
role, and refuses any other object of a role that cannot log in, before it drops
anything; the tile roles may create no objects. So no role's code runs as the
superuser at restore, and data-manager's code never runs as the API. The API is
trusted more, and keeps lateral moves. PostGIS lives in `public`, which the API
owns, and every role finds PostGIS and any other function or operator called
without a schema through it: a function or operator the API adds there runs as
whichever role calls the name, with or without the `public.` prefix, when it
matches the call's types more closely. That reaches data-manager,
OpenConditions' roles (the owner of `conditions` can change every OpenConditions
table and function) and `openmapx_tiles_owner` through the tile function. The
API's triggers, rules, policies and defaults on the `data_manager` tables it
owns run as data-manager too. Moving PostGIS out of `public` would close the
overload path, at the cost of reinstalling PostGIS and every spatial column and
index. An operator's own superuser session runs a role's code with superuser
rights when it reads or writes an object the role owns, or calls a function or
operator in `public`, by name or through its search path, so make such changes
as the owning role (`psql -U openmapx_api` in the PostGIS container), or with
`SET search_path = pg_catalog` and no PostGIS calls. Every role can read
PostGIS's catalogue tables (`spatial_ref_sys`, `geometry_columns`,
`geography_columns`, `topology.topology`, `topology.layer`). OpenConditions
installed after PostGIS started needs a PostGIS restart before traffic tiles
work; until then they fail with a permission error.

## Target design (not yet implemented)

These tables describe the design that replaces the signed layer. Nothing in this
section is implemented yet. Each change that implements part of it moves the
affected rows into the current sections above and deletes them here.

**One authority.** The ops-agent is the only owner of host mutation. Its state
lives in `infra/docker/state/ops-agent/`, which no other service mounts. File
modes alone are not treated as isolation.

**Rules that do not change:** unknown never releases; attempted is recorded before
any effect; startup never re-dispatches an attempted operation; the same key with
a different body is a conflict; a lease is released only when every attempted
child is terminal.

### Operation record

`OperationRecord { key, kind, bodyDigest, state, result?, parentKey?, deadlineAt,
createdAt, terminalAt? }`, one durable row per operation in the agent store,
written by atomic rename with fsync.

| From                          | Event                                             | To                             |
| ----------------------------- | ------------------------------------------------- | ------------------------------ |
| (none)                        | Authenticated operation admitted                  | `accepted`                     |
| `accepted`                    | About to begin; recorded before any effect        | `attempted`                    |
| `attempted`                   | Immediately before the first host effect          | `effect_started`               |
| `attempted`, `effect_started` | Structured result or failure                      | `terminal`                     |
| `accepted`                    | Cancelled or past its deadline before any attempt | `terminal` (failed, no effect) |
| `attempted`, `effect_started` | Restart, or outcome otherwise unknown             | `recovery_required`            |
| `recovery_required`           | Operator resolves it as committed or failed       | `terminal`                     |

Startup never moves `attempted` or `effect_started` back to `accepted`.

### Lease record

`LeaseRecord { leaseId, ownerOperationKey, targets, children, state }`, where each
child names a data-manager job or helper container.

| From   | Event                                    | To                                              |
| ------ | ---------------------------------------- | ----------------------------------------------- |
| (none) | Owner operation acquires free targets    | `held`                                          |
| `held` | Owner and every attempted child terminal | `released`                                      |
| `held` | Owner or a child is `recovery_required`  | stays `held` until an operator exit resolves it |

### Data-job fence row

One row in `data_manager` under the existing advisory lock. `prepare` and `settle`
are idempotent and callable only by the agent. `prepare` refuses while unfinished
or unknown data jobs exist; data-job admission refuses while the row is `prepared`.

| From       | Event                                      | To                                     |
| ---------- | ------------------------------------------ | -------------------------------------- |
| (none)     | Agent `prepare`                            | `prepared`                             |
| `prepared` | Agent `prepare` with the same key and body | `prepared` (original receipt returned) |
| `prepared` | Agent `settle`                             | `settled`                              |
| `settled`  | Agent `settle` retry                       | `settled` (original receipt returned)  |

### Other target rules

- **Writer lock.** The CLI goes through the agent when it is up. When the agent is
  down, a lock file records PID, boot ID and process start time, and is reclaimed
  only when that process is provably gone. The lock is never held across a Docker
  effect.
- **Desired configuration.** The payload travels in the authenticated operation.
  The job row moves through three phases: candidate prepared; rows and decision
  saved in one transaction; generation applied by a keyed operation. Recovery runs
  the same forward code.
- **Generation.** Configuration and image pins sit behind one atomic pointer. The
  previous pointer is the manual rollback target.
- **Bounded storage.** A record is pruned when it is terminal, its key has expired
  and it has no unsettled child. `recovery_required` records are kept until
  resolved.
- **Operator exit.** `openmapx control status`, plus `control clear --op <key>` or
  `control resolve --as committed|failed`: host-only, printing what is believed
  live, and audited.
- **Self-update order.** Pull first, drain, run the helper from the current image,
  recreate in order with verification after each service, agent last.
