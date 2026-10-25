# Admin Instance Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete the reliability and operator coverage recommendations from the CLI/admin audit in one verified pull request.

**Architecture:** Extend canonical typed ops-agent and admin API contracts, reuse configuration generations and durable jobs, then expose missing browser workflows. Independent subsystem plans share this specification, scope ledger and integration gate.

**Tech Stack:** TypeScript, pnpm, Fastify, Next.js/React/MUI, Zod, generated SDKs, Drizzle/PostgreSQL, Docker ops-agent, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-admin-instance-management-design.md`
and its binding supplement `docs/superpowers/specs/2026-10-23-admin-control-protocols.md`.

## Global Constraints

All Global Constraints and Product and security decisions in the specification are binding. User authorization includes autonomous decisions and execution through one PR with green CI; no additional approval or planning pause is required. Delegated work uses only Codex6.1-Sol or ClaudeOpus, preferablyCodex; Astra is prohibited by the latest user instruction. Local rendered verification, no screenshots attached to PR.

## Approved Task06.1 retention correction

Task06.1 consumes the [approved retention amendment](../specs/2026-10-25-admin-control-retention-amendment.md) and its [implementation plan](2026-10-25-admin-control-retention-amendment.md). Its fresh root key/origin, bounded renewable family GC, API receipt delivery and atomic stable-step reservation supersede conflicting earlier provisional interfaces;50-task order/scope remains unchanged. Follow-on02.3/02.4/01.2 use its actual exports. Earlier source clearance for02.2 does not qualify the new projectionv3/ack changes: those are reviewed and tested in this06.1 correction window. Agent-first then currentAPI/CLI producer cutover preserves legacy observations while rejecting fresh unsupported authority roots before effects.

## Review Focus

1. Accepted jobs must reach the real production runtime and retain failed/partial/unknown outcomes.
2. Deselecting a running service must retain bounded shutdown/log authority without granting start authority.
3. A saved auth/config/binding value must affect the documented runtime consumer or explicitly remain pending/host-owned.
4. A disconnected observer, changed pin, expired stage or concurrent configuration change cannot publish stale work.
5. Credentials, archive paths and privacy artifacts must retain source ownership, bounded transfer and reauthentication guards.

## Subsystem plans and sequence

Reliability: 01 service control, 02 durable jobs, 03 account policy,
04 integrations and migration (reliability tasks), 05 transit and data (reliability tasks).
Coverage: remaining 04/05, 06 artifact transfer, 07 privacy workflows,
08 platform configuration, 09 maintenance controls.
Final: generated-contract integration, full qualification, whole-branch review, PR and CI.

Subsystem plans are authored and self-reviewed before any product edits. The
controller records cross-plan shared-file/interface ownership before dispatch.

## Task Q0: Review and baseline

- [x] Complete all nine subsystem plans with exact file ownership, interfaces and test-first steps.
- [x] Self-review every scope ID against a task, record decisions and resolve shared-file conflicts.
- [x] Obtain a fresh Codex builder/plan review and resolve every material objection.
- [x] Install both frozen dependency sets and run the focused audit baseline in this worktree.
- [x] Commit reviewed design/plans and record the starting implementation SHA in the execution ledger.

## Task Q1: Integrated contract/runtime proof

- [ ] Generate API/OpenAPI and SDK artifacts once shared definitions settle; inspect serialization and diff.
- [ ] Add real production runtime-composition dispatch probes for advertised actions and policy denials.
- [ ] Add multi-layer auth, configuration, data parent/child, artifact, extension and privacy workflow probes.
- [ ] Run focused tests and affected package types; record exact commands and outcomes.

## Task Q2: Qualification and rendered verification

- [ ] Run `pnpm verify:full` with both frozen dependency sets installed.
- [ ] Run affected production builds and appropriate disposable database suites.
- [ ] Inspect the actual rendered admin workflows using synthetic/public fixtures at desktop/mobile sizes.
- [ ] Review the complete diff with fresh Codex reviewers; fix all material findings and re-review fixes.
- [ ] Reconcile every specification scope ID with implementation and fresh verification receipts.

## Task Q3: One PR and green CI

- [ ] Commit the complete implementation and push the isolated branch.
- [ ] Create one concise PR against main using `--body-file`; omit screenshots per user request.
- [ ] Immediately register the PR with `link_pull_request`; verify the final PR description and linked state.
- [ ] Watch with `watch_pull_request`; fix failed checks on wake and repeat until latest-head CI passes.
- [ ] Stop watching, verify head SHA/check state and report the PR, checks and remaining host boundaries.

## Self-review and execution state

Controller self-review has mapped all scope IDs to subsystem tasks. Product
implementation starts only after the fresh independent plan review is resolved.

## Binding integration rulings

- Execute one implementation task at a time, with a fresh task reviewer before
  the next task. The controller grants that worker an exclusive window for all
  required canonical definitions/registration files; “controller-serialized” does
  not mean leaving an unintegrated module for someone to wire later. Only the
  controller runs aggregate generation/full checks, and no product edits overlap.
- Cross-process target leases follow the exact anchored role-signed protocol in
  the control supplement, including fixed role-key provisioning, private recovery
  directories, finite delegation graph, durable attempts and settlement. Host
  order is target lease → nonblocking transit reservation → host configuration
  writer → release store. API configuration work first acquires its global
  administrative writer and sorted integration locks on one owned connection.
  Full Update holds no target while awaiting a child that needs it. A bare ID,
  caller boolean, observer abort or expired deadline cannot release authority.
- Task01.2 owns strict prospective configuration for all administrative writers.
  Prepare and budget the exact sealed complete candidate before target writes;
  use its closed transaction participant for binding/migration/credential effects,
  then persist proofs, selected rows and job checkpoint atomically. Read-only
  proof APIs are03.3's `check`/`checkMany`; the feed import patch exposes
  `overlayChange`. No competing validator or managed-key generic persistence.
- Configuration/feed maintenance follows control-protocol§5.4: successful whole
  candidate preflight permits one ownership-only remote preparation before saving.
  Agent owns the retained root and durable DM admission fence; the API commits
  rows/proofs and one continue decision atomically, then uses the frozen borrowed
  continuation. It never acquires a local host lease or another apply root.
  Task02.3 owns the early DM guard/index in0042,01.2 the orchestration, and
  04.6/05.6/08.3 consume that same protocol.
- Paired-pin activation retains its DM root through promotion and the explicit
  asynchronous `transitousLock.approve`/`paired-pin-commit` leaf.02.3 supplies its
  closed contract,05.7 the exact pointer-attempt receipt, and05.3 the validated
  runtime. Lost publication is lookup-only; no ref-only or fresh-root fallback.
- Shared portable `ServiceBatchResult` and `HardlinkApplySummary` types live in
  `packages/core/src/ops/service-results.ts`. Task02.1 creates any type required
  by its failure-evidence contract; Task01.3 owns aggregation behavior and
  consumes that type. Do not leave a forward import into a not-yet-created API
  module or define a competing batch shape.
- Public log query is `lines`1–1000/default200, `follow`true and
  `maxDurationSeconds`1–900/default900. Only the Docker adapter calls it `tail`.
- Old inactive auth settings are pending until atomic explicit version1 Apply;
  existing runtime verification/enrollment defaults remain true. Enrollment
  disable never bypasses an enrolled account's second factor.
- Common resource controls cover the exact30 built-ins. Resource values never
  leak into container environment. Domain adoption is a previewed transition of
  known platform slots, while ordinary service/integration host overrides retain
  host ownership. Domain changes disclose passkey/OAuth/DNS recovery prerequisites.
- Artifact ceilings are not per-operation disk reservations. Reserve uploaded
  bytes, then manifest-derived extraction/output bytes and inodes. One archive
  job at a time plus explicit metadata/RSS budgets protect the agent. Plan06's
  current1g default must pass measured worst-case metadata acceptance; reduce
  limits or increase supported budget if measurement disproves that allowance.
- Prepared artifacts and uploaded standalone integrations share Plan06's opaque,
  purpose-bound transport. Credential envelopes ≤1MiB may use API-owned encrypted
  staging. Host-owned credentials remain explicit prerequisites.
- New long operation policies are explicit: artifact validation/export/import72h
  (deployment ceiling7days), catalog validation72h, catalog activation1h,
  advanced Overture acquisition/ingest/extract24h, platform apply1h. Short
  inspect/create/delete calls keep bounded admission/read deadlines. Every layer
  uses the remaining absolute deadline; no phase renews a job budget.
- Updates never recreate after a failed pull, including explicitly local/unpinned
  CLI mode. Document this behavior change; Start remains the action for already
  present images. No false successful “update” through a cached-image fallback.
- Account role migration preserves existing effective administrator authority;
  do not require a host normalization merely because historical Better Auth
  allowed multiple known roles. Normalize recognized role combinations under a
  write lock using the existing authorization predicate; unknown roles fail
  closed with a migration diagnostic. Remote new role writes use the finite set.

## Task execution order and append-only migrations

Run02.1,02.2,06.1,02.3,01.1–01.5,02.4,01.6,
03.1,03.2,03.5,03.3,03.4,03.6,04.1,04.2,05.1,05.7,05.2,
08.1,05.6,05.3–05.5,06.2,04.3,04.4,08.2–08.4,
09.1–09.6,06.3–06.5,04.5,04.6,07.1–07.6,thenQ1–Q3.
The early06.1 shared lease/manifest foundation is required for reliable writers;
its browser transfer workflows land after reliability. No task is deferred.
The nine subsystem plans contain50 implementation tasks. Task05.7 is the
paired-pin authority foundation;05.2 and05.6 consume its identity,
then05.3 adds reviewed validation/activation using the credential revision.
Public activation stays unavailable until the complete evidence chain is wired.

Migration allocation supersedes the provisional shared0042/0043 suggestions in
early planner drafts. Each landed task adds a new forward migration; never edit
an earlier migration after a test database/commit has applied it. The controller
serializes Drizzle snapshots/journal and verifies the fresh migrated schema.

| Task | Migration                              | Contents                                                       |
| ---- | -------------------------------------- | -------------------------------------------------------------- |
| 02.3 | 0042_admin_data_execution.sql          | durable data-manager execution identity/cancel/result metadata |
| 03.1 | 0043_admin_auth_policy.sql             | activated policy singleton and version/revision                |
| 03.2 | 0044_admin_account_invariant.sql       | guard counter/triggers and atomic role receipts                |
| 03.3 | 0045_admin_reauthentication.sql        | purpose-bound administrator challenges                         |
| 03.4 | 0046_admin_account_provisioning.sql    | idempotent provisioning and encrypted mail outbox              |
| 04.1 | 0047_admin_integration_application.sql | administrative revisions and retained apply receipts           |
| 04.3 | 0048_admin_integration_ownership.sql   | installation provenance/standalone ownership                   |
| 04.5 | 0049_admin_configuration_migration.sql | bounded migration preview/apply receipts                       |
| 04.6 | 0050_admin_credential_transfer.sql     | encrypted short-lived import stages                            |

All paths are beneath `apps/api/src/db/migrations/`; paired shared schema lives
in the current owning package, including `@openmapx/db-schema` for data-manager.
If a task proves its persistence fits a previously existing table without losing
the stated guarantees, document that finding and omit an empty migration rather
than adding no-op schema churn. Subsequent names stay reserved and append-only.
