# Fixed-reference fence settlement implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. This is an amendment INSIDE Task01.2, not a new program task.

**Status:** Approved after independent R5 READY; implementation and all actual proof gates remain Task01.2 work.

**Goal:** Settle the original DM guard from authenticated actual final evidence without mutable reserved bodies or a new root.
**Architecture:** Root-fixed reference body, preallocated signed actual-owner commitment, one fixed settlement-only recovery control. Generic forward reservations unchanged.
**Tech Stack:** TypeScript/Zod, existing indexed control records/Ed25519/nominal authority, PostgreSQL guard/mirror and generated service-auth client.
**Spec:** docs/superpowers/specs/2026-10-26-admin-fence-settlement-reference-design.md

## Global Constraints

- Wire version2 fixed reference; signed commitment version2≤16384bytes, signed control binding outerversion2/bindingVersion3; no generic late fields.
- Original root/origin/fingerprint/forwarddeadline unchanged; control≤60000ms/request≤15000ms, one exact attempted identity, no renewal/reacquire.
- Existing per-node128KiB/64intents/family128executions256intents/2MiBindex caps; preallocate before effects.
- Applied0042 immutable; legacy settled metadata readable, fresh legacy mutation closed; DM bearer+anchored agent proof required.

## Review Focus

- A forged reference or role must never supply outcome authority.
- Recovery after original expiry permits only exact guard settlement, never forward effects.
- Lost responses/crashes/concurrency preserve one immutable proof/bind/attempt.
- Unknown child/runtime/DB evidence cannot clear physical or logical fences.
- All reserved witness/control bytes/indices/ACKs participate in existing capacity/retirement.

### Task A: Fixed contract and reserved proof producer

**Files:** core services/data-manager/contracts/configuration-maintenance.ts; ops/configuration-maintenance.ts; build-artifacts/configuration-fence-settlement.ts (new focused module), control-authority.ts, child-phase.ts, target-lease.ts/retention integration; agent configuration-maintenance-{store,runtime}.ts. Preserve existing source under sole Task01.2 writer.
**Interfaces:** exact version2 DataConfigurationFenceSettle; publishOwnedConfigurationFenceSettlement(authority,maintenanceId); prepareConfigurationFenceSettlementControl(originalAuthority,maintenanceId); delegateConfigurationFenceSettlementControl(control). Nominal state/construction as spec, no caller proof fields.

- [ ] RED genuine old body/late-outcome contradiction and fixed-ref fingerprint invariance; forged/missing/unknown proof and conflicting producer cases.
- [ ] Implement bounded preallocation/producer/private→shared one-way CAS from actual assigned owner finalizer; no generic mutation of reservations.
- [ ] Implement Revision2 exact OwnerIdentity/PreparedGuard/DecisionEvidence/ChildEvidence/GenerationEvidence/FollowUpEvidence/RuntimeAttestation/FinalEvidence/OwnerFinal schemas and domain digest preimages. Fixed inspector/store transition is sole nominal producer; prepared root/signed summary negatives and restored genuine final positives.
- [ ] GREEN focused core control/phase/target/family tests and agent maintenance-store/runtime tests. Record exact argv/output/causal source.

### Task B: Control adoption, original-deadline exception and compatibility

**Files:** core fixed settlement module, peer-admission/control-authority/target-lease/child-phase as exact closed integration needs; data-configuration-fence.ts; DM execution/configuration-maintenance.ts; canonical contracts and typed client, existing execution/guard tests.

- [ ] RED original-root-expired valid settlement, fresh forward rejection, control-expired/no renewal, lost admission/SQL/mirror response and legacy-read/new-mutation distinction.
- [ ] Implement exact signed receiver-readable envelope/assertion, fresh process-local one-use ticket/outbox, nominal peer/adoption handle (NO physical lease borrower/forward execution), immutable60s control; ordinary gates reject variant. Specialized original-family slots reserve/bind execution/intent digests without late allocation, with both role capacity certificates before prepare readiness.
- [ ] For the known rollback/no-settlement row implement Revision3 ContainedNotSettledObservation only: nonterminal recovery_required, unchanged prepared guard/sequence/time, no ACK/release/retry or fabricated terminal.
- [ ] Implement authenticated PREPARE-time ReservationProjection in the preallocated pending control cell; bind both role capacities/envelope to projectionDigest/reservationDigest, wrong role/family/address/ordinal/body/subset rejected BEFORE any guard/capacity mutation.
- [ ] Implement EVERY Revision2 receiver recovery-table row with atomic SQL ControlTerminalTuple and original DB-session identity. Only conclusive committed publication may repair after expiry; no logical SQL replay, unchanged terminal digest/time. Keep ambiguous/live-session and legacy partial cases fenced.
- [ ] Implement Revision2 inventory/terminal/control-child/ACK/release/SQL-retirement verification and capacity ceilings. All root release/completion/GC use Revision3 disjoint prepared-and-settled OR authenticated never-prepared closure predicate; API delivery remains distinct from physical release and preserves no-deadlock ordering.
- [ ] GREEN actual owned-PG guard tests plus fixed peer/process tests, unchanged generic-forward regressions, capacity/ACK/retention negatives.

