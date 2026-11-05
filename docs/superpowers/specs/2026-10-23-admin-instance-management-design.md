# Reliable administration and CLI coverage

Date: 2026-10-23. Baseline: `ef896ceae876959180116cf61ffcf643b88ebffe`.
Branch: `feat/admin-instance-management-parity`. Delivery: one pull request.

## Authority and intent

The operator should manage an already installed OpenMapX instance through the
admin panel, including maintenance, configuration, credentials, datasets,
accounts, extensions, backups and privacy cases. The user authorized every
recommendation from the preceding CLI/admin audit, reliability before coverage,
autonomous design decisions, Codex-only delegation, local rendered verification,
and a single PR with passing CI. The user explicitly waived questions, design
approval pauses and PR screenshots. This specification records the controller's
decisions; it does not attribute those decisions to the user.

The original audit's 510 passing focused tests and five skipped tests are
historical baseline evidence, not qualification of this branch. No product code
has been changed at specification creation.

## Approaches considered and chosen

1. Mirror CLI execution behind a generic command runner. Rejected: command,
   path, secret and resource authority would escape the existing typed boundary;
   accepted jobs would still lack effective-result guarantees.
2. Add isolated screens over current APIs. Rejected as the primary approach:
   several current API/runtime paths are incomplete and would remain misleading.
3. Extend the existing typed operations, canonical contracts, generated SDKs,
   configuration generations and durable jobs. Chosen: share policy and
   preparation, make outcomes observable, then expose missing operator workflows.

## Global constraints

- All product work stays in this worktree; preserve unrelated work and existing
  public-provider behavior. One branch/PR; no merge or production deployment.
- Use Codex provider instances only for delegated work.
- Retain `IntegrationContext`, HTTP/upstream acquisition, attribution and source
  policy boundaries. Community integrations remain declarative; no uploaded code
  execution and no browser developer toolchain.
- Docker, registry credentials, privileged host files and host data writes remain
  behind typed ops-agent operations. No generic command, arbitrary path or raw
  environment-file editor is introduced.
- Core API routes use `registerCoreRoutes`, runtime admin guards beside auth
  declarations, strict schemas, audit events, explicit mutation identities and
  appropriate rate limits. Privacy roles retain their narrower authority.
- Contracts precede generated outputs. Serialize OpenAPI/SDK generation; never
  hand-edit generated files. Check actual response serialization.
- Preserve configuration writer ownership, revision CAS, admission fingerprints,
  durable operation identities, retained results, unknown outcomes and cancellation
  fences. No automatic mutation retries or unproven rollback/compensation.
- Use synthetic/public data in tests and UI verification. Never print secrets,
  place secrets in argv or logs, or copy private operator data into artifacts.
- Stream large transfers with bounded memory, disk budgets, timeouts, cancellation
  and cleanup. Opaque IDs cross trust boundaries; host paths do not.
- UI controls expose availability and reasons before submission. A successful
  admission means queued, not applied. Failed/partial/unknown work stays visible.
- Inspect the actual rendered desktop/mobile UI locally. Do not upload screenshots
  to the PR, as explicitly requested.
- Complete focused checks, full local verification, relevant disposable database
  and runtime checks, independent review, production builds and PR CI. Report any
  unavailable environment gate distinctly; do not replace runtime evidence with
  mocked assertions.

## Product and security decisions

### Operation availability and lifecycle

Return operation-specific capabilities and denial reasons from service inventory
and detail reads, derived from the same action policy the agent enforces. Start,
build and recreate require current configured authority. Narrow stop/read-log
authority remains available for known, owned running containers after deselection.
Never infer ownership from a caller-provided container name alone. Read-only logs
must not be denied merely because a service is part of the control plane.

Ordinary Start and bulk Start share generation preparation and hardlink apply.
Updates validate pins, pull, prepare, then recreate; failed pull never recreates.
Safe API/edge-service maintenance uses durable dedicated workflows where a generic
action would cut its own coordinator. The executing agent cannot stop itself;
agent replacement retains the existing external helper/handoff protocol. Whole
stack shutdown and volume destruction remain explicit host instructions.

Deselection must either complete owned deactivation before retiring action
authority or retain the narrowly bounded stop/log authority until cleanup. A
control-plane acquisition error produces unknown/unavailable status, never a
fabricated empty inventory. Deployment kind does not change during an outage.

### Durable jobs and data execution

