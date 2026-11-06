# Release Selection Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent standalone release selection from invalidating the coordinator and finish the authorized production update.

**Architecture:** Keep the current nominal full-release workflow and real-admin authentication. Add a checked-candidate cache command and resumable CLI client for the existing public platform producer. Guard standalone CLI selection and fix the strict system-status contract.

**Tech Stack:** TypeScript, Commander, Vitest 5, existing core release-state helpers, Docker inspection, Next admin updater.

**Spec:** `docs/superpowers/specs/2026-11-06-release-selection-safety-design.md`

## Global Constraints

- Never remove the Data Manager update guard, forge a session, extract user sessions from SQL, or bypass nominal maintenance.
- Preserve all five running container identities until the coordinated updater acts; preserve Valhalla customizations and global Node.
- Use existing release-store ownership and locks; Docker failure is unknown, not absence.
- Claude Opus is a reviewer only. Review the plan before product edits and the patch before merging.

## Review Focus

- A stopped or duplicate coordinator still prevents an unsafe pin change.
- Missing-overlay automatic selection cannot evade the guard.
- A refused selection leaves overlay/evidence files byte-identical.
- Recovery can reselect the exact pin that matches the running coordinator.
- A malformed or failed Docker observation cannot authorize publication.

### Task 2: Reproduce and guard release selection

**Files:** `packages/cli/src/lib/release.ts`; `packages/cli/__tests__/cli-release.test.ts`.

**Interfaces:** Extend `selectRelease` options with the existing `docker?: ReleaseDockerRunner` I/O seam. Use it only for Docker inspection; existing `resolve` still resolves and validates the candidate. `ensureReleaseOverlay` already has that seam.

- [ ] Add failing tests using real release files: changed DM pin with an existing container refuses; same immutable pin and matching actual image permits; no DM permits bootstrap; stopped DM refuses changed pin; duplicate, malformed and failed reads refuse; Config.Image match with image-ID mismatch refuses; old pin restoration works; rejected selection preserves overlay/evidence bytes.
- [ ] Add failing missing-overlay tests proving automatic selection has the same refusal and publishes no overlay/evidence.
- [ ] Run `pnpm exec vitest run --project node --maxWorkers=1 packages/cli/__tests__/cli-release.test.ts`; record the expected red boundary.
- [ ] Implement a private guard in `release.ts`: list all project/service-matched container IDs; strictly validate IDs and cardinality; inspect one exact container's Id/Image/Config.Image; inspect candidate image ID; compare exact references and image IDs; use `expectOk` for every external read. Invoke before either overlay write. Explicit selection holds the existing release lock; preserve automatic-selection lock conventions and let review identify any missing serialization before coding it.
- [ ] Adapt older test calls to supply an explicit zero-container Docker fixture, not a policy bypass flag.
- [ ] Run the release tests, lifecycle tests, CLI types, and focused lint. Confirm unchanged lifecycle guard assertions.

### Task 5: Correct operational guidance

**Files:** `packages/cli/src/commands/compose.ts`, `packages/cli/src/lib/service-lifecycle.ts`, `packages/core/src/ops/contract.ts`, `docs/docs/install/upgrading.md`, `docs/docs/install/managing-services.md`, `docs/docs/install/configuration.md`, `docs/docs/developer/cli-reference.md`, `docs/docs/developer/product-releases.md`.

- [ ] Replace the rejected five-service command and nonexistent positional rollback command with the guarded updater and truthful bootstrap/host-maintenance boundaries. Explain current and legacy updater paths, exact checked candidates, backups and forward-only migrations.
- [ ] Change CLI selection and coordinator-refusal messages to actionable supported guidance. Replace the generic `host_update_required` recommendation with host diagnostics and recovery guidance; do not promise a command that is rejected.
- [ ] Add a regression asserting the selection command and error hint name the supported workflow and do not recommend the rejected command.
- [ ] Format and build docs; run relevant core/CLI tests, CLI/core types, policy and full local verification. Record partial/failed gates honestly; do not loosen assertions or timeouts to claim success.

### Review R1 resolutions and mandatory additions

