# Late child binding under an immutable control root

Status: approved after independent scoped R2 review (R1-I1–I4 addressed;0 open). This is a narrow Task02.3 correction, not a new task or a replacement for the accepted retention amendment.

## Problem and decision

The accepted root receipt fixes complete future child `ExecutionRef`s. A transit root can spend hours downloading/building before a child with a120s kind budget is ready. A root-time deadline either expires before that phase or is changed by the recipient's actual-admission clamp. The exact grant identity check correctly rejects that change. Root admission, target ownership and immutable root time cannot be postponed.

Controller decision: retain the immutable root and reserve a finite child slot at root admission; bind that slot exactly once when its phase is ready. Do not extend the child's policy budget, invent a new root, rewrite the admitted root plan or relax recipient equality checks. The alternative of an early deadline makes normal long transit work impossible; using a root-sized child budget bypasses existing policy. Root-time slots with late exact binding preserve both.

## Immutable reservation and interfaces

Keep existing exact `ControlPlannedChild` plans readable and usable. Add optional `reservations: readonly ControlChildReservation[]` to the signed admitted receipt, with an empty default for old records. It is immutable on duplicate admission. Existing exact entries and reservations share one canonical ordinal space and the existing combined64-entry cap; no phase can be appended later.

```ts
type ControlChildReservation = {
  version: 1;
  phase: ControlChildPhase;
  ordinal: number;
  kind: string;
  recipient: ControlRecipient;
  serviceIds: readonly string[];
  execution: Pick<ExecutionRef,
    "executor" | "principal" | "executionId" | "operationKey">;
  operationFingerprint: string;
};
bindControlChildPhase(authority: VerifiedExecutionAuthority, input: {
  phase: ControlChildPhase;
  ordinal: number;
}): Promise<ControlPlannedChild>;
lookupControlChildPhase(authority: VerifiedExecutionAuthority, input: {
  phase: ControlChildPhase;
  ordinal: number;
}): ControlPlannedChild | null;
```

The reservation fixes the existing derived phase key, receiver-valid proposed execution ID, executor/principal, finite graph edge, kind, recipient, exact sorted target subset AND exact whole typed-operation fingerprint. There is no null/wildcard body or late operation field. The binder accepts only phase/ordinal and reads every identity field from the signed reservation. Root input/receipt owns all body values; changing any field conflicts before binding, grant or POST.

### Root-fixed bodies and owned candidate identifiers (R1-I1)

Use fixed DM adapter `reserveTransitChildOperations` in `services/data-manager/src/jobs/execution/ops-children.ts` at admission, before any build/proxy write. It allocates the safe typed operations and candidate identities into the original durable job metadata/child reservations; fingerprints use the existing canonical operation helper. For promotion, `preparedRunId` is the original DM execution UUID (the prepared-run writer must use that ID). For each proxy stage/commit/restore, `candidateId = "ctrl-" + SHA256("openmapx-transit-candidate-v1\0" + root.operationKey + "\0" + phase + "\0" + canonicalOrdinal).hex.slice(0,32)`. Replace mtime-derived candidate IDs on these owned paths. Candidate bytes/checksums can be produced later; their identity cannot.

`assertOwnedTransitChildCandidate` is the fixed local adapter before binding/dispatch. It reads the SAME retained job's phase checkpoint and its existing confined candidate/run marker, requiring parent execution identity, phase, reserved ID and current recorded byte digest to agree. It cannot accept a caller boolean, another root's candidate, or a freshly reconstructed candidate after an attempted child. The prepared/proxy writers retain this original parent/phase/ID provenance in their existing private/job state before exposing candidate data. Grant policy/resource checks remain independent. No general callback or authority constructor is exposed to HTTP.

