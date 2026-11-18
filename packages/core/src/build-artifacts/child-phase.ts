import {
  type ControlChildPhase,
  type ControlChildReservation,
  type ControlRecipient,
  childPhaseKinds,
  controlChildOperationKey,
} from "./control-child-records";

export {
  type ControlChildReservation,
  controlChildReservationSchema,
} from "./control-child-records";

/** Server-only fixed phase identities. An observation never mints a dispatch ticket. */
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import {
  type ExecutionRef,
  executionFingerprint,
  executionRefSchema,
  normalizeExecutionAdmission,
  opsExecutionBudget,
} from "../ops/execution-identity";
// biome-ignore-end lint/suspicious/noImportCycles: Live protocol dependency described above.
import { dataControlDelegationSchema } from "../services/data-manager/contracts/executions";
// biome-ignore-start lint/suspicious/noImportCycles: Exact and reserved children share the same live guards; phase schemas are lazy and these cross-module calls run after initialization.
import {
  assertControlDelegationForward,
  assertControlPublicationScope,
  attestParentExecution,
  type ControlDelegation,
  type ControlPlannedChild,
  executionAuthorityState,
  readPrivateRecord,
  retainedControlParent,
  type VerifiedExecutionAuthority,
  verifiedRetainedControlParent,
  verifyDeadlineEdge,
  withControlDelegationPublication,
  writePrivateRecord,
} from "./control-authority";
import { controlDigest, controlOriginSchema, digest } from "./control-records";
// biome-ignore-start lint/suspicious/noImportCycles: Exact and reserved children share the same live guards; phase schemas are lazy and these cross-module calls run after initialization.
import {
  delegateArtifactTargetLease,
  type TargetLeaseAuthority,
  verifyFiniteControlEdge,
} from "./target-lease";
// biome-ignore-end lint/suspicious/noImportCycles: Live protocol dependency described above.

export function validateControlChildReservations(input: {
  role: ControlRecipient | "host-cli";
  kind: string;
  execution: ExecutionRef;
  serviceIds: readonly string[];
  plan: readonly ControlPlannedChild[];
  reservations: readonly ControlChildReservation[];
}): void {
  const slots = [...input.plan, ...input.reservations].sort((a, b) => a.ordinal - b.ordinal);
  if (
    slots.length > 64 ||
    new Set(slots.map((slot) => slot.execution.operationKey)).size !== slots.length
  )
    throw Error("Control child reservation capacity or duplicate key");
  for (const [ordinal, slot] of slots.entries()) {
    if (
      slot.ordinal !== ordinal ||
      slot.execution.operationKey !==
        controlChildOperationKey(input.execution.operationKey, slot.phase, ordinal) ||
      !childPhaseKinds[slot.phase]?.includes(slot.kind) ||
      slot.serviceIds.some((id) => !input.serviceIds.includes(id))
    )
      throw Error("Invalid immutable child reservation");
    if (
      (slot.recipient === "fixed-cli" && slot.phase === "data-workflow") ||
      (slot.recipient === "data-manager" &&
        ["osm", "transit", "fonts", "data-step"].includes(slot.phase))
    )
      verifyDeadlineEdge(input.kind, slot.phase, slot.recipient, slot.kind);
    else verifyFiniteControlEdge(input.role, input.kind, slot.phase, slot.recipient);
    const executor =
      slot.recipient === "ops-agent"
        ? "ops-agent"
        : slot.recipient === "data-manager"
          ? "data-manager"
          : "host-cli";
    if (slot.execution.executor !== executor)
      throw Error("Reserved receiver execution address mismatch");
  }
}
const planSchema = z.lazy(() =>
  z.strictObject({
    phase: z.enum(Object.keys(childPhaseKinds) as [ControlChildPhase, ...ControlChildPhase[]]),
    ordinal: z.number().int().min(0).max(63),
    kind: z.string(),
    recipient: z.enum(["fixed-cli", "data-manager", "ops-agent", "configuration-helper"]),
    serviceIds: z.array(z.string()).max(256),
    execution: executionRefSchema,
  }),
);
const publicationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unissued") }),
  z.strictObject({
    state: z.literal("grant_prepared"),
    delegation: dataControlDelegationSchema,
  }),
]);
const cellSchema = z.strictObject({
  version: z.literal(2),
  origin: controlOriginSchema,
  parent: executionRefSchema,
  admissionDigest: digest,
  reservationDigest: digest,
  binding: z
    .strictObject({
      child: planSchema,
      boundAt: z.number().int().nonnegative().safe(),
      requestedDeadlineAt: z.number().int().nonnegative().safe(),
    })
    .nullable(),
  publication: publicationSchema,
});
type Cell = z.infer<typeof cellSchema>;
const cellName = (authority: VerifiedExecutionAuthority, ordinal: number) =>
  `phase-${authority.execution.operationKey}-${ordinal}.json`;
