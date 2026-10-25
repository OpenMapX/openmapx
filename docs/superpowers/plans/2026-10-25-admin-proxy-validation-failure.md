# Fixed Proxy Validation Failure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. These steps extend existing Task02.3; no new task is added.

**Goal:** Settle a conclusively completed read-validation failure so the existing owned parent can recover safely.

**Architecture:** Fixed nonce-bound nginx wrapper, private mutually exclusive validation/reload commitment, exact signed failed-child settlement and existing parent recovery. Unknown failures remain fenced.

**Tech Stack:** TypeScript, existing Docker/contained-process adapter, role-signed indexed records, Vitest/process/real PostgreSQL fixtures.

**Spec:** `docs/superpowers/specs/2026-10-25-admin-proxy-validation-failure-design.md`.

## Global Constraints

Only feedProxy.validateAndReload validation phase gains this private proof. No public schema/operation/graph/key/migration changes; applied0042 remains immutable. Existing deadlines, cancellation, private single-link records, bounded4096-byte cell/index/retirement and exact canonical terminal commitment remain binding. Use only Codex6.1Sol; no subagents from the implementer or user questions.

## Review Focus

1. Docker transport failure cannot masquerade as an nginx validation failure.
2. Reload-attempted or altered candidate cannot acquire no-publication proof.
3. A canceled/expired parent never starts restore despite a known failed child.
4. Crash recovery never invents a terminal tuple, repeats effects or renews time.
5. Real mounted hardlinks and actual registry claims are exercised, with private trust checks unchanged.

## Additional Task02.3 steps

**Files:** Create focused `apps/ops-agent/src/feed-proxy-validation.ts` and `.test.ts` for the constant wrapper/marker parser; modify `docker-runtime.ts`, `runtime.ts`, `server.ts`, relevant actual process fixtures/tests. Add finite private proof in `packages/core/src/build-artifacts/control-authority.ts` (use a focused internal helper if needed), barrel/retention consumers and affected core tests. Modify DM `jobs/execution/{ops-children,store,runtime,worker-scope}.ts`, `jobs/transitous/proxy-transaction.ts`, core `data-execution-journal.ts` and corresponding process/PostgreSQL tests to enforce the finite parent recovery obligation and authenticated settlement; do not add a new graph edge. No SDK generator is required.

- [ ] Capture causal RED in the actual DM→production resource claimer→agent validation/restore chain; ordinary mock-stage assertions are insufficient.
- [ ] Implement fixed wrapper/strict marker handling using existing real contained runner; reserve bounded original-authority phase cell before effects, publish the typed producer proof and reload-start marker through purpose-bound context methods.
- [ ] Preserve verified failure settlement through failed transition/borrowed settlement/canonical terminal and exact restart repair; accept no generic failed status or arbitrary error as proof.
- [ ] Persist original restore reserved child before any restore/relink writes; implement one finite assertOwnedProxyRecoverySettled policy using current original-plan/DB/private child evidence. Gate live/terminal SQL/private worker completion/root settlement/release AND restart/cleanup/retirement. Do not relabel a known failed child unknown.
- [ ] Add causal stage-validation-failure→restore-validation-failure→restart proof with parent publication unknown/no final timestamp, original physical target retained and no extra POST. Pair with successful-restore case releasing once but preserving failed parent, plus reservation/file/validation crash gaps and cancel/expiry/mismatched evidence.
- [ ] Add actual invalid-validation→restore GREEN plus all negative/cancel/expiry/crash/hardlink cases specified above. Run only the named new/affected core/agent/DM selections while iterating; final affected types/host-authority and scoped style once stable.
- [ ] Include exact command/output/exit/substitutions and remaining platform limits in02.3 evidence/report, self-review and normal-hook local task commit. Controller's independent whole02.3 task review covers this extension; implementer does not spawn another reviewer.

Self-review: each review risk is pinned to tests; existing primitive/result/continuation semantics remain fixed. Scoped R2 is READY with R1-I1 addressed and0 open; implement these steps in02.3. Design readiness does not qualify implementation/runtime.