For paired pin approval, ALL six fields `{kind,proposalId,validationId,expectedGenerationId,diffDigest,acknowledgeLicenseChanges}` are fixed by the original `catalog.activate` input. The accepted05.3 activation API already requires validationId before activation admission. The fixed adapter rechecks that exact retained proposal/validation/current-generation policy; it does not accept validation produced by another activation in place of the selected evidence. Only DM `catalog.activate` may reserve `paired-pin-commit`; neither transit-sync nor transit-maintenance gains that edge.02.3 retains this leaf closed;05.3 supplies the specified real verification. No future runtime fallback permits null bodies.

Other exact ops and deadline-only data inputs likewise persist their entire safe typed body in their owning store before first binding. Reserve a fixed child's own reservations through its existing private spawn intent and signed admission, not only the immediate CLI child. Validate all reservations against the SAME existing finite parent-kind/phase/recipient/depth policy. They grant no new edge or widened target subset. Existing exact plans without the reservations member keep their raw bytes/signature/digest; normalize absent to empty only in comparison views so exact old duplicate admission/restoration does not conflict merely because the new parser knows that member.

## One binding, original budget

Lookup resolves an existing binding BEFORE reading time. An identical bind returns its original exact child; a changed body is rejected by the signed reservation/owned checkpoint before binding. Read-only lookup remains possible after cancellation/expiry; it grants no forward authority. A missing/corrupt expected binding is recovery-required, never an unbound slot.

For an actually unbound reserved slot, under the original execution's non-stealable private writer, verify its signed root receipt, current complete forward ancestry, origin clock and unexpired root. Capture `boundAt = Date.now()`. Choose `requestedDeadlineAt = min(root.deadlineAt, boundAt + opsExecutionBudget(kind).processMs)`; use the existing verified parent identity and normalization to compute the exact execution fingerprint. The recipient STILL recomputes its own kind/deployment clamp at actual admission; any stricter policy/clock mismatch refuses before adoption. It does not mutate the grant or authorize a replacement attempt. No transport delay can extend the stored child deadline; if elapsed, no fresh child effect is permitted.

Persist an issuer-signed binding with payload version2/domain `openmapx-control-phase-binding-v2`, installation/origin, original parent execution and signed admission digest, reservation digest, complete `ControlPlannedChild`, boundAt and requestedDeadlineAt. Its identity/time are write-once. Reservation schema version1 and origin metadata version1 remain distinct from this version2 signed origin-bearing envelope; validateOriginRecord is unchanged and rejects origin-bearing version1 bindings. Root execution/deadline/fingerprint and signed admission bytes are unchanged. No new signing key, issuer endpoint, browser parameter or generic callback is added.

Preallocate one issuer-signed version2 `unbound` binding cell for each reservation at admission, using the existing role-private `observations` namespace and family index. Derive the basename solely from parent key and canonical ordinal. Each cell is at most8KiB; combined per-node binding payload at most128KiB. Account the actual worst-case signed size determined by fixed identities/target lengths, including the bounded publication reference below, rather than promising64 maximum-size cells fit128KiB. Reserve its accounting/index space before root forward readiness/effects; refuse an oversized prospective plan then. Keep existing64KiB admission receipt,128KiB lease ledger,64 node intents,128 family executions/256 intents and2MiB family index/GC limits. Binding/grant duplication still must fit those bounds; never silently raise them. Reclamation uses the existing exact indexed namespace transaction, not an additional collector or lifetime scan.

## Recoverable binding and child checkpoints (R1-I2)

The safe typed body is durably stored BEFORE binding. Replace the current all-fields-required child JSON with a strict staged union (no dummy grant UUID/digest):

| State                          | Required immutable fields                                                                                                      | Mutation/dispatch permission                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| reserved                       | original parent, phase/ordinal, full safe typed operation + fingerprint, reserved key/proposed ID/targets, cancellation intent | confirmed current owner CAS only; no child identity/grant yet                                                       |
| bound                          | reserved fields + exact ExecutionRef, requested deadline, binding digest                                                       | only the live confirmed reserved-CAS caller may proceed; duplicate/restart is observation                           |
| attempted                      | bound fields + actual delegation UUID/grant digest; dispatchState `pending` or `claimed`                                       | grant is already conservatively attempted; only fresh live issuance ticket + confirmed claimed-CAS permits ONE POST |
| observing / terminal / unknown | preceding immutable fields + existing accepted/terminal/containment data                                                       | lookup/cancel/settle only; never the original effect POST                                                           |