Stream redacted output during execution. Limit retained output independently of
process lifetime; retain a truncation marker and bounded diagnostic tail. Deadlines
are operation-specific: diagnostics remain short; prepared builds/full refresh and
large dataset transfer permit multi-hour work with durable identity and explicit
cancellation. An observer disconnect does not imply backend completion or cancel a
durable data-manager job. Parent Full Update records and awaits its transit child
before dependent graph builds and successful completion.

Continuing a batch after an item failure does not make the batch successful. Keep
completed/failed IDs and distinguish failed or partial terminal outcomes in all
SDK/UI consumers. A timed-out or lost result remains unknown until reconciled.

### Account policy and provisioning

Authentication settings are effective policy, not decorative database entries.
Validate password minimum 8-128 characters, session lifetime 1-8760 hours, and
boolean verification/2FA enrollment settings. New requests use a coherent policy
snapshot; policy changes must not extend existing sessions. Disabling new 2FA
enrollment never bypasses an enrolled user's second-factor challenge. Document
the policy application point and test sign-in/reset/admin-create paths.

Upgrade behavior preserves the existing runtime defaults: verification and new
2FA enrollment remain enabled. Previously inert saved authentication values are
shown as pending until a full administrator explicitly applies a validated policy
with an activation marker. That apply atomically validates all four settings and
records policy version1; subsequent auth operations use that activated snapshot.
Explicit supported environment ownership is disclosed, with no silent weakening
from legacy database values. New installations use the same secure defaults.

Unwrap every Better Auth read/mutation result before React Query success. Provide
an explicit invitation/verification handoff and audited administrator-assisted
verification/password recovery with reauthentication and confirmation. A password
reset is not proof of email ownership. Enforce the last non-banned full-admin
invariant atomically for remote role changes, banning and deletion, including
direct auth endpoints. Initial administrator bootstrap remains a local recovery
boundary. Use consistent role mutations and audit events from list/detail.

### Configuration ownership and application

Service/integration fields disclose default/database/vault/file/environment
ownership. File/environment owners cannot receive a misleading successful Save or
Rotate; provide explicit supported adoption into UI ownership or actionable host
instructions. Binding changes activate through reload with an honest apply result.

Expand operator-facing service schemas from actual supported manifest settings,
including resource controls. Define platform/domain/TLS/release-selection forms
over bounded supported fields and coordinated configuration-generation apply.
Preview affected services, preserve last-good configuration, and provide recovery
guidance when origin/TLS changes disconnect the browser. Platform-owned bootstrap
keys and Redis authentication remain explicit host procedures; do not pretend a
live in-app form can safely rotate the authentication dependencies it requires.

Migration has an inventory/preview describing included values, source ownership,
manual prerequisites and unresolved credentials. Non-secret JSON is not presented
as a full instance backup. Vault-owned credentials may travel only through an
explicit reauthenticated encrypted transfer with authenticated encryption and
bounded KDF parameters. Host-owned credentials remain unresolved prerequisites;
they are not silently read or disclosed from host files.

### Transit and datasets

Custom-source disabling is reversible and distinct from removal. Only show valid
actions for an origin/state. Server-side pagination/search covers every source;
discovery dedup preserves installed catalog IDs and provenance. Standalone sync
can select a deployment-authorized country subset and preview eligibility.

Show active/proposed/validated pin state and a source/license diff before explicit
approval. Preserve paired Transitous/GBFS proposal/activation rather than silently
updating one member. Do not claim a proposal changed the active catalog. Do not
add an unsafe force-activation path around validation/promotion.

Expose Overture resume and confirmed restart-from-scratch. Ordinary combined sync
remains the default; lower-level pull/ingest/extract become supported advanced
recovery actions. Inventory uses artifacts/build records, sizes, regions,
fingerprints and readiness, not directory existence. Feed-key management is
masked, write-only and tied to the active pinned catalog; regeneration preserves
existing credentials and never drops values from an unrelated upstream revision.

### Portability and installed integrations

Prepared-artifact transfers preserve existing checksums, compatibility checks,
stopped-consumer preconditions and atomic replacement. UI upload/export/import
uses bounded streaming, opaque staged IDs, digest verification, preflight capacity
and progress. Reuse existing archive validation; reject traversal, links, duplicate
entries, archive bombs, mismatched images and stale confirmations. Publish no
partially validated artifact. Handle interruption and stale stage cleanup.

