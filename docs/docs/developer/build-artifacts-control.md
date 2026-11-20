---
title: Build bundles and target authority
description: "What the update control plane guarantees, the terms it uses, its records and the state machines it moves through."
---

# Build bundles and target authority

`@openmapx/core/build-artifacts` is a server-only surface. It is intentionally absent
from the browser barrel. CLI bundle commands use the same bounded validator and
writer; uploaded archives never invoke shell extraction.

This page describes what the update control plane guarantees, the words it uses,
the records each process keeps and the states they move through. The operator's
view of the same machinery is in [Services administration](../administration/services-administration.md#control-record-prune-and-interrupted-shutdown)
and [Upgrading](../install/upgrading.md).

## Rules that never change

- Unknown never releases: an operation whose outcome is not known holds its
  targets, and the data-manager fence, until an operator resolves it.
- Attempted is recorded before any effect.
- Startup never dispatches an attempted operation again.
- The same operation key with a different body is a conflict.
- A lease is released only when every attempted child is terminal.

## Guarantee matrix

The matrix assumes one Docker host and one maintainer. Host and Docker
administrators are trusted. The threat is a compromised application service (API,
data-manager or a community service) or a crash of any process at any point.

"Form" says how the guarantee is provided now. The last column names the
crash-point scenarios that show the guarantee holds, each with its status in the
suite's catalogue (`apps/api/src/services/__tests__/crash-points/README.md`).
"Pinned" scenarios pass. "Not pinned" names a scenario the suite cannot express
yet; the guarantee has no crash-point evidence until it is. No scenario is listed
as a known failure.

| Mechanism group                                                                                                                            | Failure prevented                                                                                                           | How credible                                                                                                                                                                                                                                                                                                                                                    | Form                                                                                                                                                                    | Crash-point scenario (status)                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed agent operations, per-role agent tokens, an API data-manager token held to the API's routes, resource policy, owned-service resolver | A compromised API or data-manager runs arbitrary Docker commands or widens the targets it may touch                         | The real boundary against a compromised service                                                                                                                                                                                                                                                                                                                 | Kept as it was                                                                                                                                                          | Same key with a different body is a conflict (pinned); the API's data-manager token is refused on the agent's routes (pinned)                                                                                                                                                                                                         |
| Separate Postgres roles for the API and data-manager                                                                                       | A compromised data-manager forges API rows: accounts, administrative jobs or desired configuration                          | Real against data-manager: PostgreSQL privileges, a command allowlist and restores that recreate each role's objects as that role. A compromised API can still make data-manager, OpenConditions' roles or the tile owner run its functions through `public`, never the superuser; an operator's superuser session can run a role's code (see Known weaknesses) | Kept as it was                                                                                                                                                          | Restore of the pre-update backup (not pinned). The PostGIS entrypoint test (`scripts/postgis-entrypoint.test.ts`), the database role test (`apps/api/src/db/__tests__/database-roles-postgres.test.ts`) and the owners-and-grants restore test (`packages/cli/__tests__/backup-restore-postgres.integration.test.ts`) cover the roles |
| Agent job journal and idempotent operation keys                                                                                            | A retry after a lost reply applies an operation twice                                                                       | Observed need: an earlier missing journal caused an eight-hour outage                                                                                                                                                                                                                                                                                           | One journal row per operation; the row is the operation's only terminal record                                                                                          | Lost reply on configuration prepare (pinned); lost reply on data fence prepare and settle (pinned)                                                                                                                                                                                                                                    |
| Drain before self-replacement, ordered recreate, agent last                                                                                | A self-update leaves services half-replaced, or the agent replaces itself while work is in flight                           | Observed need                                                                                                                                                                                                                                                                                                                                                   | The configuration helper, launched with a label and a handoff ID, writes one progress record the restarted agent reads after it exits                                   | Helper killed mid-recreate (pinned); agent restarted while the helper runs (pinned); CLI command while the helper runs (pinned)                                                                                                                                                                                                       |
| Configuration generations, one atomic pointer, retention against live containers                                                           | A crash leaves a half-written configuration, or pruning removes files a running container still uses                        | Observed need                                                                                                                                                                                                                                                                                                                                                   | Kept as it was                                                                                                                                                          | API killed between saving desired rows and applying the generation (pinned)                                                                                                                                                                                                                                                           |
| Pre-pull, release manifest digests, post-recreate verification                                                                             | An unavailable registry or an unhealthy image is discovered after the old containers are gone                               | Real failures, about the right size                                                                                                                                                                                                                                                                                                                             | Image pins and the release manifest inside the generation                                                                                                               | Registry outage before maintenance (pinned); new image unhealthy after recreate (pinned)                                                                                                                                                                                                                                              |
| Confined hardlinks, archive validation, descriptor-anchored paths on shared data                                                           | A peer plants a symlink on `/data` and redirects an agent write                                                             | Real: data-manager can write `/data`                                                                                                                                                                                                                                                                                                                            | Hardlink plans run inside data-manager, under its data directory                                                                                                        | Unit tests and `local-executions-postgres.test.ts` (a plan with real work through the host CLI)                                                                                                                                                                                                                                       |
| Backup workflow and administrative job runner with one job owner                                                                           | Two API processes run the same job, or a double-submitted update creates two jobs                                           | Real, about the right size                                                                                                                                                                                                                                                                                                                                      | The job row's `protocol` column holds the claim, cancellation and the agent operations a job attempted                                                                  | Concurrent admissions (pinned); API killed during the image download (pinned)                                                                                                                                                                                                                                                         |
| "Unknown never releases", effect start on the execution row, cancellation fence                                                            | A crash after an effect began is mistaken for "nothing happened" and the targets are released or the effect is repeated     | The most valuable rule in the layer                                                                                                                                                                                                                                                                                                                             | The effect start recorded on the execution row (for an agent operation, its journal row) before the first host effect; the journal row and the lease row decide release | Agent killed while a Compose effect is in flight (pinned); agent killed after accepting, before the effect (pinned); cancelled during the fence settle (pinned); cancelled mid-recreate (pinned); deadline variants (not pinned)                                                                                                      |
| Target leases and the child inventory                                                                                                      | Two writers (agent, host CLI, data job, helper) change one service at once, or a surviving delegated writer loses its claim | Real guarantee; a kernel lock cannot cover a surviving helper                                                                                                                                                                                                                                                                                                   | Rows in one agent-private store, `leases.json`, written under a recoverable lock; a child is named by `{leaseId, childKey}`                                             | Concurrent admissions (pinned); a surviving data-manager child after an agent restart (not pinned)                                                                                                                                                                                                                                    |
| Data-job fence                                                                                                                             | Configuration maintenance runs while a data job writes the same data                                                        | Postgres is the right tool                                                                                                                                                                                                                                                                                                                                      | One SQL row under the data-admission advisory lock; settle is idempotent on that row                                                                                    | Data-manager restarted while the fence is held (pinned); an update requested while a data job runs (pinned); lost reply on data fence settle (pinned); data-manager killed during a data job while the agent is down (not pinned)                                                                                                     |
| Maintenance state machine and candidate lifecycle                                                                                          | A crash between saving and applying configuration leaves rows and files disagreeing                                         | Real guarantee                                                                                                                                                                                                                                                                                                                                                  | One maintenance record with one transition table in the agent; three candidate phases in the API's job row                                                              | API killed between saving desired rows and applying the generation (pinned); lost prepare reply, then API killed (pinned)                                                                                                                                                                                                             |
| Configuration payload in the operation                                                                                                     | The agent applies a configuration the API did not approve                                                                   | Real                                                                                                                                                                                                                                                                                                                                                            | The payload travels in the authenticated request; the journal keeps its digest, never the payload; candidates stay in the agent's state                                 | API killed between saving desired rows and applying the generation (pinned)                                                                                                                                                                                                                                                           |
| Configuration writer, lease, backup-store and update receipt locks                                                                         | Two writers render or publish at once                                                                                       | Real; a crash inside the lock needs no manual cleanup when the holder is provably gone                                                                                                                                                                                                                                                                          | A lock file reclaimed when its holder is provably gone                                                                                                                  | Concurrent admissions (pinned); CLI command while the helper runs (pinned)                                                                                                                                                                                                                                                            |
| One data-manager admission                                                                                                                 | A crashed data job blocks all data work, or live traffic stalls during a long transit sync                                  | The second admission model caused the first failure                                                                                                                                                                                                                                                                                                             | Every data job is a durable execution; short traffic runs hold no lease and run beside the one exclusive job                                                            | Update requested while a data job runs (pinned); data-manager killed during a data job while the agent is down (not pinned)                                                                                                                                                                                                           |
| Plain records in each owner's private state, one time-based prune                                                                          | A role forges another role's records, or records grow without bound                                                         | Records are trusted because only their owner writes their directory                                                                                                                                                                                                                                                                                             | No signatures; schema validation of everything read; one prune 72 hours after the root key expires; a free-space check at admission                                     | Agent state filesystem full right after an effect (pinned); the authority gate keeps the agent's state mounted nowhere else                                                                                                                                                                                                           |

## Glossary

- **Target.** A service ID, such as `motis` or `app-api`, whose containers a writer
  may change. Writers claim targets before any Docker effect.
- **Lease.** A durable claim on a set of targets by one execution. While it is
  held, no other writer may begin an effect on those targets. Leases are rows in
  the agent's store, `infra/docker/state/ops-agent/leases.json`; see
  [Lease store](#lease-store).
- **Child.** A delegated unit of work recorded under a lease before it starts: a
  fixed CLI child, a data-manager job, a maintenance step or the configuration
  helper. A lease cannot be released until every attempted child is settled.
- **Adoption.** The step in which a child reads the row recorded for it in the
  lease store and takes it over. A child may begin effects only after adoption.
- **Settlement.** Recording the final outcome of a child or effect from structured
  evidence, so that its lease or fence can be released. Errors alone, expired
  deadlines and dead processes do not settle anything.
- **Fence.** The data-job fence: a `data_manager.configuration_fence` row that
  blocks data-job admission while its state is `prepared`.
- **Maintenance.** A configuration change that recreates services: one record in
  the agent's state, from its preparation to the release of its lease.
- **Generation.** An immutable rendered configuration directory under
  `infra/docker/state/ops-agent/configuration/generations/`, named `cfg1_…`. It
  holds the compose file with the release's image pins, the release manifest
  those pins come from and the hardlink plan.
- **Pointer.** The symbolic link `infra/docker/state/ops-agent/configuration/current`
  that names the live generation. Switching generations is one atomic rename of the
  pointer.
- **Journal.** The agent's job journal, `infra/docker/state/ops-agent/jobs-v1.json`,
  written by atomic rename. It holds every operation the agent admitted and its
  state, and is the only terminal record of an agent operation. The row of an
  operation the agent runs also holds its execution row.
- **Execution row.** One durable record per execution: its admission (operation,
  identity, origin, targets, reserved children), fixed when it is recorded, and its
  progress (held, cancel pending or settled; when the effect started; the
  settlement and its receipt; each reserved child's evidence, binding and grant).
  A child's evidence is what it acts on (a transit candidate's files, the fence a
  maintenance prepares), recorded before the child is bound; its grant in the lease
  store carries it to the recipient. The agent
  keeps the rows of its operations on their journal rows and data-manager keeps
  each execution's row on its `data_manager.jobs` row; every other execution (a
  maintenance step, a fixed CLI child, a host CLI root) has a row file in its
  role's `control` directory.
- **Operation key.** The caller-chosen idempotency key of an agent operation,
  `opk1_…`. New root operations use timed keys, `opk1_t1_<expiry>_<nonce>`. The same
  key with the same body returns the original operation; with a different body it
  is a conflict.
- **Origin.** The `{rootKey, issuer, notAfter}` identity of the root operation that
  started a tree of executions. Descendants inherit it.
- **Prune.** The periodic removal of a role's records for a settled execution once
  its root key expired, 72 hours passed and the leases it held or ran under are
  released; see [Operation keys and the control prune](#operation-keys-and-the-control-prune).
- **Role** and **principal.** A role is one of the processes that hold authority:
  API, data-manager, ops-agent, host CLI and the helper. A principal is the role a
  caller has authenticated as at a receiver, for example the role behind a
  data-manager bearer token.
- **Attempted.** An operation or child that was recorded as about to begin. From
  this point a crash cannot prove that nothing happened.
- **Effect started.** The time recorded on the execution row, and durable, immediately
  before the first host effect, such as a Docker call.
- **Unknown.** The outcome of an attempted operation that has no structured terminal
  evidence. Unknown never releases a target or a fence.
- **`recovery_required`.** The state of an operation whose outcome is unknown after
  a restart or lost evidence. It is never re-dispatched automatically; it holds its
  targets until an operator or a forward recovery path resolves it.

## Who keeps which record

Each role keeps its control records as plain JSON in its own state directory: the
agent (with the fixed CLI children and the configuration helper it runs) in
`infra/docker/state/ops-agent/control`, data-manager in
`infra/docker/state/data-manager/control` (mounted at `/var/lib/openmapx/control`,
and by no other service), and the host CLI in `infra/docker/state/host-cli/control`.
None of them is on the shared data mount, and records are never signed: a record is
trusted because only its owner writes that directory, which
`pnpm check-ops-authority` enforces for the agent's state by keeping it mounted
nowhere else. Everything read from disk or the network is
schema-checked. Docker and host administrators remain trusted.

| Record                                                                                                                                                                                                             | Place                                                                                                                                                                                                                                                                                             | Writer                                                                            | Readers                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Administrative job row: `payload`, public `result`, and `protocol` (claim, cancellation, attempted agent operations, candidate phase)                                                                              | PostgreSQL, `admin_job`                                                                                                                                                                                                                                                                           | API                                                                               | API                                                                  |
| Agent journal row per operation                                                                                                                                                                                    | `state/ops-agent/jobs-v1.json`                                                                                                                                                                                                                                                                    | agent                                                                             | agent; callers through the operation routes                          |
| Execution row: admission (operation, identity, origin, targets, reserved children) and progress (held, cancel pending or settled; effect started; settlement and receipt; each reserved child's binding and grant) | an agent operation: its journal row; a data-manager execution: its `data_manager.jobs` row (`execution_admission`, `execution_progress`); a maintenance step or fixed CLI child: `state/ops-agent/control/executions/<key>.json`; a host CLI root: `state/host-cli/control/executions/<key>.json` | that role (a fixed CLI child its own file)                                        | that role; a fixed CLI child reads its parent's row from the journal |
| Configuration candidate (payload, snapshot, apply operation, private intents)                                                                                                                                      | agent state, behind `configuration.candidate.retain`, `read` and `discard`                                                                                                                                                                                                                        | API through the agent                                                             | API on recovery; agent when the apply step runs                      |
| Maintenance file: record, plan (with the Data Manager image it commits), the containers it replaces                                                                                                                | `state/ops-agent/control/…/maintenance/<maintenanceId>.json`                                                                                                                                                                                                                                      | agent; the host CLI only for `control resolve` of a record in recovery_required   | agent; API through `configurationMaintenance.*` results              |
| Helper progress                                                                                                                                                                                                    | `maintenance/<maintenanceId>.handoff.json` beside the maintenance file                                                                                                                                                                                                                            | helper                                                                            | agent, after the helper container exited                             |
| Lease rows and their children                                                                                                                                                                                      | `state/ops-agent/leases.json`                                                                                                                                                                                                                                                                     | agent, host CLI, fixed children and helper under the lock; data-manager over HTTP | holders by lease ID; children by `{leaseId, childKey}`               |
| Data-manager fence, and its record of the agent's fence child (prepared, settled or refused)                                                                                                                       | `data_manager.configuration_fence`                                                                                                                                                                                                                                                                | data-manager on the agent's request                                               | data-manager, agent                                                  |
| Data job row (status, publication, agent operations of in-process work, worker completion) with the job's execution row, whose cells are the job's only record of its children                                     | `data_manager.jobs`                                                                                                                                                                                                                                                                               | data-manager                                                                      | data-manager; agent and host CLI through `lookupDataExecution`       |

The API's keyed digests (the source fingerprint of a candidate and the intent
digest of an immediate configuration request) use a key derived from the API's own
`BETTER_AUTH_SECRET`; no other role checks them.

## Requests between roles

Data-manager authenticates each HTTP caller by its own bearer token: `api`,
`ops-agent` (including the fixed CLI children the agent runs) or `host-cli`. The
route contract lists the callers each route admits; the configuration fence is
`ops-agent` only, and the API's token is refused on every route outside its
allowlist. The API names the job a child operation belongs to in the
`x-openmapx-parent-execution` header of its own authenticated request; the agent
accepts that header only from the API's token.

A child names its row in the lease store as `{leaseId, childKey}`. The agent's
fixed CLI children receive it in `OPENMAPX_CONTROL_CHILD`, data-manager's
delegated operations send it as the operation request's `leaseChild`, and the
configuration helper in its environment; each reads its row from the store and
adopts it there. Data-manager cannot read the store, so the agent or the host CLI
sends the row's fields (lease, child key, owner, parent, child execution, kind,
phase, targets) as the `delegation` field of a start or fence request, and
data-manager trusts the caller its token authenticated. A child of a parent that
holds no lease (a Full Update's data phases) has no lease ID and follows its
parent's deadline and lifecycle. The issuer's reserved phase records the child
before the store row, and the row is the only adoption record.

The data-manager-to-agent receiver derives the required targets from the parsed
operation: primary stop/restart/promotion require `motis`, staging stop/restart
require `motis-staging`, and proxy validation/reload requires `motis-feed-proxy`.
Restart does not start dependencies and promotion uses `--no-deps`. The child's
lease row must contain those targets, independently of its body fingerprint and
resource policy.

## Agent operations

### Agent job states

`OpsJobState` in `@openmapx/core/ops/contract`, journaled by `apps/ops-agent`.
Terminal states carry `errorClass` when they are not `succeeded`.

| From                                       | Event                                                       | To                                                              |
| ------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------- |
| (none)                                     | Operation admitted and journaled                            | `queued`                                                        |
| (none)                                     | Admission planning refuses it before any lease              | `failed` with the refusal's `errorClass`; nothing ran           |
| `queued`                                   | Worker starts                                               | `running`                                                       |
| `running`                                  | Typed result                                                | `succeeded`                                                     |
| `running`                                  | Classified failure                                          | `failed` with its `errorClass`                                  |
| `queued`, `running`                        | Cancellation request or deadline while the worker is active | `termination_pending`                                           |
| `termination_pending`                      | Deadline passed and the worker stopped                      | `timed_out` (`errorClass: timeout`)                             |
| `termination_pending`                      | Cancellation completed                                      | `failed` (`errorClass: runtime`)                                |
| `termination_pending`                      | A fixed leaf handler had already committed its host call    | `succeeded`                                                     |
| `queued`, `running`, `termination_pending` | Agent restart finds the entry unfinished                    | `failed` (`errorClass: recovery_required`); never re-dispatched |
| Any non-terminal                           | Recovery forced while the worker is active                  | `termination_pending`, then `failed` (`recovery_required`)      |

A row the restart failed is marked `interrupted`; a row that failed by itself is
not. Only an interrupted `configurationMaintenance.settle` row is completed later
from its maintenance record, once that record is settled.

The journal holds at most 512 entries: half for new work and half for entries that
need recovery, so recovery cannot use up the capacity for new work; a finished
entry whose execution never settled counts as one that needs recovery. An entry
with an execution row goes when the control prune removes that row (see
[Operation keys and the control prune](#operation-keys-and-the-control-prune));
the agent offers the prune only finished rows that need no recovery. A terminal
entry without one stays until 72 hours after it finished and its root key
expired; other entries stay for the configured job retention.

### Admission

Every agent operation passes one admission path. It parses and authenticates the
request, checks the same key against the journal (same body: the original
operation; another body: conflict), refuses an expired root key, takes the
operation's lease when the kind needs one, and writes the journal row and then
the execution row on it before the worker starts. Every later change to the
execution row (the effect start, a child's binding and grant, cancellation, the
settlement) is applied to the row in memory, so each later journal write carries
it, and the change resolves only once a journal write with it is durable: the
effect start is on disk before the first host effect. Journal writes run one at a
time through one queue, whether or not the writer holds the admission lock. Each
builds its rows from memory when its turn comes, with its own change in place, and
applies a change it alone carries (a new row, a terminal state, a removal) to
memory once it is durable, before the next write builds. So a write never undoes
an earlier one: an execution-row change made while a terminal write or a new
admission is still in flight lands with that terminal or row, not over it. A held target refuses the
operation before anything is recorded, with HTTP 409 and the error class `busy`;
the message names the holder's executor, operation key, kind and state and points
to `openmapx control status`.

Before the lease, a root's admission plans: it reads its targets and, for a
`configurationMaintenance.prepare`, the API's candidate, the host sources and the
rendered configuration. Planning only reads, so a refusal there records the job as
`failed` with the refusal's class instead of `recovery_required`: sources that
changed since the candidate read them (another update committed meanwhile) are a
`conflict`, anything else `runtime`. The API settles such a preparation as not
committed without waiting for an operator.

The agent's code follows these parts: `admission.ts` (the request guards and this
one pipeline), `job-table.ts` (the journal rows, their events, the handles a root
runs under, the admission lock and the one transition that records a state),
`settlement.ts` (a per-kind table of what a kind adds to running and settling a
root, and the terminal settlement of receipts and leases), `job-run.ts` (the
worker's context and lifecycle) and `server.ts` (startup recovery and thin routes).
A terminal transition runs slow containment (a failed artifact validation) and
published reads (a committed catalog approval) before it takes the admission lock,
so they never hold up another admission.

The five configuration apply kinds carry their payload in the operation body.
The journal row keeps a digest of the body and its non-secret fields, never the
payload, so an attempted apply cannot be dispatched again from the journal.

### Lease store

Every lease lives in one file in the agent's state, `infra/docker/state/ops-agent/leases.json`,
replaced atomically under the recoverable lock `leases.lock` (see [Locks](#locks)). No
other service mounts that directory. The writers are:

- the agent, for its own operations;
- data-manager, through the typed agent operations `lease.acquire`, `lease.read` and
  `lease.update` over its own agent token;
- the host CLI, the agent's fixed CLI children, the configuration helper and the
  catalog bootstrap, which write the file themselves under the same lock.

A lease row names its owner execution, the targets (any registered service ID,
community services included) and the children recorded under it before they start.
A root lease's ID is derived from its owner's operation key, so the owner finds it
without a record of its own. A row is deleted when the owner and every attempted
child have a known outcome: "released" means the owner's own effect is settled and
its lease row is absent. An unknown outcome keeps the row until an operator
resolves it. The store holds at most 256 leases and each lease at most 64 children.

| From   | Event                                                | To                                                       |
| ------ | ---------------------------------------------------- | -------------------------------------------------------- |
| (none) | Owner acquires free targets                          | `held`                                                   |
| `held` | Owner and every attempted child have a known outcome | `settled`, then the row is deleted                       |
| `held` | Owner or a child has an unknown outcome              | stays `held` until `openmapx control resolve` or `clear` |

Every Docker effect that changes containers takes its lease through the admission
path: stop, restart, start, recreate, update, remove, `stack.stop`, repository
removal, backup create and restore. Pull, build, exec and probes take none. On the
host, `services stop|restart`, `compose down` and `backup create|restore` take the
same leases; `compose up` and `services start` take none, so a running data job
does not refuse them. In the agent, only a Docker command that ran to its own end
and reported a failure with an exit code, while the daemon still answered, records
a contained, known outcome and releases the lease; any other error, including
every other failure of an agent backup, leaves the outcome unknown and the lease
held. On the host, an exit code from 1 to 127, or an error that is not a signal or
timeout while the daemon still answers, releases the lease; a crash, timeout,
killed process or lost daemon connection leaves the outcome unknown and the lease
held.

Host ordering is target lease, nonblocking transit reservation, then
configuration writer. No writer is held while awaiting a child that needs that
same writer.

### Locks

The configuration writer (`state/ops-agent/configuration/writer.lock`), the lease
store (`leases.lock`), the backup store (`backups/.backup-store.lock`) and the CLI's
system update receipt each use one lock file. It records the holder's PID, boot ID,
PID namespace, container, process start time and a nonce, and another writer
reclaims it only when that holder is provably gone: the machine booted since, the
holder shares this PID namespace and its process ended, or its container is no
longer running. A holder record that cannot be read, because its holder died
between creating and writing the file, is reclaimed only after it stayed the same
for the wait (one second for a lock that does not wait). Reclaimers take turns
through a short guard file beside the lock. A live holder, or a guard that is still
there when the wait ends, is named in a busy error. The writer and lease locks are
never held across a Docker effect. Agent backups and prunes hold the backup-store
lock for the whole effect, and a second one waits up to a minute; the host CLI's
`backup create|restore` takes a lease on every target instead, so a second one is
refused as busy.

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

## Configuration changes

### API candidate phases

A configuration change is an administrative job whose candidate lives in
`admin_job.protocol.candidate` and moves through three phases. Each phase runs
the same forward code after an API restart.

| From                 | Event                                                                                                                                                             | To                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| (none)               | Payload built and retained at the agent; hardlink preview and coordinator and capacity preflights pass                                                            | `candidate_prepared`                                                          |
| (none)               | A preflight refuses                                                                                                                                               | no candidate; the record is discarded                                         |
| `candidate_prepared` | A change that recreates services: the coordinator image pull and the old revision's coordinator prerequisite, then the agent's `configurationMaintenance.prepare` | `candidate_prepared`, maintenance prepared                                    |
| `candidate_prepared` | The agent refuses the preparation (`busy`, `conflict` or failed) and settles it itself                                                                            | no candidate; the record is discarded, outcome not committed with that reason |
| `candidate_prepared` | The candidate expired before the preparation, or the coordinator pull failed                                                                                      | abandoned, outcome not committed (`conflict`)                                 |
| `candidate_prepared` | The commit participant's verification refuses                                                                                                                     | abandoned with the participant's conflict                                     |
| `candidate_prepared` | One transaction: job row locked and still running, source fingerprint unchanged, maintenance still prepared, rows saved by row-version check                      | `rows_saved`                                                                  |
| `candidate_prepared` | Cancelled, stale or the save rolled back                                                                                                                          | abandoned: `settle{abandon}`, record discarded, outcome not committed         |
| `rows_saved`         | Apply operation (or maintenance apply) terminal with a known outcome                                                                                              | `generation_applied`                                                          |
| `rows_saved`         | Apply outcome unknown                                                                                                                                             | stays `rows_saved`; the job waits for `control resolve`                       |
| `generation_applied` | Follow-ups finished                                                                                                                                               | candidate retired, record discarded                                           |

A recovered job before `rows_saved` continues from the agent's record when it was
queued and abandons when it was an immediate request, a cancelled job or a
participant purpose. From `rows_saved` it runs the apply again under the same
operation key; the agent returns the original operation if it already admitted it,
and the API sends it again under its key when the agent never received it.

### Maintenance record

A change that recreates services runs as a configuration maintenance in the
agent: `configurationMaintenance.prepare` (the root, which holds the lease),
`inspect`, `apply` and `settle {outcome: complete|abandon}`. Its record
(`maintenanceRecordSchema` in `@openmapx/core/ops`) has a closed step list:
`configuration-commit` first, then the hardlink, recreate and handoff steps the
plan needs, the handoff last. One function, `transitionMaintenance`, changes the
record; the agent writes the new record before it runs any effect the transition
returns, and refuses every event the table does not list without a write.

| From                                     | Event                                                   | To                                                               |
| ---------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| (none)                                   | Prepare admitted, lease acquired                        | `preparing`                                                      |
| `preparing`                              | Data-manager prepared the fence                         | `prepared`                                                       |
| `preparing`                              | Fence refused without effect                            | `settled`, lease released                                        |
| `preparing`                              | Fence outcome unknown after retries                     | `recovery_required`                                              |
| `prepared`                               | Apply from the same API job before the deadline         | `applying`; the first runnable step starts                       |
| `prepared`, `applying` (no step started) | `abandon`, cancel or the deadline passed                | `settling` with fence outcome `unused`                           |
| `applying`                               | Step recorded as attempted, then dispatched             | `applying`                                                       |
| `applying`                               | Step committed                                          | `applying`; the next step starts, or the apply succeeds          |
| `applying`                               | Step contained or failed without effect                 | `applying`; the apply fails, no further step                     |
| `applying`                               | Step unknown, or a result the record refuses            | `recovery_required`                                              |
| `applying`                               | Helper launched, then exited                            | `applying` with the handoff step terminal; admissions open again |
| `applying`                               | Cancel after a step started                             | `applying` with the cancel recorded; no further step starts      |
| `applying` (no step attempted)           | `settle{complete}`                                      | `settling` with `applied`, `unused` or `contained`               |
| `settling`                               | Data-manager settled the fence                          | `settled`, lease released                                        |
| `settling`                               | Data-manager refuses the settlement for good (404, 409) | `recovery_required`; not sent again                              |
| `recovery_required`                      | `openmapx control resolve`                              | `settling`, then `settled`                                       |
| `preparing` at startup                   | Fence child was or was not delegated                    | `recovery_required` or `settled`                                 |
| `applying` at startup                    | A non-handoff step is attempted                         | `recovery_required`; a running handoff is watched instead        |

The fence outcome is chosen once, when the record enters `settling`, so a repeated
settle sends the same outcome. A fence settle data-manager does not answer within
10 seconds leaves the record settling, and a failed release leaves a settled record
with its lease; the agent's own check finishes both. That check runs every
5 seconds: it observes a running helper, resends a settling record's fence outcome,
releases a settled record's lease and ends a prepared maintenance at its deadline.
An unreadable record is logged and ends that check only. A new prepare is refused
busy while 64 maintenance records exist.

Each step runs as a child of the prepare root: it is bound and issued under the
maintenance's lease, adopts its row, runs with the payload from the apply request
(the generation step only) and settles from its result. While a handoff is
attempted, other admissions except reads and the same maintenance's apply and
settle are refused busy.

### Configuration helper

The handoff step records its handoff ID in the record before it starts, delegates
a store child for the helper, drains the agent's other operations and starts the
helper with `docker run -d` from the current image, labelled with the handoff ID.
The helper recreates the services in order with verification after each one, the
agent last, and writes its progress (`applying`, `verifying`, `applied`,
`cancelled`, `failed`, with each target `pending`, `recreate_attempted` or
`verified`) to the handoff record. It stops after its current target once the
record's handoff step is terminal or the maintenance is cancelled.

The agent reads that record only after the helper container exited (never while
it launches the helper itself), settles the helper's children, records
`helper_exited` and removes the container. Exit 0 with every target verified is
committed; a cancel or failure with no target `recreate_attempted` is contained;
no container, no progress and no adoption (also a launch the daemon refused) is
failed without effect; anything else is unknown and moves the record to
`recovery_required`.

### Image identities in the generation

Each generation records, in `images.json`, the local image ID that each enabled
service's reference named when the generation was committed. The agent and the
host CLI record the images present at that moment. `compose up` first pulls the
images the host lacks, so a fresh installation's first generation records every
image it starts; a reference that cannot be pulled (a local tag not built yet)
stays unrecorded, and starting it fails anyway. `services update` pulls before it
writes its generation, and a service `services start` enables later is recorded by
the next generation written after its image is present. A pinned release reference names its image by digest; a tag can move
when an image is pulled.

The agent counts a container as its own when it was created from a retained
generation's own compose file and runs either the image that generation recorded
or the image its reference names now. When its generation recorded no image for
the service, the applied generation's record counts instead. A pull that moves a
tag therefore leaves the running containers the agent's own until they are
recreated, and a later generation records the newer image.

### Data Manager updates

The pull comes first. A Data Manager update sends `service.pull` for
`data-manager` as an ordinary keyed step of its job, naming its candidate; the
agent pulls only while the old coordinator runs and no lease holds data-manager.
The maintenance then reads the image ID the pull reported from the agent's own
journal, and finds the containers as they are at preparation; the old coordinator
is still the agent's own because its generation recorded its image. The commit
step records the generation's images and refuses, without committing, when the
coordinator's reference no longer names the pulled image. The recreate step
replaces the old container and is verified against the image the committed
generation recorded. A pull whose update was cancelled leaves an unused image and
blocks nothing. `services update data-manager` on the host is refused; a Data
Manager update goes through the administrative job.

## Data-manager admission

### Data-manager fence states

One row per maintenance in `data_manager.configuration_fence`. The row is
data-manager's only record of the agent's fence child: data-manager keeps no
execution row for it. `prepare` inserts the prepared row in the transaction that
holds the data-admission advisory lock and checks admission; a prepare refused
there inserts a `refused` row instead, so a repeat of the same request is refused
again rather than preparing a fence the agent has already settled as refused.
`settle` is a conditional update (`WHERE state='prepared'`) read back in the same
transaction, so a racing data admission sees the row either prepared or settled.
Only the operations agent calls `prepare` and `settle`, each naming the fence child
the agent recorded under the maintenance's lease (the request's `delegation`
field); settle also requires the agent's own data-manager token and the agent's
maintenance lease still held.

| From       | Event                                                                  | To                                    |
| ---------- | ---------------------------------------------------------------------- | ------------------------------------- |
| (none)     | Agent `prepare`; no unfinished or unknown data job exists              | `prepared`                            |
| (none)     | Agent `prepare` while a data job is unfinished or unknown, or contends | `refused` (409 busy)                  |
| (none)     | Agent `prepare` after its child's deadline                             | no row (409 busy)                     |
| `prepared` | Agent `prepare` with the same body                                     | `prepared` (recorded answer returned) |
| `prepared` | Agent `prepare` for the same maintenance with another body             | `prepared` (409 conflict)             |
| `prepared` | Agent `settle` with the final outcome                                  | `settled` with that outcome           |
| `settled`  | Agent `settle` with the same outcome                                   | `settled` (settled answer returned)   |
| `settled`  | Agent `settle` with another outcome                                    | `settled` (409 conflict)              |
| `refused`  | Agent `prepare` with the same body                                     | `refused` (409 busy again)            |
| `refused`  | Agent `settle`, `openmapx control resolve` or inspection               | `refused` (answered as no fence: 404) |

Data-job admission refuses while a row is `prepared`, and while any data job's
publication is unknown. The agent repeats the same prepare or settle body after a
lost reply until data-manager answers. A refused or never-issued prepare fences
nothing: the agent's prepare fails without effect and its maintenance lease
releases. A preparation removes the rows that were settled or refused more than
72 hours earlier.

### Data jobs

Every data job is a durable execution in `data_manager.jobs`; there is one
admission. The job row is also the execution row: the job's columns already hold
its execution, operation, admission time, deadline and parent, and the job row is
inserted together with `execution_admission` (targets, reserved children,
origin) and `execution_progress`, in one statement; the table refuses an open
job row without them. `execution_progress` holds the progress; each change the
control kernel makes is a compare-and-set on it that leaves the job's own
version alone, and is durable
before the effect, grant or cancellation it precedes. The same key with another
admission is a conflict, and a later process reads the row back from the table,
so a restart observes an attempted job and never dispatches it again.

The execution row is also the job's only record of its children, the agent
operations a transit or catalog job reserves at admission. Each reserved child
has one cell: what it acts on (the transit candidate, recorded before the child
is bound), its binding, its grant, and data-manager's own record of it once it
took the phase up (a proxy restore's backup, a cancellation request, and how it
last observed the agent's operation). The cell reads as bound once the binding
is recorded and as attempted once the grant is, before the one request that
sends the child; data-manager's own changes to a cell are made under the job
row's lock and move the job's version like its status does.

A job ends in three steps on its row. When its work returns or fails, the worker
records how it ended in `execution_completion`, once; recovery reads it back
instead of running the work again, and records the end of in-process work that
died with its process. The settlement on `execution_progress` then records the
terminal status with the finish time the job row will carry; a repeat after a
crash before the job row commits reuses that time. Last, the job row commits the
terminal. Before the job's own lease is released, data-manager checks that the
committed row matches its settlement and that every child is terminal; once the
lease is released (or the job held none, or the lease is already gone from the
store) the row records `released_at`. Startup recovery looks only at unfinished
jobs and at finished ones that kept their execution row and have not recorded
`released_at`, so a crash between the terminal and the release is finished at the
next start, and a job a backup restore closed is left to the prune. A proxy
restore's obligation is the restore child reserved on the row, which names the
backup it restores. The only per-job file data-manager keeps is the Transitous
runner attempt journal in its private state: it holds each runner request's
capability, which stays out of the database and its backups. Exclusive jobs (transit syncs, imports, builds, catalog proposals,
dataset reloads, ambient publication, `generation-link`) take the data-admission
lock exclusively, are refused while another exclusive job is unfinished and lease
`data-manager` at the agent. Live, predicted and maintenance traffic runs are
short: they take no agent lease, share the admission lock that configuration
maintenance takes exclusively, and run beside the exclusive job.

Jobs that data-manager runs in its own process (the traffic kinds, catalog
proposals, dataset reloads, ambient publication and generation links) are admitted
like the others. An agent operation such a job needs is reserved when the job is
admitted, recorded as attempted before its one request, and keeps the job open
until the agent reports a terminal state for it; a reservation the work never used
does not. After a restart, in-process work the previous process left behind is
settled by observation every 10 seconds: once every operation it attempted has a
terminal answer it ends as `interrupted`, and until then it keeps data work
fenced. Data-manager's advisory locks are named in one registry,
`@openmapx/core/data-manager-sdk`'s `DATA_ADVISORY_LOCKS`.

Each job's worker gets its own database handle, a pool whose connections carry
the job's application name, passed to the worker explicitly. Cancelling the job,
or reaching its deadline, makes the handle refuse new queries and cancels every
statement running on it. Worker transactions go through one helper,
`cancellableTransaction`: it never commits once the job was cancelled or its
deadline passed, a transaction that ended before its `COMMIT` was sent restores the
job's earlier publication state, and a `COMMIT` that failed or was cancelled leaves
the publication `unknown`. The handle is closed before the job's terminal is
written, so no statement of a worker outlives its job.

### Hardlink plans

A generation's hardlink plan is applied inside data-manager, under its data
directory, by one route: `POST /link` with the generation's revision, its plan and
an operation key. Every caller uses it: configuration maintenance's hardlink step
and the agent's `configuration.hardlinks.apply` (the API's service preparation and
compose render), artifact imports, data updates, the service lifecycle commands,
`control rollback`, `compose up`, `data link` and `services build`.

- **Under the sender's lease.** A caller whose operation holds a lease names it
  (`leaseId`). Data-manager reads that lease from the agent first (`lease.read`
  shows data-manager another holder's lease on data-manager, read-only) and runs
  the `generation-link` job under it only when the lease is held by the sender
  (the agent or the host CLI, by its token) and covers data-manager; it takes no
  lease of its own, and the caller settles its lease from the answer it got. A
  lease the agent does not show that way is refused with 403, and an agent that
  does not answer with 503; neither admits a job. While a configuration fence is
  prepared, only the agent's request for that maintenance is admitted: its lease
  must be the maintenance's root lease, and its revision and plan digest the ones
  the fence names. Every other request is busy. A repeat under the same operation
  key observes the first application whatever the lease shows now.
- **Without a lease** (`compose up`, `data link` on the host), data-manager leases
  itself and runs the job exclusively, as any other data job.

The operation key is derived from the sending operation and the revision, so a
request repeated after a lost answer observes the first application, and recovery
reads its outcome by the same key (`lookupDataExecution`) without sending it
again. While the application runs past a request's wait, `/link` answers 202 and
the caller asks again; it asks for up to two minutes, never past its own deadline.
Answers mean:

| Answer | Meaning                                                                        | Caller                                                               |
| ------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 200    | Applied; the link counts                                                       | settles its lease as committed                                       |
| 409    | Busy: another holder or a fence refused it; nothing linked                     | fails without effect (`compose up` warns and starts)                 |
| 403    | The named lease is not the sender's live lease on data-manager; nothing linked | fails without effect                                                 |
| 503    | Data-manager or the agent did not answer; nothing linked                       | fails without effect (`compose up` warns and starts)                 |
| 500    | The plan failed part-way; links may have changed                               | fails with a known outcome; the job is final                         |
| none   | No answer within its retries                                                   | outcome unknown: the lease stays held for `openmapx control resolve` |

A failure part-way through linking is recorded as a committed ("may have changed")
publication, so the job ends and holds nothing; applying the same plan again links
nothing twice.

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

A job records each agent operation in `protocol.operations` before it sends it. A
recorded attempt with no operation ID is looked up by its key; an asynchronous
operation the agent still does not know after the lookup window is sent again
under its original key and body. An operation that ends `recovery_required` fails
the job with that error code, except while it belongs to an open configuration
candidate, which waits for the candidate's recovery. A job waiting for an outcome
is checked again with a back-off from 5 to 60 seconds.

## Release pins and rollback

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

## Operator exit

`openmapx control status` prints the held leases, the agent operations without a
final outcome and the lock holders. `control clear --op <key>` drops a lease whose
holder is gone, and `control resolve --op <key> --as committed|failed` records the
outcome of an operation whose outcome is unknown and releases it. Both are
host-only, print what Docker reports for the held targets first, and are appended
to `state/ops-agent/control-audit.jsonl` and printed. Clearing a configuration
maintenance leaves the data-manager's configuration fence prepared; `control
resolve` of the same operation settles it through the CLI's data-manager token,
also after a clear, with the fence outcome the agent's maintenance record already
fixed if it has one, and ends the maintenance when data-manager has no such fence
or settled it otherwise. When data-manager refuses the settlement while its fence
is still prepared (the agent's record and the fence row disagree), the resolution
fails and prints the fence's state instead of ending the maintenance. It is refused while the agent still drives the
maintenance (preparing, prepared or applying): the agent finishes it, or records
that it needs recovery, which it also does for a settlement data-manager refuses
for good. `control resolve` refuses a lease data-manager owns:
data-manager settles its own jobs at startup and in recovery, and `control clear`
is the explicit release. `control status` leaves out agent operations the audit
file records as resolved or cleared; they stay in the agent's journal until it is
pruned. `control clear --lock <name>` is described under [Locks](#locks).

## Operation keys and the control prune

New root operations use `opk1_t1_<14 lower-case hex expiry>_<22 canonical
base64url nonce>` keys. The nonce contains 16 random bytes; the expiry is an exact
millisecond deadline, explicitly supplied before first submission and no more
than seven days ahead. The browser-safe `@openmapx/core/ops/control-root-key`
entry point formats and parses these keys without Node imports. The runtime may
clamp its execution budget independently. A root key whose expiry has passed is
refused at admission, whether or not its records still exist. Retrying an opaque
intent with a newly minted timed key is not recovery. An admission records the
root's `{rootKey, issuer, notAfter}` origin; descendants inherit it from their
parent's admission, and raw caller JSON cannot supply it.

Each role prunes its own records at startup and then hourly
(`startControlPrune`). The prune walks the role's execution rows: the agent's
journal rows for its own operations (only finished ones that need no recovery
are offered), data-manager's job rows that hold one, and the row files
otherwise. An execution's records go when all of these hold:

- it settled; an execution that never settled is kept;
- its root key expired at least 72 hours ago, and it settled at least 72 hours
  ago;
- every lease it owns or borrowed has released its root, so no attempted child is
  unsettled. An unknown outcome keeps its lease (unknown never releases), so its
  records stay until an operator resolves and releases that lease;
- for a maintenance step, the maintenance record is gone. That record goes only
  with its own preparation, so a step of a held maintenance is never pruned.

Only records whose names derive from the execution's own identifiers are
removed: its operation key, the children it reserved that have no admission of
their own, the spawn records of its fixed children and, for a preparation, its
maintenance and helper progress records. A record of another execution that
merely names it stays. The execution row goes last; on the agent, removing it
removes the operation's journal row, and on data-manager its finished job row. A pass that stopped in between leaves strays
that a later pass removes once they are 72 hours old. A backup restore closes the
data jobs it found open and drops their execution rows; data-manager's prune
deletes such a job row once it finished 72 hours ago and was admitted more than
ten days ago, by which time its key has expired. A pass examines at most 256
executions and resumes where the previous pass stopped; a store too large for one
pass is reported and pruned in part. The records of a recovery-required execution
stay regardless of age, and the agent also keeps those of a preparation a
maintenance control in its journal still names.

Readers never treat a pruned record as permission: a missing admission, effect or
lease is unknown, and an expired key is refused. There is no separate retention
clock. A wall clock set back past a pruned key's expiry would admit that key
again, so keep host clocks synchronised. Private records are at most 128 KiB and an
execution row at most 256 KiB. A role refuses new control work with a busy error, before any effect, while its
private state filesystem has less than 64 MiB free.

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

## Known weaknesses

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

**In-process data work a crash interrupted is settled automatically.** When
data-manager restarts, in-process work the old process left behind ends
`interrupted` once its agent operations answered, with its publication recorded as
`committed` ("may have changed") if it had published or an agent operation it
admitted finished. The new process proves the old worker is gone, so this does not
wait for an operator; a partly written local publication reads as changed rather
than held as unknown.