The existing32-child/8KiB-each/128KiB-total JSON limits and0042 columns remain. Store CAS validates permitted one-way transitions and current owner version, status/cancel/parent identity. Only explicit current `reserved` creation returns a local forward continuation; same-slot losers receive observation. No caller can claim a winner's continuation from parsed JSON.

Ordering: (1) current owned-row CAS stores reserved body and returns local continuation; (2) binder signs its original exact identity; (3) confirmed owned CAS attaches binding to bound row; (4) scope-held issuer below chooses and persists real grant identity/reference then its existing outbox/attempt publications; (5) confirmed owned CAS attaches exact grant and claims dispatch, before first POST. The fresh grant return includes module-private nominal one-use `FreshControlChildDispatch`; lookup cannot mint it. The fixed DM adapter consumes it only after the confirmed claimed-CAS. A stale/failed/ambiguous CAS or same-slot loser authorizes zero POST. Do not hold DB locks across filesystem guards or HTTP.

The binding cell has an immutable signed binding section plus a monotonic signed publication section: `unissued` or `grant_prepared` with `{delegationId,grantDigest,leaseId:null|UUID}`. Reserve its maximum size initially. Under issuance guards, write this exact reference BEFORE private/shared grant publication. Grant body/assertion remain only in the existing bounded private outbox/parent-attempt records, not duplicated into the cell. That fixed parent-key/ordinal address restores the original grant even if DB grant fields were never attached. Once grant_prepared exists, no new UUID/grant can be issued from that slot; partial/missing outbox evidence is recovery-required.

Crash recovery verifies the original reserved body in DB, signed reservation/binding/publication reference and exact outbox/shared grant; a mismatch or missing expected cell stays fenced. It may copy the same binding/grant into the DB under current CAS and observe it, but cannot obtain a FreshControlChildDispatch or resend an attempted effect. A crash after reserved body but before binding may report interrupted/no-child according to actual containment; startup does not run an old build/phase. A still-live original caller may use a conclusively unbound slot after its own confirmed reservation CAS, within the unchanged root. Binding and all later stored deadlines are never recomputed on recovery.

The live adapter uses this additional server-only fixed surface, whose nominal ticket stays process-local:

```ts
type FreshControlChildDispatch = Readonly<{ /* private nominal brand */ }>;
issueControlChildPhase(authority: VerifiedExecutionAuthority, input: {
  phase: ControlChildPhase;
  ordinal: number;
  childPublicKey: string;
  lease?: TargetLeaseAuthority;
}): Promise<{
  channel: "delegation" | "parent";
  assertion: string;
  dispatchTicket: FreshControlChildDispatch;
}>;
consumeControlChildDispatch(ticket: FreshControlChildDispatch): void;
```

Issuance requires an already-bound reserved slot, verifies lease execution/subset or the fixed deadline-only edge, and returns only after all attempt publication. Duplicate/partial issuance is observation-required, never another ticket. `consume` irreversibly retires its WeakMap-backed ticket before POST; parsed/stored/foreign/reused tickets fail. Existing exact-plan public grant signatures remain compatible and internally share the guarded issuer; they do not gain a new retry path. The new DM adapter uses the ticket-bearing surface, not the older string-only helper as a dispatch permission.

## Scope-held grant publication and cancellation (R1-I3)

Lease-backed and deadline-only issuers resolve an exact child from either the original exact plan or authenticated bound reservation. Fixed spawn validation uses that resolver. A plain returned child object is not authority. Add fixed module-internal `publishReservedLeaseGrant` in `target-lease.ts` (not an exported callback API); route ALL existing exact and reserved lease issuance through that same critical section.