function reservation(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
) {
  const state = executionAuthorityState(authority);
  const value = state.reservations.find(
    (r) => r.phase === input.phase && r.ordinal === input.ordinal,
  );
  if (!value) throw Error("Phase is absent from immutable reservations");
  return { state, value };
}
function readCell(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
): Cell {
  const { state, value } = reservation(authority, input);
  const raw = readPrivateRecord(
    state.installation,
    "observations",
    cellName(authority, input.ordinal),
    8192,
  );
  const cell = cellSchema.parse(raw);
  if (
    controlDigest(cell.origin) !== controlDigest(state.origin) ||
    controlDigest(cell.parent) !== controlDigest(state.execution) ||
    cell.admissionDigest !== state.receiptDigest ||
    cell.reservationDigest !== controlDigest(value)
  )
    throw Error("Reserved phase binding identity changed");
  if (cell.binding) {
    const { child, boundAt, requestedDeadlineAt } = cell.binding;
    const expected = {
      phase: value.phase,
      ordinal: value.ordinal,
      kind: value.kind,
      recipient: value.recipient,
      serviceIds: value.serviceIds,
      execution: {
        ...value.execution,
        operationFingerprint: value.operationFingerprint,
        deadlineAt: requestedDeadlineAt,
        fingerprint: executionFingerprint({
          kind: value.kind,
          operationFingerprint: value.operationFingerprint,
          deadlineAt: requestedDeadlineAt,
          parent: retainedControlParent(state.execution),
        }),
      },
    };
    if (
      requestedDeadlineAt <= boundAt ||
      requestedDeadlineAt > state.execution.deadlineAt ||
      controlDigest(child) !== controlDigest(expected)
    )
      throw Error("Reserved phase exact identity mismatch");
  } else if (cell.publication.state !== "unissued")
    throw Error("An unbound phase cannot have a grant");
  return cell;
}
function writeCell(
  authority: VerifiedExecutionAuthority,
  ordinal: number,
  cell: Cell,
  exclusive = false,
) {
  const state = executionAuthorityState(authority);
  const record = cellSchema.parse(cell);
  if (Buffer.byteLength(canonicalJson(record)) > 8192)
    throw Error("Phase binding capacity exceeded");
  writePrivateRecord(
    state.installation,
    "observations",
    cellName(authority, ordinal),
    record,
    exclusive,
  );
}
/** Called by durable admission before any forward witness/effect becomes ready. */
export function initializeControlChildReservations(authority: VerifiedExecutionAuthority): void {
  const state = executionAuthorityState(authority);
  const cells = state.reservations.map((r) => ({
    r,
    cell: cellSchema.parse({
      version: 2,
      origin: state.origin,
      parent: state.execution,
      admissionDigest: state.receiptDigest,
      reservationDigest: controlDigest(r),
      binding: null,
      publication: { state: "unissued" },
    }),
  }));
  // Bound exact identities, decimal epoch lengths and UUID/digest publication
  // fields have fixed maxima. Budget their complete records up front.
  const maximum = cells.reduce((total, { r, cell }) => {
    const largestExecution = {
      executor: "ops-agent",
      principal: "data-manager",
      executionId: "f".repeat(68),
      operationKey: "f".repeat(69),
      operationFingerprint: "f".repeat(64),
      fingerprint: "f".repeat(64),
      deadlineAt: Number.MAX_SAFE_INTEGER,
    };
    const largest = {
      ...cell,
      binding: {
        boundAt: Number.MAX_SAFE_INTEGER,
        requestedDeadlineAt: Number.MAX_SAFE_INTEGER,
        child: {
          phase: r.phase,
          ordinal: r.ordinal,
          kind: r.kind,
          recipient: r.recipient,
          serviceIds: r.serviceIds,
          execution: {
            ...r.execution,
            operationFingerprint: r.operationFingerprint,
            deadlineAt: Number.MAX_SAFE_INTEGER,
            fingerprint: "f".repeat(64),
          },
        },
      },
      publication: {
        state: "grant_prepared",
        delegation: {
          leaseId: "f".repeat(36),
          childKey: "f".repeat(36),
          owner: largestExecution,
          parent: largestExecution,
          execution: largestExecution,
          kind: r.kind,
          phase: r.phase,
          targets: r.serviceIds,
          origin: state.origin,
        },
      },
    };
    const size = Buffer.byteLength(canonicalJson(largest));
    if (size > 8192) throw Error("Phase binding cell capacity exceeded");
    return total + size;
  }, 0);
  if (maximum > 128 * 1024) throw Error("Phase binding aggregate capacity exceeded");
  for (const { r, cell } of cells) writeCell(authority, r.ordinal, cell, true);
}
export function lookupControlChildPhase(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
): ControlPlannedChild | null {
  return readCell(authority, input).binding?.child ?? null;
}
export async function bindControlChildPhase(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
): Promise<ControlPlannedChild> {
  const retained = readCell(authority, input);
  if (retained.binding) return retained.binding.child;
  return withControlDelegationPublication(authority, input.phase, () => {
    const current = readCell(authority, input);
    if (current.binding) return current.binding.child;
    const { state, value } = reservation(authority, input),
      boundAt = Date.now();
    const requestedDeadlineAt = Math.min(
      state.execution.deadlineAt,
      boundAt + opsExecutionBudget(value.kind).processMs,
    );
    const normalized = normalizeExecutionAdmission({
      kind: value.kind,
      operationKey: value.execution.operationKey,
      operationFingerprint: value.operationFingerprint,
      admittedAt: boundAt,
      requestedDeadlineAt,
      parent: verifiedRetainedControlParent(state.installation.installation, state.execution),
    });
    const child = {
      phase: value.phase,
      ordinal: value.ordinal,
      kind: value.kind,
      recipient: value.recipient,
      serviceIds: [...value.serviceIds],
      execution: {
        ...value.execution,
        operationFingerprint: value.operationFingerprint,
        deadlineAt: normalized.deadlineAt,
        fingerprint: normalized.fingerprint,
      },
    };
    writeCell(authority, value.ordinal, {
      ...current,
      binding: { child, boundAt, requestedDeadlineAt },
    });
    return child;
  });
}
/** Internal fixed issuer hook, invoked while the actual publication guards are held. */
export function prepareControlChildPublication(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
  delegation: ControlDelegation,
): void {
  assertControlPublicationScope(authority);
  const state = executionAuthorityState(authority);
  if (!state.reservations.some((r) => r.phase === input.phase && r.ordinal === input.ordinal))
    return;
  const cell = readCell(authority, input);
  if (!cell.binding || cell.publication.state !== "unissued")
    throw Error("Reserved phase publication requires observation");
  writeCell(authority, input.ordinal, {
    ...cell,
    publication: { state: "grant_prepared", delegation },
  });
}
export function inspectControlChildPublication(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
) {
  const cell = readCell(authority, input);
  return {
    binding: cell.binding,
    publication: cell.publication,
    bindingDigest: controlDigest(cell.binding),
  };
}
export function lookupControlChildPhaseBinding(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
) {
  const cell = readCell(authority, input);
  return cell.binding
    ? Object.freeze({ ...cell.binding, bindingDigest: controlDigest(cell.binding) })
    : null;
}
/** The child an attempted phase issued, for observation and cancellation only.
 * This returns no ticket and never repairs or reissues a missing attempt. */
