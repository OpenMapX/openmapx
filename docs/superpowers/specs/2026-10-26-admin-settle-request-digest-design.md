# Outer maintenance settle request digest derivation

Status: APPROVED after independent R1 READY (0 Critical / 0 Important), design readiness only. Implement inside existing [Task01.2](../plans/2026-10-23-admin-01-service-control.md). This clarifies its outer request only; actual source/runtime tests and independent product review remain required. No new task, endpoint, wire field, participant, authority role, root, migration or raised bound.

## Decision and two distinct digests

The mandatory `ConfigurationMaintenanceSettle.evidenceDigest` is an **API observation checksum**, named requestEvidenceDigest in implementation-local variables. It is NOT R5's agent-owned `FinalEvidence.evidenceDigest`. Their preimages and domains are distinct and neither may substitute for the other. Final-v2 still includes the actual inspector-generated RuntimeAttestation verificationId/checkedAt and all actual commit/child/runtime evidence; only that actual agent source constructs it, signs OwnerFinal and publishes the root-fixed DM settlement commitment. The API neither invents nor receives private runtime attestations.

Keep the outer schema unchanged. Supply one portable pure helper from `packages/core/src/ops/configuration-maintenance.ts`, re-exported by ops index: `configurationMaintenanceSettleRequestDigest(receipt: ConfigurationMaintenanceReceipt): string`. Parse the existing strict bounded receipt schema first, construct EXACT projection below, then return lowercase hex SHA-256 of UTF-8 `"openmapx-configuration-settle-request-evidence-v1\0" + canonicalJson(projection)`. canonicalJson is the existing ops canonicalizer. Do not hash the whole receipt, secret state, caller request body or raw JSON property order. This helper calculates a checksum; it returns no nominal verification/authority handle.

Projection, using the parsed existing receipt `r`:

```ts
{
  version: 1,
  binding: r.binding,
  prepare: r.prepare,
  apiJobId: r.apiJobId,
  parentOperationKey: r.parentOperationKey,
  parentFingerprint: r.parentFingerprint,
  parentDeadlineAt: r.parentDeadlineAt,
  planDigest: r.planDigest,
  serviceIds: r.serviceIds,
  steps: r.steps.map(s => ({
    phase: s.phase, ordinal: s.ordinal,
    operationKey: s.operationKey, operationFingerprint: s.operationFingerprint,
    serviceIds: s.serviceIds, prerequisites: s.prerequisites
  })),
  sequence: r.sequence,
  decision: r.decision,
  dmFence: r.dmFence,
  generation: r.generation,
  appliedRevisionId: r.appliedRevisionId,
  followUp: r.followUp
}
```

`binding`, `prepare`, `decision` and `dmFence` are their EXACT already-defined portable nested objects, including existing nulls; no inferred fields/defaults or secret/config values. Preserve schema-canonical array order; no resorting changes. Operation bodies are excluded; their original frozen fingerprints/planDigest bind them. Only `preflight` (fresh inspect observation) and `state` (derived phase label) are omitted from the receipt fields; neither is settlement authority and neither omission permits actual outcomes to be skipped. Existing64KiB receipt/128KiB owner/32steps bounds remain; checksum projection creates no journal capacity allocation or public digest of secret values.

Alternative expose an immutable final digest via a new inspection/receipt field requires an unnecessary wire/producer lifecycle extension. Alternative use a random/caller digest or silently ignore the field defeats a mandatory condition. The selected checksum is fully derivable from existing authenticated observation and is checked by the receiver, while final evidence remains private and actual.

## API producer, actual agent comparison and replay

API obtains the actual existing `configurationMaintenance.inspect` receipt via the authenticated typed client. Verify its binding/prepare/parent/candidate/plan/decision against the retained original job/candidate/decision as already required. Select the receipt at the intended final verification request, after observing original frozen child attempts; no public/caller receipt is authority. Build the unchanged outer body with its exact identity, `decisionId:r.decision.decisionId`, `expectedSequence:r.sequence`, and the helper digest. Missing decision cannot be filled with a fabricated UUID. Persist the WHOLE exact body/key/fingerprint/admission attempt under existing job CAS before its one POST/HMAC. Keep the observed checksum projection or its digest in the existing bounded private control checkpoint as needed for exact recovery; never store private runtime details.

