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

| Mechanism group                                                                                                                            | Failure prevented                                                                                                           | How credible                                                                                                                                                                                                                                                                                                                                                    | Verdict                                                                                                                   | Crash-point scenario (status)                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typed agent operations, per-role agent tokens, an API data-manager token held to the API's routes, resource policy, owned-service resolver | A compromised API or data-manager runs arbitrary Docker commands or widens the targets it may touch                         | The real boundary against a compromised service                                                                                                                                                                                                                                                                                                                 | Keep                                                                                                                      | Same key with a different body is a conflict (pinned); the API's data-manager token is refused on the agent's routes (pinned)                                                                                                                                                                                                                          |
| Separate Postgres roles for the API and data-manager                                                                                       | A compromised data-manager forges API rows: accounts, administrative jobs or desired configuration                          | Real against data-manager: PostgreSQL privileges, a command allowlist and restores that recreate each role's objects as that role. A compromised API can still make data-manager, OpenConditions' roles or the tile owner run its functions through `public`, never the superuser; an operator's superuser session can run a role's code (see Known weaknesses) | Keep                                                                                                                      | Restore of the pre-update backup (not yet pinned). Until it is, the PostGIS entrypoint test (`scripts/postgis-entrypoint.test.ts`), the database role test (`apps/api/src/db/__tests__/database-roles-postgres.test.ts`) and the owners-and-grants restore test (`packages/cli/__tests__/backup-restore-postgres.integration.test.ts`) cover the roles |
| Agent job journal and idempotent operation keys                                                                                            | A retry after a lost reply applies an operation twice                                                                       | Observed need: an earlier missing journal caused an eight-hour outage                                                                                                                                                                                                                                                                                           | Keep                                                                                                                      | Lost reply on configuration prepare (expected failure today); lost reply on data fence prepare and settle (pinned)                                                                                                                                                                                                                                     |
| Drain before self-replacement, ordered recreate, agent last                                                                                | A self-update leaves services half-replaced, or the agent replaces itself while work is in flight                           | Observed need                                                                                                                                                                                                                                                                                                                                                   | Keep, simplify the helper                                                                                                 | Helper killed mid-recreate (pinned); agent restarted while the helper runs (pinned); CLI command while the helper runs (expected failure today)                                                                                                                                                                                                        |
| Configuration generations, one atomic pointer, retention against live containers                                                           | A crash leaves a half-written configuration, or pruning removes files a running container still uses                        | Observed need                                                                                                                                                                                                                                                                                                                                                   | Keep                                                                                                                      | API killed between saving desired rows and applying the generation (expected failure today)                                                                                                                                                                                                                                                            |
| Pre-pull, release manifest digests, post-recreate verification                                                                             | An unavailable registry or an unhealthy image is discovered after the old containers are gone                               | Real failures, about the right size                                                                                                                                                                                                                                                                                                                             | Keep                                                                                                                      | Registry outage before maintenance (pinned); new image unhealthy after recreate (pinned)                                                                                                                                                                                                                                                               |
| Confined hardlinks, archive validation, descriptor-anchored paths on shared data                                                           | A peer plants a symlink on `/data` and redirects an agent write                                                             | Real: data-manager can write `/data`                                                                                                                                                                                                                                                                                                                            | Keep, narrowed                                                                                                            | Unit tests only                                                                                                                                                                                                                                                                                                                                        |
| Backup workflow and administrative job runner with one job owner                                                                           | Two API processes run the same job, or a double-submitted update creates two jobs                                           | Real, about the right size                                                                                                                                                                                                                                                                                                                                      | Keep                                                                                                                      | Concurrent admissions (pinned); API killed after the job is claimed (expected failure today)                                                                                                                                                                                                                                                           |
| "Unknown never releases", effect-started record, cancellation fence                                                                        | A crash after an effect began is mistaken for "nothing happened" and the targets are released or the effect is repeated     | The most valuable rule in the layer                                                                                                                                                                                                                                                                                                                             | Keep the rule, simplify the form to one journal row                                                                       | Agent killed while a Compose effect is in flight (expected failure today); agent killed after accepting, before the effect (pinned); cancelled during the fence settle (pinned); cancelled mid-recreate (expected failure today); deadline variants (not yet pinned)                                                                                   |
| Target leases and the child inventory                                                                                                      | Two writers (agent, host CLI, data job, helper) change one service at once, or a surviving delegated writer loses its claim | Real guarantee; a kernel lock cannot cover a surviving helper                                                                                                                                                                                                                                                                                                   | Done: rows in one agent-private store, `leases.json`, written under a recoverable lock                                    | Concurrent admissions (pinned); a surviving data-manager child after an agent restart (not yet pinned)                                                                                                                                                                                                                                                 |
| Data-job fence                                                                                                                             | Configuration maintenance runs while a data job writes the same data                                                        | Postgres is the right tool                                                                                                                                                                                                                                                                                                                                      | Done: one SQL row under the existing advisory lock                                                                        | Data-manager restarted while the fence is held (pinned); an update requested while a data job runs (pinned); data-manager killed during a data job while the agent is down (not yet pinned)                                                                                                                                                            |
| Maintenance state machine and candidate lifecycle                                                                                          | A crash between saving and applying configuration leaves rows and files disagreeing                                         | Real guarantee, very large form                                                                                                                                                                                                                                                                                                                                 | Simplify to one record and three phases                                                                                   | API killed between saving desired rows and applying the generation (expected failure today)                                                                                                                                                                                                                                                            |
| Configuration writer lock and artifact-store lock                                                                                          | Two writers render or publish at once                                                                                       | Real; a crash inside the lock no longer needs a manual `rmdir`                                                                                                                                                                                                                                                                                                  | Done for the writer, lease, backup-store and update receipt locks: a lock file reclaimed when its holder is provably gone | Concurrent admissions (pinned); CLI command while the helper runs (expected failure today)                                                                                                                                                                                                                                                             |
| Release overlay and selection receipts                                                                                                     | Images and configuration drift apart                                                                                        | Two pointers where one suffices                                                                                                                                                                                                                                                                                                                                 | Done: image pins and the manifest inside the generation; `openmapx control rollback`                                      | Registry outage before maintenance (pinned)                                                                                                                                                                                                                                                                                                            |
| Two data-manager admission models                                                                                                          | A crashed legacy data job blocks all data work                                                                              | The second model caused that failure                                                                                                                                                                                                                                                                                                                            | Merge                                                                                                                     | Data-manager killed during a data job while the agent is down (not yet pinned)                                                                                                                                                                                                                                                                         |
| Role keys, certificates, per-lease and child keys, signed assertions, witnesses                                                            | A role forges another role's lease records on the shared ledger                                                             | Exists only because lease state sits on shared `/data`                                                                                                                                                                                                                                                                                                          | Cut once lease state moves to the agent store                                                                             | Covered by the authority gate (agent state mounted nowhere else) and the pinned scenarios above                                                                                                                                                                                                                                                        |
| Sequence numbers, retention clock, quotas, retention families, retirement commits, byte budgets, `mkdir` guards                            | Unbounded growth of signed records, replay after deletion                                                                   | Self-inflicted by the signed records; a time-based prune replaces it                                                                                                                                                                                                                                                                                            | Done: one prune 72 hours after the root key expires; a free-space check at admission                                      | Agent state filesystem full right after an effect (pinned)                                                                                                                                                                                                                                                                                             |
| Settlement cells and slots, the no-guard closure, recovery proofs                                                                          | A lost settle reply leaves the fence held forever                                                                           | Third-order machinery                                                                                                                                                                                                                                                                                                                                           | Cut for the fence: settle is idempotent on the fence row. Recovery proofs stay until the operator exit                    | Lost reply on data fence settle (pinned)                                                                                                                                                                                                                                                                                                               |
| Sealed configuration snapshot queue and its lock                                                                                           | The agent applies a configuration the API did not approve                                                                   | File transport created the need                                                                                                                                                                                                                                                                                                                                 | Done: the payload travels in the authenticated request; candidates stay in the agent's own state                          | API killed between saving desired rows and applying the generation (expected failure today)                                                                                                                                                                                                                                                            |

