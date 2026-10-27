# Maintenance Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete normal CLI option parity for grouped services, build/update/log controls, release staging, backup retention and scoped cache maintenance.

**Architecture:** Reuse the reliable action policy/preparation/jobs from plans01/02 and applied platform ownership from plan08. Expose bounded typed inputs through the canonical service-admin family; use host guidance for operations that remove their own control plane.

**Tech Stack:** TypeScript, Zod, Fastify, generated SDK, React/MUI, ops-agent, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-admin-instance-management-design.md`.

## Global Constraints

Cover M01-M07. No new generic command runner, arbitrary log argv, unrestricted
Redis pattern, FLUSHDB/FLUSHALL endpoint or destructive stack shutdown operation.
Do not create a competing platform/release/retention store. Coordinate shared
contracts and giant existing UI/runtime modules with the controller.

## Review Focus

1. Presets expand identically in CLI and UI, including missing services and dependency roots, without bypassing per-action capabilities.
2. `noDeps` and MOTIS import reach their runtime consumers; unsupported combinations fail before side effects.
3. A log query change cancels exactly its owned stream and cannot append stale service/origin data or grow a partial line without bound.
4. Backup preview cannot delete a new/replaced/unpreviewed archive, and retention changes cannot resurrect an already expired backup.
5. Cache previews/clears remain within `int:` and `cache:` prefixes, preserve invalidation epochs and use bounded memory under large scans.

## Task M1: Shared presets and complete service action options

**Files:** Create `packages/core/src/services/presets.ts` and tests; turn
`packages/cli/src/lib/presets.ts` into compatible re-exports. Modify
`packages/core/src/services/index.ts`, canonical service-admin `services.ts`,
`data.ts`, `index.ts`, `apps/api/src/routes/admin-services.ts`,
`apps/api/src/services/admin-job-handlers.ts`,
`apps/web/src/components/admin/services/ServiceCatalog.tsx`, and focused tests.
Agent runtime build/update changes consume the finalized plans01/02 interfaces.

**Interfaces:** Export existing `PRESETS`, `expandPresets` and `UnknownPresetError`
from core without changing preset IDs/root order. Add `listAdminServicePresets`
(`GET /api/admin/services/presets`) returning `{ presets: [{ id, rootIds,
effectiveIds, missingIds }] }`. Bulk input accepts optional `presetIds` or
`serviceIds`, requires a nonempty resolved selection, deduplicates server-side,
and rejects unknown presets. Update-only `noDeps?: boolean`; build-only
`motisImport?: boolean`, valid only when the build includes MOTIS. Never persist
an action's temporary preset selection unless the explicit root editor is saved.

- [ ] Add CLI/core tests preserving every preset expansion and UI/API tests proving preset expansion uses server authority, missing IDs are visible, mixed selections deduplicate, and forbidden actions remain forbidden.
- [ ] Add request-to-runtime tests proving `noDeps:true` reaches the isolated update path and `motisImport:true` emits the MOTIS import step only for MOTIS; invalid combinations reject before jobs/commands.
- [ ] Run `pnpm test packages/cli/__tests__/cli-services.test.ts packages/cli/__tests__/cli-compose.test.ts apps/api/src/routes/__tests__/admin-services.test.ts apps/api/src/services/__tests__/admin-job-handlers.test.ts apps/web/src/components/admin/services/ServiceWorkflows.test.tsx --maxWorkers=3` and new preset tests; record causal RED.
- [ ] Implement shared presets, strict action unions and UI controls using plan01 capabilities. Pass exact typed fields; do not hide unsupported flags in an unvalidated payload. Preserve build continuation/fail-fast defaults.
- [ ] Complete catalogue selection/discovery parity in this task: add enabled/all/disabled and exact capability filters, plus a capability inventory distinguishing recognized vocabulary from unrecognized manifest entries. Extend canonical list metadata with bounded `capabilityInventory:{recognized:string[],unrecognized:Array<{capability:string,serviceIds:string[]}>}` using the existing core vocabulary. Add per-service Enable/Disable root actions through the existing selection API, preserving dependency explanations and host-owned selection locks; a dependency cannot be silently removed while another root requires it. Tests cover root/dependency rows, unknown vocabulary, locked selection and failed generation apply.
- [ ] Re-run focused checks GREEN, verify actual runtime argument/preparation ordering, and commit after review.

## Task M2: Bounded log retrieval options

**Files:** Modify `packages/core/src/api/contracts/service-admin/services.ts`,
`apps/api/src/routes/admin-services.ts`, `apps/api/src/utils/docker-compose.ts`,
`apps/web/src/components/admin/services/ServiceLogsDrawer.tsx`; create its
behavior test and extend API/ops log tests. Coordinate policy with plan01.

**Interfaces:** Logs query `{ lines?: number|string; follow?: boolean;
maxDurationSeconds?: number }`; `lines` 1-1000, follow default true, duration
1-900 seconds. Snapshot uses typed `service.logs`; follow uses
`service.logs.follow`. UI offers tail100/200/500/1000, snapshot/follow, pause and
reconnect; reconnect uses a fresh durable stream identity. Retain at most1000
lines and256KiB, including a bounded incomplete line and truncation indicator.

- [ ] Add tests for snapshot versus follow dispatch, strict malformed/unknown query rejection, byte and partial-line limits, core-service read capability, origin/service/query switches, close/cancel races and stale-chunk suppression.
- [ ] Run new drawer behavior tests and `pnpm test apps/api/src/routes/__tests__/admin-services.test.ts apps/ops-agent/src/docker-runtime.test.ts --maxWorkers=3`; verify RED.
- [ ] Implement the controls and typed dispatch, preserving redaction and owner fencing. Distinguish stream timeout/end from process/service failure; do not retry mutations automatically.
- [ ] Run focused tests GREEN, inspect rendered small/large viewports and commit after review.

## Task M3: Pull-only staging and release pin clearing

Consume the [approved conditioned pull contract](../specs/2026-10-27-admin-coordinator-lifecycle-design.md) installed by01.2: fresh service.pull requires exact expectedConfigurationRevisionId, optional candidateId has only its fixed verified purpose, and successful image/source metadata comes from the actual producer. Preserve original normal submission/admission/lookup and legacy observation rules; do not reintroduce service-ID-only fresh pulls, caller image/path/source assertions or cached-image continuation after failure. This task still owns pull-only UI/staging and release pin clearing; no task/migration reallocation.

**Files:** Create focused `apps/api/src/routes/admin-release-controls.ts`,
`apps/api/src/services/admin-release-controls.ts` and tests. Modify service-admin
contracts, core ops contract/policy, `apps/ops-agent/src/administrative-runtime.ts`,
`apps/api/src/routes/index.ts`, `apps/web/src/components/admin/system/SystemMaintenance.tsx`
and relevant service catalog action adapters. Reuse
`packages/cli/src/lib/release.ts:clearReleaseSelection` semantics, factoring a
core helper if needed without introducing API direct filesystem access.

**Interfaces:** `pullAdminServiceImages` (`POST /api/admin/services/images/pull`)
accepts `{ serviceIds }`, queues a typed image-stage job and never starts or
recreates containers. Known release-pinned images use the exact resolved release.
`clearAdminReleaseSelection` (`POST /api/admin/system/release/clear`) accepts
`{ expectedReleaseId, confirmation: "CLEAR RELEASE PIN" }`; typed `release.clear`
removes only the matching selected overlay under its existing release-store lock.
Running containers, evidence and running state remain unchanged. Plan08's selector
remains independently configured; clearing is not switching to local images.

- [ ] Add route-to-agent tests proving pulls do not render/recreate/start, failed pull retains the current release, clear requires admin/confirmation/current release, concurrent overlay replacement conflicts, and local/automatic selector behavior remains explicit.
- [ ] Run new release-control tests, `pnpm test packages/cli/__tests__/cli-release.test.ts apps/api/src/routes/__tests__/admin-system.test.ts apps/ops-agent/src/administrative-runtime.test.ts --maxWorkers=3`; verify RED.
- [ ] Implement strict typed operations and UI preview/confirmation with effective selector and expected pin. Use the plan01 distinction between image staging and destructive lifecycle authority for protected core services.
- [ ] Verify GREEN and actual serialized response, regenerate through controller, then commit after review.

## Task M4: Manual backup prune and effective retention policy

**Files:** Create `apps/api/src/routes/admin-backup-maintenance.ts`,
`apps/api/src/services/admin-backup-maintenance.ts` and focused tests. Modify
service-admin `data.ts`/`index.ts`, core ops contract, agent backup runtime,
`packages/cli/src/commands/backup.ts`,
`apps/web/src/components/admin/services/BackupsPage.tsx` and tests. Retention
ownership/resolution belongs to plan08's C1/C4, not a second settings entry.

**Interfaces:** `previewAdminBackupPrune` (`POST /api/admin/services/backups/prune/preview`)
returns candidates, sizes, cutoff, effective retention/source, inventory digest
and a15-minute expiry. `pruneAdminServiceBackups` (`POST .../prune`) binds that
preview and confirmation `PRUNE EXPIRED BACKUPS` in a durable job. Typed
`backup.prune.preview` and `backup.prune` run under the existing backup-store lock;
the mutation revalidates exactly the previewed candidates and policy revision.
It never deletes newly eligible or replaced archives without a fresh preview.

- [ ] Add tests for preview-only no mutation, expired/changed preview, concurrently created/replaced backup, malformed/corrupt entry, lock contention and correct deleted/retained counts. Test policy changes across create/prune/restore/janitor and no resurrection of prior expiry.
- [ ] Run new backup-maintenance API/runtime tests and `pnpm test packages/cli/__tests__/cli-backup.test.ts apps/web/src/components/admin/services/__tests__/BackupsPage.test.tsx --maxWorkers=3`; verify RED.
- [ ] Factor a shared read-only prune plan from current CLI retention logic; keep existing integrity/path/link checks and backup-store locking. Bind inventory identities, not arbitrary directories.
- [ ] Stamp an immutable latest-allowed expiry for new backups; migrate unstamped local entries under the store lock using the pre-change effective policy. A shorter policy may shorten existing expiry; a longer policy applies to new snapshots and never reauthorizes an expired one. Portable manifests/readers accept the additive expiry with validation.
- [ ] Add the preview/prune and source-aware retention editor using plan08, retain create/restore subset/stop-running behavior, and surface corrupt entries separately.
- [ ] Run GREEN, serialized contract tests and appropriate export-restore database fixtures; commit after review.

## Task M5: Scoped cache pattern preview/dry-run

**Files:** Modify `apps/api/src/routes/admin-cache.ts`,
`apps/api/src/utils/cache-policy.ts`,
`apps/web/src/components/admin/cache/CacheManager.tsx`; create focused cache
contract helpers under `packages/core/src/api/contracts/` and extend API/UI plus
cache invalidation tests. Keep existing namespace and clear-all clients compatible.

**Interfaces:** Strict clear body `{ namespace?: string; pattern?: string;
dryRun?: boolean }`; namespace/pattern are mutually exclusive. Pattern <=256
characters and must begin literally with `int:` or `cache:`; reject NUL/control
characters and unrestricted `*`/other prefixes. Dry-run returns `{ dryRun:true,
estimatedCount, patterns }` and never calls UNLINK or changes invalidation epochs.
Real clear returns existing deleted count and includes resolved patterns. Omitted
target continues to mean the two application globs, never the entire Redis DB.

- [ ] Add tests rejecting `*`, session/job/foreign prefixes, malformed/unknown fields and ambiguous targets. Prove dry-run has no deletion or epoch changes and real targeted deletion retains non-app keys and concurrent invalidation guarantees.
- [ ] Run `pnpm test apps/api/src/routes/__tests__/admin-cache.test.ts apps/web/src/components/admin/cache/CacheManager.test.tsx apps/api/src/services/__tests__/cache-invalidation.test.ts --maxWorkers=3`; verify RED.
- [ ] Count/clear with streaming SCAN and bounded batches; never accumulate an unbounded complete key list. Counts are explicitly estimates under concurrent writes/SCAN duplication; no key values are returned. Add pattern/count preview and deliberate clear confirmation to the UI.
- [ ] Verify GREEN and optional disposable Valkey integration fixture, regenerate API description through controller and commit after review.

## Task M6: Honest host boundaries and administration documentation

**Files:** Modify `apps/web/src/components/admin/services/ComposePreview.tsx`,
its tests, `docs/docs/administration/admin-panel.md`,
`services-administration.md`, `backup-and-restore.md`, `monitoring.md`,
`docs/docs/install/managing-services.md`, `configuration.md`.
Modify canonical service-admin/workflow contracts, `apps/api/src/routes/admin-compose.ts`
and `apps/api/src/services/admin-job-handlers.ts` in the same exclusive window.

**Interfaces:** The Compose Down surface displays an explicit explanation and
copyable `pnpm openmapx compose down` instructions; it does not send a mutation
known to return503. Destructive `--volumes` remains a documented host procedure,
not the default copied command.

- [ ] Add a UI test asserting no stop request is sent, instructions are actionable and Up still works; run to RED.
- [ ] Replace the doomed button with bounded host guidance, show retained remote diagnostics/log access and recovery links, and document all supported new options plus their verification/application limits.
- [ ] Add render-only generation commit through canonical `renderAdminComposeConfiguration`, POST `/api/admin/compose/render`, body `{expectedCurrentRevisionId:string|null,confirmed:true}`. Queue a durable `compose.render` job using current desired configuration, exact revision CAS and plan01's explicit `require-running` coordinator preparation mode, without container lifecycle effects. The mode belongs to the admitted identity/checkpoint, not a UI hint. Nonempty hardlink plans require an already-running authorized data-manager before commit and revalidation at execution; an empty plan needs no coordinator. A stopped/concurrently stopping coordinator is never started. UI distinguishes Preview, Generate configuration, and Up; generated-only result says container restart/apply is still pending. Domain/roots/presets are edited through supported forms before generation. Test the real API→preparation→agent call graph for zero lifecycle effects, running/stopped/racing coordinator, empty/nonempty plan, stale revision and post-commit link failure. Register `compose.render` in02.2 exact durable recovery/result dispatch; retain committed-follow-up-failed/unknown evidence.
- [ ] Run the Compose preview tests GREEN, verify documentation formatting/build and inspect rendered guidance locally. Commit after review.

## Self-review

M01-M03 map to M1/M2, M04 to M3, M05 to M4, M06 to M5, M07 to M6.
Every Review Focus condition has assertions in its owning task. Shared changes
to bulk contracts/handler/catalog and agent runtime are sequential with plan01;
retention/release resolution is sequential with plan08. Generated artifacts are
controller-owned, never concurrent worker output. No task changes host bootstrap
secrets or grants generic self-stop authority.