export function lookupControlChildPhaseAttempt(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
) {
  const cell = readCell(authority, input),
    s = executionAuthorityState(authority);
  if (cell.publication.state === "unissued") return null;
  if (!cell.binding) throw Error("Attempted phase has no exact binding");
  const delegation = cell.publication.delegation;
  if (
    delegation.kind !== cell.binding.child.kind ||
    controlDigest(delegation.execution) !== controlDigest(cell.binding.child.execution) ||
    controlDigest(delegation.parent) !== controlDigest(s.execution)
  )
    throw Error("Original phase child identity changed");
  return Object.freeze({
    channel: delegation.leaseId === null ? ("parent" as const) : ("delegation" as const),
    delegation,
    leaseId: delegation.leaseId,
    childKey: delegation.childKey,
    execution: cell.binding.child.execution,
    bindingDigest: controlDigest(cell.binding),
  });
}
export function resolveControlChildPlan(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; execution: ExecutionRef; recipient: ControlRecipient },
): ControlPlannedChild | undefined {
  const state = executionAuthorityState(authority);
  const exact = state.plan.find(
    (p) =>
      p.phase === input.phase &&
      p.recipient === input.recipient &&
      controlDigest(p.execution) === controlDigest(input.execution),
  );
  if (exact) return exact;
  const slot = state.reservations.find(
    (r) => r.phase === input.phase && r.execution.operationKey === input.execution.operationKey,
  );
  if (!slot) return undefined;
  const bound = lookupControlChildPhase(authority, slot);
  if (
    bound &&
    bound.recipient === input.recipient &&
    controlDigest(bound.execution) === controlDigest(input.execution)
  )
    return bound;
  return undefined;
}
const dispatchBrand = Symbol("fresh-control-child-dispatch");
export type FreshControlChildDispatch = Readonly<{ [dispatchBrand]: true }>;
const tickets = new WeakMap<
  FreshControlChildDispatch,
  {
    used: boolean;
    authority: VerifiedExecutionAuthority;
    phase: ControlChildPhase;
    deadlineAt: number;
  }
