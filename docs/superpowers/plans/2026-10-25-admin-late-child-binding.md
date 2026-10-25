# Late Child Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. These are additional steps inside existing Task02.3, not a new independent task.

**Goal:** Admit late short-budget children without replacing or extending their original root.

**Architecture:** Immutable finite root reservations plus one issuer-signed exact phase binding. Existing grant, admission, cancellation and retention mechanisms consume that binding.

**Tech Stack:** TypeScript, existing Ed25519/private filesystem protocol, PostgreSQL child CAS, Vitest/process fixtures.

**Spec:** `docs/superpowers/specs/2026-10-25-admin-late-child-binding-design.md`.

## Global Constraints

All accepted control/retention contracts remain binding except future child exact identity may be late-bound through this fixed reservation. Combined64 plan slots,8KiB cell/128KiB aggregate, existing64KiB admission/128KiB lease and family/index limits remain. Never edit applied0042. Only Codex6.1Sol; no user questions, no additional delegated writer or reviewer from the implementer.

## Review Focus

1. Hours-late phase preserves original root ownership and gives only the existing child budget.
2. Concurrent or restarted bind cannot change body/deadline/phase or dispatch twice.
3. Cancellation between binding and exposure cannot lose an attempted descendant.
4. Missing private/DB/grant checkpoints do not become new forward authority.
5. Slot allocation and family collection stay bounded and recoverable at capacity.

## Task02.3 additional steps: finite phase bindings

**Files:** Create focused `packages/core/src/build-artifacts/child-phase.ts` and `child-phase.test.ts`; modify `control-authority.ts`, `target-lease.ts`, `index.ts`, fixed spawn/parent adapters and their named tests. Reuse existing indexed/private-record constructors; no new key or generic plugin. Modify02.3's `services/data-manager/src/jobs/execution/ops-children.ts`, store/runtime tests and existing process fixtures; deadline-only CLI/agent callers use the same resolver. Keep new responsibility in the focused module instead of growing another authority monolith.

**Interfaces:** Export exact `ControlChildReservation`, `bindControlChildPhase` and `lookupControlChildPhase`, plus nominal `FreshControlChildDispatch`/`issueControlChildPhase`/`consumeControlChildDispatch` from the spec through the server-only barrel. Root admission/restoration accepts immutable optional reservations. Existing consumers resolve both exact and bound plans; no receiver wire relaxation.

- [ ] Write causal late120s root/delegation regression before core implementation; capture missing/expired exact-plan failure against real authority/lease state. Run `pnpm exec vitest run packages/core/src/build-artifacts/child-phase.test.ts --maxWorkers=1`.
- [ ] Add immutable reservation parsing and preallocated bounded indexed cells; implement signed one-time bind/lookup and unchanged duplicate restoration, finite graph and wholly fixed body policy, root-owned preallocated candidate IDs and original normalization. Preserve raw old exact receipt identity when reservations are absent. Same-slot race and clock/expiry tests use actual filesystem processes.
- [ ] Integrate exact resolver into lease and deadline-only grant/spawn paths. Implement module-internal publishReservedLeaseGrant holding lease→root-first ancestry→local execution guards through publication; register finite lease-attempt records in the execution cancellation index and reconcile the union with shared lease grants. Add actual paused-after-precheck local/ancestor cancel races, opposite-order partial publication and deadline-only cases, not just binder races. Pin no-post-on-ambiguous-checkpoint and existing attempted-descendant behavior with focused core/process tests. Run the new file plus affected authority/admission test selections, not every unchanged suite.
- [ ] Wire real DM child store CAS and typed adapters: confirmed reserved full-body CAS → immutable binding → confirmed bound CAS → scope-held grant/reference/outbox → confirmed attempted/dispatch-claimed CAS + fresh nominal one-use ticket → one POST. Model reserved/bound/attempted/observing/terminal/unknown as a strict JSON union with stage-specific real fields; update store immutable-transition checks, no dummy grant values. Recover original body and grant via fixed slot publication reference; no fresh issuance ticket or mutation replay. Add crashes after every body/binding/DB/outbox/shared/node/linkage step, two same-slot callers, ambiguous/stale CAS and exact state assertions. Add real PostgreSQL child races and actual separate-process DM→assembled-agent late-phase/admission/loss/cancel tests. Use existing owned synthetic DB verification and applied0042.
- [ ] Run affected package types and host-authority policy once stable; self-review changed interfaces and consumers. Append exact RED/GREEN/time/exit/limits to Task02.3 report/evidence and include changes in its local normal-hook commit. Controller reviews whole02.3 afterward; no independent commit/PR/deploy requirement for this substep.

Self-review: all five risks have named tests; interfaces match the spec, all body values are root-fixed and IDs preallocated, old exact plans remain valid, and no generator/DB migration is required by this correction. Independent scoped R2 review is READY with I1–I4 addressed and0 open; execute these steps in02.3. Design readiness does not qualify implementation. Binding envelope is version2/openmapx-control-phase-binding-v2; reservation/origin metadata version1 and legacy verifier remain unchanged. Test wrong version/domain/changed origin and capacity/unbound allocation/reclamation. Test fixedCLI reservation transport and actual matching single data commands→durable DM, including protocol-level sequential phases and no target hold by a waiting deadline-only parent. The complete original Full Update command with build/link and actual production default-CLI acceptance is assigned to original02.4 after01.2; it must resolve the finite finalization graph before implementation and preserve all semantics. This is an execution allocation correction, not a new authority edge or waived final proof.