- [ ] F1: `ensureReleaseOverlay` accepts `releaseStoreLock?: coreServices.ReleaseStoreLock`; lifecycle passes its actual closure-held lock and clears it in finally. Absent a supplied lock, run migration first, preserve the read-only present fast path, acquire fail-if-busy, re-read selection under the lock, then hold/resolve/guard/write. Skip migration when a real held lock is supplied; hold checks remain. Test inherited lock/no reacquisition, concurrent holder returning held, post-lock overlay appearance, and lifecycle passing the actual object. No boolean bypass.
- [ ] F2: both locked selection paths refuse transaction.json before any publication; unchanged overlay/evidence assertions.
- [ ] F3: guard CLI clear against a matching coordinator; preserve malformed/mismatched recovery, conditional release-ID binding, fail closed on Docker ambiguity. Update clear semantics and tests.
- [ ] F4: update the host-update alert in SystemMaintenance, release-service-coverage assertion, generated INSTALL template, and relevant CLI hints. Visible alert change requires personally inspected comparable rendered screenshots and hosted PR evidence.
- [ ] F5: all test Docker fixtures reject unknown commands; every selection test supplies an explicit fixture. No developer Docker access in unit tests.
- [ ] F6: production status read returned maintenanceReady=false because system.inspect's strict nested release schema lacks selectedReleaseId. Minimal parser reproduction fails with unrecognized_keys. Fix it and verify runtime-through-parser. The bridge below uses the existing public platform producer directly, so bootstrap does not depend on that broken observation. Legacy requireCurrentAgent applies to legacy apply, whereas current system.update apply calls runGuardedSystemRelease/platform producer; do not remove its checks.

### Task 1: Correct the system inspection wire contract

**Files:** `packages/core/src/ops/contract.ts`, its focused tests, and `apps/ops-agent/src/production-runtime.test.ts`.

- [ ] Red: parse actual production system.inspect response with a selected overlay; it fails only on selectedReleaseId. Test another unknown release field still refuses.
- [ ] Add selectedReleaseId with the same optional stable-ID schema used by release.inspect; leave strictness intact.
- [ ] Green: core contract and production runtime tests; types and OpenAPI consistency.

### Task 3: Check candidates without switching pins

**Files:** new `packages/core/src/services/checked-release.ts` and tests; services export; `apps/ops-agent/src/administrative-runtime.ts`; CLI release helper/command/tests.

- [ ] Extract the existing canonical candidate cache publisher into core, preserving strict owned store enumeration, 64 entries, 32-KiB manifest limit, immutable matching bytes, receipt configuration/OCI/canonical digests and latest pointer. Keep Docker resolution in each existing caller.
- [ ] Expose CLI `compose release --check`, conflicting with status/clear; add a resolver returning manifest plus actual OCI digest while keeping the existing manifest-only API wrapper compatible.
- [ ] Validate configured selection before and after resolution; lock/recheck before cache writes. A check never writes overlay/current state or invokes lifecycle commands.
- [ ] Red/green tests: genuine validated candidate cached, selection and running-state bytes unchanged, immutable mismatch/unsafe files/full store/active transaction/configuration change refuse; ops-agent resolves through the shared publisher without changing existing results.

### Task 4: Authenticated, resumable CLI full-release update

**Files:** new `packages/cli/src/commands/system.ts`, focused `lib/system-update.ts` and `lib/admin-session.ts` (split receipt/client if needed), corresponding CLI tests, index registration, docs.

- [ ] Add `system update --release <id> --digest <canonical-digest> --session-file <path> --receipt <path>` with explicit target and resumable private receipt; no session value on argv. Use the existing public API only; no internal API module imports or private authority construction.
- [ ] Session reader checks real file, owner, mode0600, one link, bounded bytes and no newline/header injection. Do not persist credentials. Validate API URL (HTTPS or loopback HTTP), configured Origin, redirect:error and bounded request time/body; establish the real actor through `/api/me` and bind receipts to it.
- [ ] Stable before-POST receipts cover idempotent `/api/admin/services/backups`, current platform GET, exact release-only preview and apply (`/api/admin/platform/configuration/...`), and original `/api/admin/jobs/<id>` observations. Freeze actor, target, body and keys before transmission. A resume replays only the same idempotent request if its response was lost; once a job ID is known it only observes it. Never replace an expired preview automatically.
- [ ] Verify unchanged platform configuration/values/sources/origin, exact checked release and five-service target, no domain proof. Default backup must finish successfully before preview/apply. Validate application job's committed/complete outcome before reporting success.
- [ ] Test with a real local fixture HTTP server and temporary private files/receipts: happy sequence; real-admin rejection/impersonation rejected by API; no apply after failed backup; preview changes/out-of-scope targets refuse; response loss resumes same request/key; API restart/job polling loss never duplicates; changed actor/target/unsafe receipt refuses; expired preview stops; credentials absent from receipts/logs; redirects and insecure remote URLs refused. Use real parsers and mock only HTTP/Docker edges.
- [ ] Update docs and host-update hints to the new real-admin CLI bridge plus current/legacy UI paths. Explicitly distinguish checking a candidate from selecting pins and from applying it.

### Task 6: Review, CI, and production