On FIRST outer settle control admission, the agent restores the original retained owner and original API parent from its actual fixed stores. Under that owner's existing metadata writer/CAS, BEFORE mutating its settle-control slot, sequence, receipt phase or final inspection, require exact request identity/decision, `expectedSequence === owner.receipt.sequence`, and constant-time equality of request.evidenceDigest with `configurationMaintenanceSettleRequestDigest(owner.receipt)`. This is a read-condition comparison on actual retained state, never verification of a caller-supplied receipt. A mismatch/stale sequence is existing conflict and performs zero final/control/DM publication, guard update or target effect. Existing unknown/fenced owner/parent conditions remain closed.

Persist the accepted exact outer operation fingerprint/body AND the original checked sequence/request checksum in the already allocated private settle-control slot atomically with its first admitted intent. No later inspection time, changing current pointer, preflight refresh or final-v2 value replaces this accepted request observation. If helper publication, sequence advancement or control state races that first CAS, exactly one owner version wins; the loser performs no mutation/admission. No automatic changed-body retry or rekeying is introduced. Existing explicit reconciliation for a conclusively refused request remains governed by original control/reservation constraints; it cannot acquire a new root or renew a deadline.

After accepted request retention, perform the existing ACTUAL frozen child/commit/containment/runtime inspection and final-v2 producer. A matching checksum—even for a prepared/unresolved receipt—does NOT establish final eligibility, no effects, success or containment. All existing R5 decision, original root/guard, final evidence, immutable terminal tuple, SQL/mirror, shared proof/ACK and disjoint closure gates remain mandatory. The final owner/cell's evidenceDigest is computed from FinalEvidence under `openmapx-configuration-final-evidence-v2`, never copied from this outer field. The DM reference body remains root-fixed v2; it does not gain/request/use the API checksum.

A duplicate operation/key/changed body follows existing immutable operation conflict. A duplicate/restart of the ACCEPTED same body observes the retained original checked request/slot and repairs only allowed already-committed publication; do NOT compare its old expectedSequence/checksum against a later owner receipt and reject the original winner, do not reinspect to manufacture a new runtime verificationId/time and do not replay DM mutation. Any continuation after an accepted request uses only original retained control/recovery capabilities and lifetimes. Changed owner sequence is not permission to issue a fresh outer intent, overwrite the accepted slot, reseal a candidate or forge final evidence. Missing/uncertain accepted checkpoint stays unknown; no structural boolean bypass.

## Required causal acceptance in Task01.2

1. Exact portable helper vectors: API-observed receipt and actual retained owner derive identical checksum; reordered JSON object keys do not change it. Mutate each included identity/plan/step/sequence/decision/guard/generation/followUp field: checksum changes. Change preflight/state alone: checksum unchanged. Malformed/oversize receipt rejects; no operation body/secret values enter the preimage.
2. Actual API -> production agent with owned PostgreSQL and real final inspector: legal observed request passes initial compare; bad checksum, foreign candidate/decision and stale sequence reject BEFORE settle-control CAS/effects. A correct checksum on prepared/live/unknown child evidence still refuses final settlement and retains original guard/root. A caller-supplied final-v2 digest cannot stand in for the request checksum.
3. Competing first settle requests/read-owner sequence advance under the actual owner writer: one exact original intent wins, no partial slot/changed-body acceptance. API checkpoints before POST; loss/restart with later owner phase/sequence observes exact accepted body/checksum and original final evidence, no second DM mutation/runtime attestation or new root/time.
4. Existing final-v2 positive/failed containment and SQL/mirror/ACK/crash/expiry proofs remain mandatory. Demonstrate non-equal request and final digests computed by their actual distinct producers; root-fixed DM control verifies only actual agent final commitment. No generator needed for this pure helper unless actual existing route/schema definitions otherwise change at a separately coherent checkpoint.

Extend `packages/core/src/ops/configuration-maintenance.test.ts` and existing actual01.2 owner/control/API/PG fixtures; use current package scripts and named external-I/O substitutions only. Full task independent product review remains required. No changes to generic late-child binding, current applied0042 or unknown-result guarantees.

## Self-review

All preimage fields already exist in closed portable receipt; private runtime observations remain unexposed. Expected sequence/read checksum is enforced before first control mutation; duplicate winner/restart is explicitly separate from first admission. A valid checksum is never a producer proof, and final-v2/DM control/NoGuard authority is unchanged. Cost if wrong: confined comparison/projection/API checkpoint tests, no authority expansion or unbounded new storage.