## Glossary

- **Target.** A service ID, such as `motis` or `app-api`, whose containers a writer
  may change. Writers claim targets before any Docker effect.
- **Lease.** A durable claim on a set of targets by one execution. While it is
  held, no other writer may begin an effect on those targets. Leases are rows in
  the agent's store, `infra/docker/state/ops-agent/leases.json`; see
  [Lease store](#lease-store).
- **Child.** A delegated unit of work recorded under a lease before it starts: a
  fixed CLI child, a data-manager job or the configuration helper. A lease cannot be
  released until every attempted child is settled.
- **Adoption.** The step in which a child process or peer verifies the child intent
  recorded for it and takes it over. A child may begin effects only after adoption.
- **Settlement.** Recording the final outcome of a child or effect from structured
  evidence, so that its lease or fence can be released. Errors alone, expired
  deadlines and dead processes do not settle anything.
- **Fence.** The data-job fence: a `data_manager.configuration_fence` row that
  blocks data-job admission while its state is `prepared`.
- **Guard.** A `mkdir` writer guard: a directory whose existence excludes a second
  writer from a record. A crash inside a `mkdir` guard leaves the directory behind
  until an operator removes it.
- **Generation.** An immutable rendered configuration directory under
  `infra/docker/state/ops-agent/configuration/generations/`, named `cfg1_…`. It
  holds the compose file with the release's image pins and the release manifest
  those pins come from.
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
- **Prune.** The periodic removal of a role's records for a finished execution,
  72 hours after its root key expired.
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

One row per maintenance in `data_manager.configuration_fence`. `prepare` inserts
it under the data-admission advisory lock; `settle` is a conditional update
(`WHERE state='prepared'`) read back in the same transaction, so a racing data
admission sees the row either prepared or settled. Only the operations agent calls
`prepare` and `settle`, each with its signed prepare delegation; settle also
requires the agent's own data-manager token and the agent's maintenance lease
still held. A repeated prepare also settles the data-manager's lease child again,
which heals a crash between its effect record and that child.

| From       | Event                                                      | To                                      |
| ---------- | ---------------------------------------------------------- | --------------------------------------- |
| (none)     | Agent `prepare`; no unfinished or unknown data job exists  | `prepared`                              |
| (none)     | Agent `prepare` while a data job is unfinished or unknown  | no row; the leaf settles without effect |
| `prepared` | Agent `prepare` with the same body                         | `prepared` (recorded receipt returned)  |
| `prepared` | Agent `prepare` for the same maintenance with another body | `prepared` (409 conflict)               |
| `prepared` | Agent `settle` with the final outcome                      | `settled` with that outcome             |
| `settled`  | Agent `settle` with the same outcome                       | `settled` (settled receipt returned)    |
| `settled`  | Agent `settle` with another outcome                        | `settled` (409 conflict)                |

Data-job admission refuses while a row is `prepared`, and while any data job's
publication is unknown or a legacy job was interrupted unfinished. The agent
repeats the same prepare or settle body after a lost reply until the data-manager
answers. A refused or never-issued prepare leaves no row: the agent's prepare
fails without effect and its maintenance lease releases.

### API administrative job status

`admin_job.status` in `apps/api`.

| From                        | Event                                                | To                                    |
| --------------------------- | ---------------------------------------------------- | ------------------------------------- |
| (none)                      | Job created                                          | `queued`                              |
| `queued`                    | Cancel with no managed operation                     | `canceled`                            |
| `queued`                    | Claimed by a job owner                               | `running`                             |
| `running`                   | Job completed                                        | `success`                             |
| `running`                   | Job failed                                           | `failed`                              |
| `running`, `cancel_pending` | Cancel requested                                     | `cancel_pending`                      |
| `cancel_pending`            | Agent operations contained                           | `canceled`                            |
| `cancel_pending`            | Recovered failure that still needs candidate cleanup | `running`, with observation `unknown` |

### API observation state

`admin_job.result.observation` records why a running job is waiting instead of
finishing. A job with an observation, or with status `cancel_pending`, is picked up
again when `nextCheckAt` passes.

| Observation state | Reason                                                                                     | Set when                                         | Cleared when                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------ |
| `unknown`         | `transport`, `observer_deadline`, `recovery_required`, `unavailable` or `invalid_identity` | The API cannot yet read a terminal agent outcome | A later observation reads the terminal outcome and the job settles |

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

Each role keeps its control records as plain records in its own state directory:
the agent (with the fixed CLI children and the configuration helper it runs) in
`infra/docker/state/ops-agent/control`, data-manager in
`infra/docker/state/data-manager/control` (mounted at `/var/lib/openmapx/control`,
and by no other service), and the host CLI in `infra/docker/state/host-cli/control`.
None of them is on the shared data mount, and records are never signed: a record is
trusted because only its owner writes that directory. Everything read from disk or
the network is still schema-checked. Docker and host administrators remain trusted.

Data-manager authenticates each HTTP caller by its own bearer token: `api`,
`ops-agent` (including the fixed CLI children the agent runs) or `host-cli`. The
route contract lists the callers each route admits; the configuration fence is
`ops-agent` only. Control receivers pass that authenticated caller to
`verifyControlPeer` as the transport principal. The API names the job a child
operation belongs to in the `x-openmapx-parent-execution` header of its own
authenticated request; the agent accepts that header only from the API's token.

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
leases. Settled receipts remain until the control prune below removes them.

Host ordering is target lease, nonblocking transit reservation, then
configuration writer. A busy reservation must settle an unused owner without
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

### Lease store

Every lease lives in one file in the agent's state, `infra/docker/state/ops-agent/leases.json`,
replaced atomically under the recoverable lock `leases.lock` (see [Locks](#locks)). No
other service mounts that directory. The writers are:

- the agent, for its own operations;
- data-manager, through the typed agent operations `lease.acquire`, `lease.read`,
  `lease.update` and `lease.settleChild` over its own agent token;
- the host CLI, the agent's fixed CLI children, the configuration helper and the
  catalog bootstrap, which write the file themselves under the same lock.

A lease row names its owner execution, the targets (any registered service ID,
community services included) and the children recorded under it before they start.
A row is deleted when the owner and every attempted child have a known outcome; the
owner keeps its own release time in its private records. An unknown outcome keeps
the row until an operator resolves it.

| From   | Event                                                | To                                                       |
| ------ | ---------------------------------------------------- | -------------------------------------------------------- |
| (none) | Owner acquires free targets                          | `held`                                                   |
| `held` | Owner and every attempted child have a known outcome | `settled`, then the row is deleted                       |
| `held` | Owner or a child has an unknown outcome              | stays `held` until `openmapx control resolve` or `clear` |

Every Docker effect that changes containers takes its lease through one admission
path: stop, restart, start, recreate, update, remove, `stack.stop`, repository
removal, backup create and restore. Pull, build, exec and probes take none. A held
target refuses the operation before anything is recorded, with a busy error that
names the holder's executor, operation key, kind and state and points to
`openmapx control status`. On the host, `services stop|restart`, `compose down`
and `backup create|restore` take the same leases; `compose up` and
`services start` take none, so a running data job does not refuse them. In the
agent, only a Docker
command that ran to its own end and reported a failure with an exit code, while
the daemon still answered, records a contained, known outcome and releases the
lease; any other error, including every other failure of an agent backup, leaves
the outcome unknown and the lease held. On the host, an exit code from 1 to 127,
or an error that is not a signal or timeout while the daemon still answers,
releases the lease; a crash, timeout, killed process or lost daemon connection
leaves the outcome unknown and the lease held.

### Locks

The configuration writer (`state/ops-agent/configuration/writer.lock`), the lease
store (`leases.lock`), the backup store (`backups/.backup-store.lock`) and the CLI's
system update receipt each use one lock file. It records the holder's PID, boot ID,
PID namespace, container and process start time, and another writer reclaims it
only when that holder is provably gone: the machine booted since, the holder shares
this PID namespace and its process ended, or its container is no longer running.
A holder record that cannot be read, because its holder died between creating and
writing the file, is reclaimed only after it stayed the same for the wait (one
second for a lock that does not wait). Reclaimers take turns through a short guard
file beside the lock. A live holder, or a guard that is still there when the wait
ends, is named in a busy error. The writer and lease locks are never held across a
Docker effect. Agent backups and prunes hold the backup-store lock for the whole
effect, and a second one waits up to a minute; the host CLI's `backup
create|restore` takes a lease on every target instead, so a second one is refused
as busy.

Some dead holders cannot be proved gone, and their lock stays until
`openmapx control clear --lock <name>`:

- a holder in another PID namespace without a container ID, such as the host CLI
  as the agent or the helper sees it;
- any holder on macOS, which records no process start time, so a reused process
  ID counts as alive.

Check that the named process is gone first. The command accepts the short name,
the file name a busy message prints, and that name with `.reclaim` for a guard a
dead reclaimer left beside the lock; it removes both. An update receipt's lock is
named by its full path, because the receipt lives wherever the operator put it.

### Release pins and rollback

A generation renders the image of every release service (`app-api`, `app-web`,
`data-manager`, `ops-agent`, `transitous-runner`) and data-manager's Transitous
tools image from one release manifest, and keeps that canonical manifest as
`release-manifest.json`; its SHA-256 is the release's identity. A render that names
no release keeps the applied generation's pins. A release update's maintenance
commits the generation with the release it froze, then the helper verifies the
images and recreates the services. Clearing the selected pin renders the applied
configuration again without pins. The agent caches the manifests it checked under
`state/ops-agent/releases/<digest>.json`; the newest is the release an update can
apply. A manifest's `producer` and `buildMetadata` are display metadata.

`openmapx control rollback` targets the newest retained generation, by the age of
its rendered files, whose pinned release digest differs from the applied one: the
configuration that was applied with the previous release. It renders that
generation's configuration and release again as a new generation and recreates the
services in the self-update order, so a rollback always changes the release and a
second one goes forward again. It refuses when no such generation is retained, and
when the database's newest applied migration (`created_at` in
`drizzle.__drizzle_migrations`) is newer than the target release's
`databaseMigrationHead`, which CI writes into the release manifest from the API's
migration journal; the migrator alone would run an older image against a newer
schema. Rolling back also reverts the configuration made since: the release
selection, the selected services, service configuration and secrets. Every
rollback, also one that fails after its commit, is appended to the control audit
file.

### Operator exit

`openmapx control status` prints the held leases, the agent operations without a
final outcome and the lock holders. `control clear --op <key>` drops a lease whose
holder is gone, and `control resolve --op <key> --as committed|failed` records the
outcome of an operation whose outcome is unknown and releases it. Both are
host-only, print what Docker reports for the held targets first, and are appended
to `state/ops-agent/control-audit.jsonl` and printed. Clearing a configuration
maintenance leaves the data-manager's configuration fence prepared; `control
resolve` of the same operation settles it through the CLI's data-manager token,
also after a clear. `control resolve` refuses a lease data-manager owns:
data-manager settles its own jobs at startup and in recovery, and `control clear`
is the explicit release. `control status` leaves out agent operations the audit
file records as resolved or cleared; they stay in the agent's journal until it is
pruned. `control clear --lock <name>` is described under [Locks](#locks).

### Authority keys and the control prune

New root authority uses `opk1_t1_<14 lower-case hex expiry>_<22 canonical
base64url nonce>` keys. The nonce contains 16 random bytes; the expiry is an exact
millisecond deadline, explicitly supplied before first submission and no more
than seven days ahead. The browser-safe `@openmapx/core/ops/control-root-key`
entry point formats and parses these keys without Node imports. The runtime may
clamp its execution budget independently. A root key whose expiry has passed is
refused at admission, whether or not its records still exist. Retrying an opaque
intent with a newly minted timed key is not recovery.

A version 2 signed admission, witness, lease certificate or grant binds the
original `{version, rootKey, issuer, notAfter}` origin. Descendants, including a
child's independent lease, inherit this origin through verified parent authority.
Raw caller JSON cannot supply it, and a record without an origin is refused.

Each role prunes its own records at startup and then hourly
(`startControlPrune`). An execution's records go when all of these hold:

- its own-effect outcome is known;
- for an agent execution, its canonical terminal commitment is sealed;
- its root key expired at least 72 hours ago, and its effect settled at least
  72 hours ago;
- every lease it owns or borrowed has released its root. The prune then removes an
  owned lease's ledger and frees its retained history slot;
- for a maintenance step, the maintenance owner record is gone. That record goes
  only with its own preparation, so a step of a held maintenance is never pruned.

Only records whose names derive from the execution's own identifiers are
removed: its operation key, the keys of children it planned that have no
admission of their own, its fixed children, the attempts and leases it issued,
its own borrower adoption, its handoff and, for a preparation, its owner record
and source witness. A record of another execution that merely names it stays.
Source witnesses no owner record references go 72 hours after they were
observed. The admission goes before its terminal commitment and effect, and a
pass that stopped in between leaves strays that a later pass removes. A
directory too large for one pass is reported and pruned in part.

A pass examines at most 64 executions and resumes where the previous pass
stopped. Records of an unknown or recovery-required execution stay regardless of
age. The agent also keeps the records of any execution its journal still lists,
directly or as the preparation of a maintenance control entry, and of the newest
successful staged data-manager pull, which describes the running coordinator. On
startup the agent drops journal entries past their retention before restoring
any, and does not bring back a maintenance control entry already past it.
Data-manager deletes its settled fence rows and
finished execution rows for pruned executions before their files. Readers never
treat a pruned record as permission: a missing admission, effect or lease is
unknown, and an expired key is refused. There is no separate retention clock. A
wall clock set back past a pruned key's expiry would admit that key again, so keep
host clocks synchronised.

The physical installation has 256 active lease slots and 1,024 retained
lease-history slots; a released lease holds its history slot until the prune.
Private records are at most 128 KiB. A role refuses new control work with a busy
error, before any effect, while its private state filesystem has less than 64 MiB
free.

The agent journal holds at most 512 entries for new work. Entries that need
recovery have their own bound of the same size, so they cannot use up the capacity
for new work. A terminal control entry stays in the journal until 72 hours after
it finished and until its root key expired; other entries stay for the configured
job retention.

Before an agent publishes a terminal journal row, its fixed live producer signs
the complete canonical terminal tuple digest and original terminal time in a
preallocated private `observations` record signed with the role key. Own-effect
settlement and
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
or postpone the prune. An execution without the terminal authentication record
remains recovery-required; startup does not trust its public journal.

### API parent checkpoints and terminal copies

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
the API checkpoints a bounded copy of it in the job row. The terminal digest
covers exact typed version 2 terminal identity and result/failure fields,
excluding changing progress and diagnostic fields. Only that checkpoint allows
return or throw of the terminal outcome; a failed checkpoint leaves the job to be
observed again. The agent does not wait for the API's copy: once the agent prunes
the operation, 72 hours after its root key expired, an API that never copied the
terminal can no longer read it. Terminal version 3 parents are retained for at
least 72 hours.

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
initial adoption attempt sequence, within its original deadline, for lease
journal writer contention. Adoption retries cover only journal-entry and
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
create only tables, indexes, sequences and its schemas: no view or code. A
restore recreates each role's objects and loads its tables in a session of that
role, and refuses any other object of a role that cannot log in, before it drops
anything; the tile roles may create no objects. So no role's code runs as the
superuser at restore, and data-manager's code never runs as the API. The API is
trusted more, and keeps lateral moves through PostGIS in `public`, which it
owns; [Database roles](../install/configuration.md#database-roles) states them
and how an operator's own superuser session must avoid them. OpenConditions
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

### Other target rules

- **Desired configuration.** The payload travels in the authenticated operation.
  The job row moves through three phases: candidate prepared; rows and decision
  saved in one transaction; generation applied by a keyed operation. Recovery runs
  the same forward code.
- **Self-update order.** Pull first, drain, run the helper from the current image,
  recreate in order with verification after each service, agent last.