- [ ] Submit the frozen patch and verification receipts to a fresh Claude Opus review; fix findings and obtain another review if the boundary changes.
- [ ] Create one PR with Medformatik and existing labels, immediately link it; verify full current-head CI and review state before normal merge.
- [ ] Verify exact latest main push CI and coherent release publication, including security scans.
- [ ] Use an authentic admin session for the existing coordinated updater; private credentials only. Inspect exact checked release, keep backup enabled, and observe the original job, with no fresh duplicate on unknown outcome.
- [ ] Independently compare actual running core images against the qualified manifest; verify health/public routes, both Valhalla hashes and global Node; deliver only after actual deployment is proven, or report a concrete credential blocker without claiming deployment.

## Review R2 resolutions — binding before implementation

- R2-1: CLI takes `--api-origin`, default `https://${DOMAIN}` after infra env loading. HTTPS only; explicit test/dev option permits loopback HTTP. Never send x-openmapx-local-admin, even when configured in env. Bind origin in receipt and require preview oldOrigin/newOrigin equal it.
- R2-2: Before backup, preview and apply, GET active jobs and refuse the same HOST_MUTATING_JOB_TYPES as admin-system, excluding the receipt's own completed backup. Refuse nonempty platform pending. Document this as advisory; the server's nominal writer remains authoritative.
- R2-3: Add actual public platform.apply native database modes `launch-native-release-api-before-save` and `launch-native-release-api-after-save`; prove recovery through hasRetainedImmediateConfiguration and complete outcome after API replacement. Run these tests before production. Fix actual recovery defects if the regression exposes any.
- R2-4: Move only the shared TrustedConfigurationApplyOutcome type/parser/completeness predicate into core ops; keep API error classes locally and re-export shared symbols to preserve imports. Parse all public session, platform, preview, acceptance and activity job responses with existing shared contracts. Require job status `success` and complete trusted outcome, not a generic succeeded string.
- R2-5: Persist/fsync separate valid backup, preview and apply keys and frozen bodies before POST. Backup has explicit valid name; require matching result.backupId. No no-backup option. Transport/5xx/429 means unknown and only the same request may replay. 400/403/409 are final and recorded; expired preview never regenerates silently. Known job IDs only GET-observe with bounded backoff across 502/503/ECONNREFUSED, and timeout preserves resume state.
- R2-6: Before any POST, verify the local immutable canonical checked manifest and digest, absence of transaction, and consumed/absent legacy handoff through a shared read-only core helper extracted from configuration-release. Also match preview.values.releaseSelector to the configured selector used at check time.
- R2-7: Shared cache function requires an actual held release-store lock, and shares only bounded store enumeration, canonical immutable write, receipt and latest writes. Existing ops-agent resolve adds no new transaction/config refusals; apply those in CLI callers only. Refuse an effective UID different from the existing store's owner before writes. Unset and explicit default selection yield identical configuration identity.
- R2-8: Before obtaining the new CLI on production, record platform expectedCurrentRevisionId and sourceRevision, then verify unchanged after ff/install. Prove old ops-agent mount scope first. No compose render/up for deployment. Run as actual store owner.
- R2-9: Never read browser cookie stores. CLI session file comes only from an operator-provided file or request_secret file delivery, verified mode/link/owner. Accept only Better Auth session-cookie names, ignore Set-Cookie, require real admin and a safe remaining expiresAt margin. API 403 is authoritative for impersonation, because /me omits that marker. Cookie-file deletion is operator choice, never implicit.
- Tests: fixture-server tests cover CLI 403 handling, not actual server authentication. Verify existing admin-platform route tests cover loopback/impersonation and add exact CLI-header/body route tests with services mocked. Record native database gate results explicitly.
- Receipt choice: fresh runs refuse an existing receipt path; `--resume <receipt>` is the only resume mode and binds actor/origin/target. A deliberately new run after expired preview uses a new receipt and creates a new backup. Activity truthfully shows platform.apply.
- Deployment client choice: Firefox was explicitly named by the user. Native Firefox is authentically signed in as full admin (`/api/me` admin=true); platform GET returns200/current revision/pending0. The parent may use that existing browser session with the same public API flow instead of exporting a cookie to run the CLI. This does not change the product CLI session-file contract or any server authorization. Owned diagnostic tab was closed; no cookie export or browser-store reads occurred.

## Pre-flight interface/order rulings

1. Execute numbered tasks 1–6 (headings are retained near their review context). Task1 is independent and establishes the precise wire regression first.
2. Tasks2/3 share a real held ReleaseStoreLock; no nested acquisition from lifecycle. CLI absence/unknown and ops-agent existing resolve semantics remain distinct by caller.
3. Task3 produces canonical checked bytes and configured-selector identity consumed by Task4's read-only preflight. Task4 never selects pins.
4. Tasks1/4 share public contract validation; move the outcome parser without changing API behavior. Native restart coverage is mandatory before deployment, not inferred from fixture tests.