### Task C: Assembled proof and canonical checkpoint

**Files:** agent configuration-maintenance.integration.test.ts; API configuration-maintenance-postgres.test.ts; core/DM focused owned process fixtures already assigned01.2; exact new suites registered through existing required DB gating.

- [ ] Implement Revision4 fixed DM refusal projection and minimum preallocated compound proof channel, strict UNUSED intent/CAS/confirmation producer and agent/family verifier, closed NoGuardEvidence preimages and acyclic publication order. NeverIssued has actual frozen publication proof; ReceiverRefused uses only genuine original DM canonical/effect source, no sibling-private reads. No opaque digest/caller absence shortcuts.
- [ ] Implement/test Revision3 NoGuardClosure, NeverIssued versus actual ReceiverRefused sources, issuance freeze race and UNUSED capacity proofs. Known local/DM capacity or busy refusal closes original root with zero settlement POST/UPDATE; ambiguous/actually prepared cases never select this branch. Retain counts until normal retirement, no fake peer/control execution.
- [ ] Exercise Revision4 lost-refusal response/restart and crashes between private canonical→shared refusal→DM intent/CAS/confirmation→agent freeze/own intent/CAS/confirmation→closure. Verify source-only repair, no circular digest, original target release and ordinary all-role family retirement; missing/ambiguous minimum channel or source stays unknown.
- [ ] Apply Revision5 exact two-cell representation: full signed NoGuardBundle in ALREADY reserved16384-byte commitment cell, original signed projection+compact links in8192-byte control cell. Verify both immutable cells/source preimages before closure; committed and unused variants mutually exclusive. No cap increase or late record/index allocation.
- [ ] Build real signed/validated capacity-null AND busy-after-reservation packets; assert complete framing/padding/mandatory-list counts fit all individual+aggregate bounds before effects. Compare static7240/2964 example, test exact overbudget refusal and bundle-before-link crash/tamper/cross-root denial/release+ordinaryretirement. Preserve actual api principal, never broaden principal union.
- [ ] Pin zero late execution/intent/index allocation, one-use dispatch denial on duplicate/restart, all receiver recovery-table states, private/shared/DB repair after expiry, historical duplicate after physical release, capacity boundary and delayed DM/API ACK/GC.
- [ ] Run actual API→agent→DM producer chain for applied/unused/contained, expiry/cancel, crash/lost-response/conflicting-writer/unknown child schedules. External Docker I/O alone may be controlled and named; no fake actual-owner witness.
- [ ] At coherent real registration ask controller standard DM OpenAPI→SDK; inspect generated diff and run freshness. No hand edits or migration.
- [ ] Final affected types, authority/inventory, scoped style, exact final-source covering receipts; append Task01.2 report with amendment dispositions/limits. Normal commit as part of Task01.2; controller fresh product review covers actual implementation.

Self-review performed against all spec sections and five risk classes. NEW independent design readiness review required before product edits; user already authorized autonomous execution/no questions.

Revision2 self-review: each R1 I1–I4 has strict type/producer/gate/recovery/capacity/ACK contract above and a task acceptance step; generic forward helpers remain unchanged, logical control has no physical borrower, original records/digests preserved. Independent R2 must verify these corrections before product authorization.

Revision3 self-review: R2-I3 chooses no new failure-terminal variant; R2-I4 has complete authenticated reservation preimage BEFORE receiver capacity; R2-N1 provides disjoint truthful root closure. I1/I2 prior contracts remain, no new product authority granted until independent R3 readiness.

Revision4 self-review: remaining R2-N1 now has exact public proof/UNUSED tuple, fixed local producers and agent/family consumers, preallocated channel/budgets and acyclic crash recovery. I1/I2/I3/I4 remain cleared except correction interactions. Independent scoped R4 readiness required.

Revision5 self-review: R4size blocker fixed by using already reserved16KiB+8KiB cells with exact linked preimages; purestaticcompletepacket7240/2964bytes, no cryptographic/runtimeclaim. Independent R5 readiness before product authorization.