It acquires the lease journal guard, then deadline ancestry execution guards root-first, then the local execution writer (deduplicate any identical ancestor/local execution guard); holds all required guards through signed binding/ancestry validation, publication-reference/outbox reservation, cancellation-visible child-intent publication, shared grant write and parent lease-node update. Recheck all local/ancestor/lease phases and deadlines INSIDE that scope. Preserve the existing phase-restricted prepared/settled continuation exceptions; the guard-lifetime correction must not replace them with an unconditional held-only policy. The current assertControlDelegationForward precheck is insufficient and is not the authority for publication. A paused precheck followed by durable cancel must fail inside the actual issuance scope.

Register each lease grant in the execution lifecycle's cancellation-visible child-intent index before shared exposure. Add a finite signed lease-attempt variant referencing exact original execution, lease/delegation IDs, child, outbox/grant digest and origin; the existing deadline-only parent-attempt variant remains separately verified by its proper domain. Execution cancellation enumerates the union of these exact private attempt records; lease cancellation enumerates its shared grant outbox. Startup reconciles the UNION, including prepared/private-only and shared-before-parent-node publication. No arbitrary grant plugin or sibling-private read is introduced. If publication crashes at any point after its reference is retained, no fresh ticket is returned and the original attempt remains fenced/lookup-only; physical absence or writer death alone is not no-effect proof.

Both cancellation paths persist their respective intent and return exact descendants. Cancellation adapters acquire/release execution guards before acquiring a lease guard: NEVER wait for lease/DB while holding an execution writer. Binder takes only its execution/ancestry guards and waits for no lease/DB. Deadline-only issuance preserves its existing scope-held ancestor/local guard protection and uses the same reserved-slot publication reference/one-use rule. If grant issuance wins, durable cancellation finds its exact child even when DB linkage/response is lost; if cancel wins, no new grant/assertion/ticket becomes issuable. Unknown publication/writer containment retains fences; no TTL/PID stealing.

Grant/execution signature wire shapes and receiver equality/adoption checks remain exact. Existing old admissions with no reservations cannot acquire one. Signed legacy records retain their existing observation/settlement restrictions. Parent/root restart never recomputes a slot's deadline. Family membership/enlistment and original expiry-floor retirement remain unchanged.

## Required proof and scope

Task02.3 owns the correction and its actual transit/deadline-only consumers in the existing exclusive window. Migration0042 is already applied to the owned synthetic database; this correction uses its bounded child JSON plus private protocol cells and MUST NOT edit that migration or allocate a new schema migration.

Tests must causally reproduce late120s delegation failure, then prove successful actual child admission after hours of simulated root work under the original root and target inode. Real separate processes/loopback validate exact identity, unchanged root bytes and one effect. Include same-slot concurrent binding, altered root-fixed body/phase/ordinal/target/recipient (including every paired approval field), delayed/stricter-policy rejection, bind-versus-cancel, crash between binding/DB/grant/admission checkpoints, lost response lookup-only, duplicate after expiry without renewal, missing/corrupt binding, borrowed depth/subset and deadline-only Full Update. Use finite fake-clock advances, not multi-hour waits. Prove retention/index/capacity and no extra generation/key authority.

Self-review: this addresses late normalization only, preserves exact admission and all accepted authority/retention boundaries, and assigns every new interface to02.3. R1-I1 is addressed by removing late body fields and preallocating owned candidate IDs; I2 by body-first staged CAS/reference/ticket states; I3 by a named scope-held issuer and union cancellation outboxes; I4 by the version2 binding domain. Independent R2 review checked these contracts and found0 open design issues; code and runtime proofs remain required in Task02.3. Review report: .superpowers/sdd/2026-10-23-admin-instance-management/late-child-amendment-review-r2.md (local evidence, not production acceptance).