Standalone integration installs retain the source/artifact checksum and trust
restrictions of the CLI. Prefer artifact distribution and explicit adoption into
extension ownership; never claim a filesystem-only install belongs to an unrelated
store record. Provide guarded adoption/removal and reload/rollback semantics.

### Maintenance and privacy

Add manual backup pruning with preview and policy editing; retain scheduled
retention and restore safeguards. Cache glob/count/dry-run stays confined to
application prefixes; a web endpoint never runs FLUSHDB/FLUSHALL. Add service
presets, isolated update choice, MOTIS import, pull-only staging, release-pin
clearing and bounded tail/follow controls.

Privacy case forms expose existing guarded identity/representative decisions,
assignment and task completion, deadlines, clarification/refusal, attachments,
backup review and reauthenticated assisted artifact delivery. Preserve expected
versions, idempotency, case-specific permissions, redaction, reauthentication and
human approval semantics. No UI shortcut fabricates evidence or bypasses readiness.

## Scope ledger and plan owners

Every row must acquire implementation and verification receipts before completion.
The implementation plans expand these IDs into test-first tasks and exact files.

| IDs     | Required outcome                                                                | Plan                          |
| ------- | ------------------------------------------------------------------------------- | ----------------------------- |
| S01-S03 | wired updates, shared Start preparation, truthful partial build results         | 01 service control            |
| S04-S06 | action capabilities, deselected stop/log access, safe core controls             | 01 service control            |
| S07-S08 | unavailable status and persistent troubleshooting navigation                    | 01 service control            |
| J01-J03 | streaming bounded logs, deadlines, cancellation/reconciliation                  | 02 durable jobs               |
| J04     | Full Update awaits transit child and preserves failure                          | 02 durable jobs               |
| A01-A04 | effective verification/session/2FA/password policy                              | 03 account policy             |
| A05-A08 | auth errors, invitations, verification and assisted recovery                    | 03 account policy             |
| A09-A10 | atomic last-admin invariant and consistent role audit                           | 03 account policy             |
| I01-I02 | binding activation and config/vault ownership                                   | 04 integrations and migration |
| I03-I05 | standalone install/adoption/removal and migration inventory                     | 04 integrations and migration |
| I06     | explicit protected vault credential transfer                                    | 04 integrations and migration |
| D01-D04 | reversible sources, pagination, discovery identity, scoped preflight            | 05 transit and data           |
| D05-D07 | reviewed paired pins, Overture recovery, real full inventory                    | 05 transit and data           |
| D08-D09 | masked feed credentials and pinned non-destructive generation                   | 05 transit and data           |
| T01-T04 | prepared-artifact upload/export/import, validation and cleanup                  | 06 artifact transfer          |
| P01-P06 | complete guarded privacy-case operator workflows and delivery                   | 07 privacy workflows          |
| C01-C04 | supported service/resource/platform/domain/TLS configuration                    | 08 platform configuration     |
| C05-C07 | release selector, ownership and coordinated apply/recovery                      | 08 platform configuration     |
| M01-M03 | presets, no-deps, MOTIS import and log controls                                 | 09 maintenance controls       |
| M04-M06 | pull-only/clear pin, backup prune/policy, cache glob/dry-run                    | 09 maintenance controls       |
| M07     | honest Compose Down host guidance and recovery documentation                    | 09 maintenance controls       |
| Q01-Q05 | contract generation, integrated tests, rendered UI, builds/full gates, green CI | master plan                   |

## Execution and qualification

All plans are reviewed before product implementation. The controller performs a
spec-to-task coverage scan, interface/file conflict scan, self-review and fresh
Codex builder review, resolving objections without user questions. Reliability
tasks land before their coverage consumers. Independent file owners may execute
in parallel; shared ops/contracts, generated SDKs, route indexes and migrations
are serialized by the controller. Each task has causal RED/GREEN evidence and a
fresh spec/quality review; a whole-branch review follows integration.

Use disposable synthetic runtime/database fixtures. Exercise actual assembled
ops-runtime dispatch rather than only injected handler mocks; auth tests exercise
actual policy consumers; data tests observe child completion and activation;
privacy tests exercise guarded transitions and delivery. Run `pnpm verify:full`,
relevant database groups, affected production builds, policy/codegen freshness,
and actual rendered UI. Keep skipped/unavailable checks separate. Open/link the
single PR, monitor through T3's watcher, fix CI failures, and finish only with
the latest-head checks passing. Do not merge.