>();
export async function issueControlChildPhase(
  authority: VerifiedExecutionAuthority,
  input: {
    phase: ControlChildPhase;
    ordinal: number;
    /** A fixed CLI child's key, chosen with its spawn record. */
    childKey?: string;
    lease?: TargetLeaseAuthority;
    /** What the child acts on, recorded with its grant for the recipient. */
    evidence?: Record<string, unknown>;
  },
) {
  const child = lookupControlChildPhase(authority, input);
  if (!child) throw Error("Child phase is not bound");
  const before = inspectControlChildPublication(authority, input);
  if (before.publication.state !== "unissued") throw Error("Attempted child requires observation");
  if (
    input.lease &&
    controlDigest(input.lease.mode === "owner" ? input.lease.owner : input.lease.execution) !==
      controlDigest(authority.execution)
  )
    throw Error("Foreign phase target authority");
  const delegation = input.lease
    ? await delegateArtifactTargetLease(input.lease, {
        ...child,
        ...(input.childKey ? { childKey: input.childKey } : {}),
        ...(input.evidence ? { evidence: input.evidence } : {}),
      })
    : await attestParentExecution(authority, {
        ...child,
        ...(input.childKey ? { childKey: input.childKey } : {}),
      });
  const saved = inspectControlChildPublication(authority, input);
  if (saved.publication.state !== "grant_prepared")
    throw Error("Child publication was not retained");
  const dispatchTicket = Object.freeze({ [dispatchBrand]: true as const });
  tickets.set(dispatchTicket, {
    used: false,
    authority,
    phase: input.phase,
    deadlineAt: child.execution.deadlineAt,
  });
  return {
    channel: input.lease ? ("delegation" as const) : ("parent" as const),
    delegation,
    dispatchTicket,
  };
}
export function consumeControlChildDispatch(ticket: FreshControlChildDispatch): void {
  const saved = tickets.get(ticket);
  if (!saved || saved.used) throw Error("Missing or consumed child dispatch ticket");
  saved.used = true;
  assertControlDelegationForward(saved.authority, saved.phase);
  if (Date.now() >= saved.deadlineAt) throw Error("Child dispatch deadline elapsed");
}
