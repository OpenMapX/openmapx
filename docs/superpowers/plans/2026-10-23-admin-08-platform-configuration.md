# Platform and Service Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make supported service resources and platform/domain/TLS/release settings manageable through an honest, coordinated admin workflow.

**Architecture:** Keep non-secret platform ownership in the applied configuration generation and resolve it identically in CLI/API/agent consumers. Extend manifest-backed service forms with explicit safe settings; privileged application remains behind sealed typed operations and existing revision CAS.

**Tech Stack:** TypeScript, Zod, Fastify, React/MUI, configuration generations, generated service-admin SDK, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-admin-instance-management-design.md`.
Shared execution/lease/candidate contracts are defined by
`docs/superpowers/specs/2026-10-23-admin-control-protocols.md`; use those exact
interfaces once finalized, without inventing a competing coordinator.

## Global Constraints

All specification constraints apply. Cover C01-C07. Do not expose arbitrary
environment editing, shell commands, registry credentials, executable JVM/Node
options, bind paths, Docker privilege/network settings or platform bootstrap keys.
Preserve current memory/command defaults until the operator saves an override.
Environment ownership changes require an explicit previewed adoption action.

## Review Focus

1. A no-op save must retain byte-equivalent runtime behavior, including capitalized Valhalla booleans and symbolic MOTIS memory defaults.
2. A stale revision, pointer commit followed by failure, or lost result cannot restore unrelated configuration or falsely report non-commit.
3. Domain/TLS changes must update routing, API/auth origins, web runtime environment and reconnect guidance coherently.
4. Resource settings must change Docker resources rather than become inert container environment variables.
5. Host-owned values and bootstrap credentials must not be disclosed or silently superseded by a database save.

## Task C1: Canonical non-secret platform state and ownership

**Files:** Create `packages/core/src/services/platform-configuration.ts` and
`packages/core/src/services/__tests__/platform-configuration.test.ts`. Modify
`packages/core/src/ops/trusted-config.ts`, `packages/core/src/services/configuration-generation.ts`,
`packages/core/src/services/index.ts`, `packages/cli/src/commands/compose.ts`,
`apps/api/src/services/trusted-config-operations.ts`. Extend existing
configuration-generation, trusted-config and CLI-compose tests.

**Interfaces:** Export `PlatformField<T> = { source: "host" } | { source:
"database"; value: T }`; `PlatformConfiguration` has version `1` and optional
`domain`, `acmeEmail`, `releaseSelector`, `defaultRegion`, `backupRetentionDays`
fields. Export `resolvePlatformConfiguration({ saved, env, overrides })` returning
`{ values, sources, warnings }`. Values are non-secret. Add optional `platform`
to `TrustedConfigurationPayload`; older generations without it keep host behavior.
The existing required `domain` equals the resolved domain. Explicit CLI arguments
override for that invocation; absent flags do not replace persisted adoption.

Resolved values have exact keys `{domain:string,acmeEmail:string,
releaseSelector:string,defaultRegion:string|null,backupRetentionDays:number}`.
Host mappings/defaults are DOMAIN/localhost, ACME_EMAIL/admin@example.com,
OPENMAPX_RELEASE/main, OPENMAPX_REGION/null and
BACKUP_RETENTION_DAYS/30. Explicit platform adoption previews that
these known generated slots will use UI ownership instead of host values until
Return to host is applied; this is not permission to adopt arbitrary env keys.
Service/integration fields retain file/env precedence and manual host handoff.

- [ ] Add tests: host defaults win without adoption; explicit database adoption survives later CLI render; explicit CLI override applies; returning ownership to host clears the database value; malformed domains/email/selector/region/retention reject; old generations remain readable; secrets never appear in inspection/export.
- [ ] Run `pnpm test packages/core/src/services/__tests__/platform-configuration.test.ts packages/core/src/services/__tests__/configuration-generation.test.ts packages/core/src/ops/trusted-config.test.ts packages/cli/__tests__/cli-compose.test.ts --maxWorkers=3`; verify causal RED for missing state/resolution.
- [ ] Implement the resolver and generation persistence/readers. Domain is a hostname or localhost (no URL/port/path/credentials); ACME email <=320 characters and syntactically validated; selector uses `normalizeReleaseSelection`; region uses existing allowed resource identifiers; retention is integer 1-36500 days. Host/DB ownership is metadata, never an unvalidated env map.
- [ ] Thread state through CLI/API preparation under existing writer/CAS semantics. Do not read the database from core/CLI. Preserve the platform projection when applying unrelated service/integration changes.
- [ ] Route default-region consumers through this resolver: CLI default region lookup, agent fixed CLI invocation and generated data-manager OPENMAPX_REGION. Explicit per-operation regions remain allowed only by the agent deployment allowlist. A saved default cannot broaden deployment source/region authority.
- [ ] Re-run the named tests to GREEN and commit the complete canonical-state task.

## Task C2: Safe manifest settings and actual resource rendering

**Files:** Modify all 30 current `services/*/service.json` built-in manifests
(`app-api`, `app-web`, `brouter`, `data-manager`, `dawarich-app`,
`dawarich-postgis`, `dawarich-redis`, `dawarich-sidekiq`, `elasticsearch`, `local-ai`,
`martin`, `motis`, `motis-feed-proxy`, `motis-staging`, `nominatim`, `ops-agent`,
`osrm`, `otp`, `overpass`, `pelias`, `pelias-pip`, `pelias-placeholder`, `photon`,
`postgis`, `redis`, `tileserver`, `traefik`, `transitous-runner`, `valhalla`,
`well-known`). Assert this exact inventory before editing and explicitly reconcile
any added or removed manifest rather than silently omitting it. Modify
`packages/core/src/services/compose-renderer.ts`, `config-resolver.ts`,
`apps/api/src/services/service-config-resolver.ts`. Create focused
`packages/core/src/services/runtime-resources.ts` and tests; extend manifest and
renderer tests. Also modify `apps/web/src/integration-api/runtime/{env.ts,EnvProvider.tsx}`,
`apps/web/src/integration-api/overlay/overlayZoomGate.ts`,
`apps/web/src/lib/serverClientEnv.ts` and their tests; extend the actual
`integrations/overlay-traffic-tomtom` layer tests. No new untrusted manifest execution capability.

**Interfaces:** Reserved numeric fields `OPENMAPX_MEMORY_MIB` (integer16-1048576)
and `OPENMAPX_CPU_LIMIT` (number0.125-256) target Docker `deploy.resources.limits`,
not environment. Absence preserves the manifest's limit, including interpolation.
`resolveServiceRuntimeResources(manifest, values)` returns `{ memory?: string;
cpus?: string }`. Strip reserved keys from emitted environment. Use the same
strict numeric bounds in schema and renderer; community manifests cannot use
these reserved fields to escape their existing sandbox/resource authority.

- [ ] Add a manifest inventory test proving every current built-in has operator resource metadata and existing declared fields remain intact. Add render tests proving actual memory/CPU placement, no reserved environment keys, omitted overrides preserve defaults, invalid values reject and unrelated service output stays unchanged.
- [ ] Run `pnpm test packages/core/src/services/__tests__/manifest-schema.test.ts packages/core/src/services/__tests__/compose-renderer.test.ts packages/core/src/services/__tests__/community-service-config.test.ts --maxWorkers=3` plus the new resource tests; verify RED before changing production rendering.
- [ ] Implement exactly the supported fields in the table below, plus common resource controls for all30 built-ins. Keep all five existing schemas. Preserve scalar serialization required by each image (Valhalla booleans are `True`/`False`). Add a field-to-runtime-consumer table in administration docs. Do not invent settings for images without a supported knob.
- [ ] For heap controls expose bounded numeric MiB, never free-form `JAVA_TOOL_OPTIONS`, `ES_JAVA_OPTS` or `NODE_OPTIONS`; synthesize only the known heap flag for the specific built-in consumer. Do not expose shell-containing preprocessing/command fields. Treat MOTIS primary/staging resource changes as coordinated operations under current capacity policy.
- [ ] Ensure managed web environment reads occur on the server at runtime, avoiding build-time `NEXT_PUBLIC_*` substitution for fields promised as live configurable. Verify with rendered-server/production-build tests, not only source object assertions.
- [ ] Complete the existing raster traffic zoom knob: `ClientEnv.trafficMinZoom?:number` reads validated integer0-24 from NEXT_PUBLIC_TRAFFIC_MIN_ZOOM, with invalid/unset omitted. Add `useOptionalEnv():ClientEnv|null` beside existing strict `useEnv`; `useOverlayMinZoom('traffic')` uses the configured value or the registry manifest's default10. Other overlays retain their manifest policy, including traffic-flow default6. Both the raster layer and layer-selector gate already consume this shared hook; test they agree at changed zoom8, malformed input retains10, and unrelated gates remain unchanged. This is a raster traffic control; do not silently alter the separate vector-flow integration.
- [ ] Share a bounded URL parser for API/UI/migration: empty means default; allow absolute http(s) with no userinfo, or a same-origin root-relative path beginning one `/`, never `//`, backslashes or controls. Ordinary base/TileJSON/attribution URLs accept no placeholders; tile-template fields permit only `{z}`,`{x}`,`{y}`,`{s}` supported by their consumer. Preserve `/local-dem/tiles.json`, `/local-contours/tiles.json` and existing same-origin tiles/glyph-base paths. Map style legacy key denotes the glyph server base; do not mislabel it as a complete style JSON URL.
- [ ] All service forms/imports use plan01's strict `prepareProspectiveConfiguration` candidate and plan04's effective-source guard before persistence; a failed service read or total sealed snapshot overflow is a refusal, never a default generation. Resource ownership detects both SERVICE_* overrides and supported host variables referenced by the manifest's resource expression.
- [ ] Run focused schema/resolver/renderer tests, `pnpm check-ops-authority` and affected types to GREEN; commit the field/resource task.

## Task C3: Typed platform preview/apply and recovery

**Binding release/helper ownership:** Consume the [approved release/handoff allocation](../specs/2026-10-27-admin-release-handoff-allocation-design.md), R1 READY.01.2 supplies the actual staged-source pre-write predicate and temporary unsupported boundary for legacy release application, agent replacement and helper/startup recovery;01.4 respects it. THIS task MUST replace that boundary with actual coordinated supported release/helper functionality in the SAME final PR. Cover production release adapter transaction/overlay/state, detached helper write/restore/reconcile and startup recovery; every effect requires original owned target -> actual configuration writer -> release lock and live source revalidation, never a parent checked boolean or writer spanning process replacement/fixed CLI. Existing same-image configuration and new-image release are distinct modes: the same-image frozen graph below does not implicitly authorize a new-image mode. Obtain a reviewed finite amendment if the installed accepted graph cannot express that release mode. No new root/key/graph by allocation, no permanent feature removal. Add actual old/new-image helper process death/restart, delayed write versus concurrent staged DM, lost response, failed restore/unknown ownership, original evidence preservation and lock-order acceptance before re-enabling capabilities. Final full PR/CI cannot be complete while release parity remains unsupported.

**Files:** Create `packages/core/src/api/contracts/service-admin/platform.ts`,
`apps/api/src/routes/admin-platform.ts`, `apps/api/src/services/platform-configuration.ts`,
`apps/ops-agent/src/platform-configuration-runtime.ts` and focused tests. Modify
service-admin `index.ts`, core ops contract/policy/trusted-config handlers,
`apps/api/src/routes/index.ts`, `apps/ops-agent/src/index.ts`, and generation
rendering adapters. Create `apps/ops-agent/src/configuration-handoff.ts` and
`configuration-handoff-main.ts` plus tests, reusing the existing confined
`agent-handoff.ts` Docker/helper machinery. Modify `server.ts`,
`administrative-runtime.ts`, build-runtime entrypoints and API job recovery in
the same task window. These shared files are controller-serialized with plans01/02.

**Interfaces:** Service-admin operation IDs `getAdminPlatformConfiguration`,
`previewAdminPlatformConfiguration`, `applyAdminPlatformConfiguration` at
`GET /api/admin/platform/configuration`, `POST .../preview`, `POST .../apply`.
Preview input is `{ expectedCurrentRevisionId: string|null, changes: PlatformConfiguration }`;
output includes bounded effective values/source metadata, affected service IDs,
old/new public origin, warnings, preview fingerprint and required confirmation.
Apply binds the exact revision/fingerprint to durable API job
`platform.apply`. Consume01.2/control-protocol§5.4: whole-candidate/schema/source/size/queue/private-receipt preflight FIRST, then ownership-only
`configurationMaintenance.prepare` and its durable DM fence before desired rows/proofs commit.
Under that remote fence recheck proof/policy/source/config and atomically save desired rows,
consume proof and checkpoint the exact continue decision. Only then publish the retained
snapshot using existing typed `stack.render`/`applyTrustedConfigurationSnapshot`;
ordinary follow-up and protected handoff borrow that SAME frozen maintenance root.
API cannot construct host authority or acquire a second root. Do not create a long-lived `platformConfig.apply` agent ancestor
that waits while the helper tries to drain it. The API job survives/reconciles
through child/handoff identities; result retains committed revision, follow-up
status and recovery instructions.

`ProtectedConfigurationServiceId = 'postgis'|'redis'|'app-web'|'app-api'|'traefik'|'ops-agent'`.
API-role typed `configurationHandoff.prepare` input is `{handoffId,maintenanceId,candidateId,planDigest,serviceIds,
expectedCurrentRevisionId,expectedImageIdentities,previewFingerprint}`.
These fields match01.2's frozen plan; expectedCurrentRevisionId is the desired generation
already committed by its exact stack.render receipt. The previous generation remains
`ConfigurationMaintenanceBinding.expectedCurrentRevisionId`, never a new pointer sample. IDs are a
nonempty unique subset of that finite set; image expectations must match the
currently owned containers and trusted current pins, never a request to select a
new image. Result is only `{handoffId,phase:'prepared'}`, not applied. Typed
`configurationHandoff.inspect {handoffId}` returns safe retained
`{phase:'prepared'|'draining'|'applying'|'verifying'|'applied'|'rolled_back'|'failed'|'recovery_required',
expectedRevisionId,appliedRevisionId:string|null,completedServiceIds,failedServiceIds,recoveryCodes}`.
Both use strict schemas/operation identity and existing journal bounds; status
inspection remains allowed during handoff. Same-image configuration and release
replacement are distinct modes; do not call the current updateAgent no-op branch.

The helper record is a bounded versioned configuration-handoff variant with
parent operation key/fingerprint, exact old/new generation identities, verified
image/container identities, target subset, deadline, lease delegation and
launch-attempt/phase evidence. It lives at a fixed agent-owned location; no path
crosses the API. Retain completed evidence for the existing journal retention.
The helper adopts only§3.5's finite agent→configuration-helper grant, at depth2
under the maintenance root/handoff child, and cannot broaden target/image authority.
It retains maintenanceId/candidateId/planDigest and02.3's exact DM fence receipt;
no second maintenance flag, DM reservation or target root is created. No configuration writer lock survives process
replacement: acquire/revalidate it in the helper after adopting the target lease.

For a domain change, consume plan03's `platform.domain.apply` proof bound to the
actor and exact preview fingerprint. It requires a freshly successful supported
password login plus the user's effective TOTP/recovery factor. Email-OTP is
ineligible because the installed plugin does not produce the required MFA
assurance. Neither a password row nor a domain-bound passkey/OAuth session qualifies by itself. Preview
and confirmation retain the policy revision and external DNS/TLS/OAuth
acknowledgments. A passkey-only/unknown-password administrator must establish and
prove an alternate supported login before apply; no security-policy weakening.
Export `assertDomainRecoveryPreview({actorId:string,previewFingerprint:string,
expectedCurrentRevisionId:string|null,expectedAuthPolicyRevision:string},
tx:AuthDatabase):Promise<void>` from `platform-configuration.ts`. It checks the
actor-bound unexpired stored preview, expected configuration and live policy
revision in the same desired-row transaction that consumes the proof and checkpoints
the retained `platform.apply` continue decision, after whole-candidate preflight and
remote ownership-only preparation. Initial job/prepare admission never consumes it.
Recheck the retained policy/preview before the first host effect.03's challenge
stores the preview/policy binding without importing this later module.

- [ ] Add API/agent integration tests: unauthorized caller/unknown field/stale revision reject before writes; concurrent service config retains unrelated fields; commit-follow-up failure preserves commit evidence; changed preview cannot apply; hostname/TLS/web/auth values agree; helper/API replacement resumes the same job after disconnect.
- [ ] Run the new platform API/runtime tests plus trusted-config tests to expected RED.
- [ ] Implement platform preview and durable apply using plan01's supported action capabilities and plan02's retained outcomes. Materialize adopted domain/ACME values in known renderer slots so stale host `${DOMAIN}`/`${ACME_EMAIL}` interpolation cannot undo the chosen values. Never perform general template evaluation or rewrite `.env`.
- [ ] Preview exact origin consumers: routing, CORS_ORIGIN, BETTER_AUTH_URL, PASSKEY_RP_ID/PASSKEY_ORIGIN, app-web API URL and tileserver public URL. Require the proven alternate-login ceremony above, explicit DNS/TLS/OAuth/passkey acknowledgment and retained reconnect/host recovery evidence. Tests deny passkey-only and random-unknown-password rows, accept a newly proven password+requiredMFA, and reject a proof for another preview or policy revision.
- [ ] Prepare the exact prospective snapshot and all budgets/private receipts before remote ownership admission. Consume01.2's `prepare/inspect/decide/settleConfigurationMaintenance`: agent acquires frozen targets then02.3's durable DM guard; under prepared ownership recheck candidate/pin/source/config/proofs, commit desired rows/proofs/decision in one transaction, and authorize only the retained continuation. Known rollback may abandon only the exact unused reservation; unknown save/transport remains fenced/lookup-only. Ordinary generation/hardlink/recreation children and protected handoff use the same authority; do not reacquire targets after DB save. Before helper drain `configurationHandoff.prepare` must have a durable terminal prepared result and no held parent writer; the API job observes the handoff independently. The launched helper waits for that original terminal record and drains blocking host activities (mutating operations and active byte transfers), refusing new mutations/byte streams while allowing inspection/logs. Read-only log observations cannot indefinitely block drain. It then recreates in fixed dependency order: requested postgis/redis (health first), web, API, edge and agent last. Actor/job/intent stays retained while API/DB/origin is unavailable. The DM guard is a terminal prepared logical record, never a live worker owning a lease to be drained. DM recreation preserves its private startup mirror and DB guard; the new process admits no cron/API/CLI/data work before loading the fence. Only the frozen signed generation-hardlinks leaf may execute, and it settles before recreation. A target with unresolved backend work or unsupported health/recovery prerequisites is blocked before committing; do not queue a generic apply that cuts its coordinator.
- [ ] The helper uses fixed same-image Compose recreation and verifies actual environment/resource/mount identities against the exact desired generation, plus normal health and image identity. Secret-backed comparisons remain private/keyed; no public raw values or guessable secret hashes. Record each service's verified phase before proceeding. Resource-only agent changes must really change Docker memory/CPU even when image identity is unchanged. The helper survives the old agent's exit; newly started API/agent recovers the same handoff rather than relaunching it.
- [ ] Persist helper launch intent before Docker create and use a deterministic owned helper identity. Lost launch response reconciles Docker/journal evidence, never blindly creates another helper. Unprovable launch/application is recovery_required with the target fence retained. Automatic rollback may restore the exact previous generation/target configuration only when no competing revision/owner exists and old identities are proven; restoring a release overlay alone is insufficient. A newer writer or unprovable state yields unknown recovery, not a claimed rollback.
- [ ] Settle through01.2 only after exact desired generation/environment/resource/mount/readiness and every child/helper receipt prove commit or containment. DB/cache loss keeps DM startup admission closed via its private mirror; missing/unknown evidence never clears it. The same maintenanceId keys the existing helper drain/transfer gate; terminal maintenance/decision/handoff preparations do not count as live ancestors. Inspect existing receipts after API/agent replacement, never replay attempted phases or consume proofs again.
- [ ] Test production assembly with actual helper process boundaries: same-image agent limit changes, terminal-before-drain, API observer loss/restart, edge env recreation, DB/cache coordinator loss/health recovery, changed configuration during apply, launch-response loss and failure after each target. Add API death before/after desired-row save, lost maintenance prepare/decision response, DM recreation/startup cron blocking, and protected postgis outage with a retained DM guard. Assert no nested target root/self-conflict, no drain waiting on its own terminal preparation, and no release while a child/guard is unknown. Unsupported legacy agent/helper capability returns an actionable host-update prerequisite before ownership admission.
- [ ] Re-run integration tests GREEN; inspect serialized responses and regenerate canonical API/SDK outputs through the controller before committing.

## Task C4: Platform form, release/retention consumers and documentation

**Files:** Create `apps/web/src/components/admin/settings/PlatformConfiguration.tsx`
and tests. Modify `SystemSettings.tsx`, `ServiceConfigForm.tsx`,
`packages/cli/src/lib/release.ts`, `packages/core/src/services/release-manifest.ts`,
`apps/ops-agent/src/administrative-runtime.ts`, `apps/ops-agent/src/index.ts`,
`packages/cli/src/commands/backup.ts`, and affected configuration/administration docs.
Release/retention consumers are serialized with plan09.

**Interfaces:** All release/backup consumers call the C1 resolver using current
applied state; no module independently snapshots a retention/selector env value
that would make an applied UI setting inert. Readonly origin/ownership/pending/
recovery state is part of the generated platform response. Form edits do not
automatically apply, and confirmation binds the preview.

- [ ] Add UI behavior tests for host-owned locked values, adoption preview, pending edits, conflict, partial/unknown outcome, public-origin reconnect and copyable recovery. Add consumer tests proving changed selector drives release resolution and changed retention drives create/prune/restore/scheduled janitor consistently.
- [ ] Run new platform UI tests and CLI release/backup plus agent release/retention tests to causal RED.
- [ ] Implement the form with existing schema/shared admin components and explicit source ownership. Add field documentation for supported settings and host-only bootstrap keys; document restart/rebuild/application timing and origin recovery.
- [ ] Run focused tests GREEN; inspect actual desktop/mobile rendering with synthetic state. Record local verification without PR screenshots. Commit the complete task after task review.

## Self-review

C01-C04 map to C1-C3; C05-C07 map to C1/C3/C4. Review Focus1/4 map to C2,
Focus2/3 to C3 and Focus5 to C1/C4. Cross-plan lifecycle and job consumers must
use the finalized plan01/02 interfaces. Plan09 consumes C1's resolver for
retention/selector and must not implement a competing settings store.

Exact service/field inventory follows; shared method names are reconciled against
all subsystem plans before execution. No executable options are authorized.

## Safe field inventory

These are explicit additions to existing schemas. Integer bounds reject rather
than clamp. Resource-only manifests still receive useful memory/CPU controls.

| Service       | Fields and validation                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Runtime consumer                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app-api       | LOG_LEVEL finite Pino levels; RATE_LIMIT_IMAGE_PROXY_MAX_BYTES 1048576-10737418240; WINDOW_MS 1000-3600000; MAX_CONCURRENT_PER_CLIENT 1-256; MAX_CONCURRENT_GLOBAL 1-4096 (full RATE_LIMIT_IMAGE_PROXY_ prefixes)                                                                                                                                                                                                                                                       | API logger and routes/image-proxy-budget.ts                                                                                                                 |
| app-web       | NEXT_PUBLIC_STYLE_PROVIDER openmapx/maptiler; NEXT_PUBLIC_MAP_STYLE_URL (glyph base), NEXT_PUBLIC_TILES_URL, NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE, NEXT_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE, NEXT_PUBLIC_TERRAIN_DEM_TILEJSON_URL, NEXT_PUBLIC_TERRAIN_CONTOUR_TILEJSON_URL optional validated http(s) or root-relative values; attribution name <=200 and URL same ordinary URL grammar; NEXT_PUBLIC_TRAFFIC_MIN_ZOOM optional integer0-24, unset uses raster manifest10 | dynamic server env projection into browser; map style/glyph base consumer, actual terrain/tile consumers and shared raster traffic layer/selector zoom hook |
| data-manager  | LOG_LEVEL finite Pino levels; OVERTURE_DUCKDB_MEMORY_MB 256-1048576; OVERTURE_DUCKDB_THREADS 1-64; OVERTURE_DUCKDB_TEMP_MB 1024-10485760                                                                                                                                                                                                                                                                                                                                | existing data-manager runtime parser, enforce its stricter bounds if present                                                                                |
| local-ai      | OLLAMA_KEEP_ALIVE bounded duration or0, at most24h; OLLAMA_MAX_LOADED_MODELS 1-32                                                                                                                                                                                                                                                                                                                                                                                       | Ollama image environment                                                                                                                                    |
| elasticsearch | OPENMAPX_JAVA_HEAP_MIB 128-262144                                                                                                                                                                                                                                                                                                                                                                                                                                       | synthesize only -Xms/-Xmx in ES_JAVA_OPTS; never accept arbitrary JVM flags                                                                                 |
| nominatim     | THREADS 1-256; REPLICATION_UPDATE_INTERVAL 60-604800; IMPORT_STYLE full/admin/street/address; REVERSE_ONLY, IMPORT_WIKIPEDIA, IMPORT_US_POSTCODES, IMPORT_GB_POSTCODES boolean                                                                                                                                                                                                                                                                                          | existing image environment; annotate import-time settings requiring rebuild                                                                                 |
| photon        | REGION existing resource-region validator; UPDATE_STRATEGY PARALLEL/SEQUENTIAL; UPDATE_INTERVAL bounded duration1h-8760h; LOG_LEVEL TRACE/DEBUG/INFO/WARN/ERROR                                                                                                                                                                                                                                                                                                         | existing Photon image environment                                                                                                                           |
| overpass      | OVERPASS_SPACE 1073741824-10995116277760; OVERPASS_FASTCGI_PROCESSES 1-128; OVERPASS_UPDATE_SLEEP 60-604800; OVERPASS_RULES_LOAD 1-100                                                                                                                                                                                                                                                                                                                                  | existing image environment; exclude preprocessing shell fields                                                                                              |
| postgis       | POSTGIS_DIAGNOSTICS, POSTGIS_TRACK_IO_TIMING boolean                                                                                                                                                                                                                                                                                                                                                                                                                    | existing entrypoint diagnostics settings                                                                                                                    |
| valhalla      | serve_tiles, build_time_zones, use_tiles_ignore_pbf boolean in addition to existing schema                                                                                                                                                                                                                                                                                                                                                                              | existing image environment, capitalized boolean adapter                                                                                                     |

Duration validation accepts only a finite numeric value with documented unit;
no shell substitutions. Image capability tests verify enum support; if an upstream
image lacks an enumerated value, restrict to its supported set and record the
source-grounded correction in the review ledger before implementation.
