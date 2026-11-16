import { generationHardlinksReservation } from "./generation-hardlinks-records";

export { generationHardlinksReservation } from "./generation-hardlinks-records";

/** Fixed generation-hardlinks middle owner. It can delegate only the one frozen DM leaf. */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import { type CoordinatorMode, hardlinkApplySummarySchema } from "../ops/service-results";
import { currentConfigurationGeneration } from "../services/configuration-generation";
import {
  dataExecutionStatusSchema,
  generationHardlinksPlanSchema,
} from "../services/data-manager/contracts/executions";
import {
  DataExecutionObservationPending,
  observeDataExecution,
  requestDataExecutionCancellation,
} from "../services/data-manager/executions";
import {
  lookupDataExecution,
  startGenerationHardlinksExecution,
} from "../services/data-manager/generated/data-manager.generated";
import {
  type DataManagerTransport,
  unwrapDataManagerResponse,
} from "../services/data-manager/transport";
import { currentConfigurationFile, GENERATED_HARDLINK_PLAN_FILE } from "../services/deployment";
import {
  bindControlChildPhase,
  consumeControlChildDispatch,
  controlChildReservationSchema,
  issueControlChildPhase,
  lookupControlChildPhaseBinding,
} from "./child-phase";
import {
  assertControlExecutionForward,
  executionAuthorityState,
  readDataControlTerminalObservation,
  readPrivateRecord,
  type VerifiedExecutionAuthority,
  writePrivateRecord,
} from "./control-authority";
import { controlDigest } from "./control-records";
import {
  assertArtifactTargetLeaseExecution,
  inspectLocalLeaseChildSettlement,
  settleDataManagerLeaseChild,
  type TargetLeaseAuthority,
  verifyLocalArtifactTargetRootRelease,
} from "./target-lease";

const schema = z.strictObject({
  version: z.literal(1),
  parent: executionRefSchema,
  revisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
  coordinatorMode: z.enum(["ensure-running", "require-running"]),
  plan: generationHardlinksPlanSchema,
  reservation: z.lazy(() => controlChildReservationSchema).nullable(),
});
export type GenerationHardlinksOwnerPlan = z.infer<typeof schema>;
export function readOwnedGenerationHardlinkPlan(infraDir: string, revisionId: string) {
  if (currentConfigurationGeneration(infraDir) !== revisionId)
    throw Error("Hardlink generation conflict");
  const plan = generationHardlinksPlanSchema.parse({
    plan: JSON.parse(
      readFileSync(currentConfigurationFile(infraDir, GENERATED_HARDLINK_PLAN_FILE), "utf8"),
    ),
    prune: true,
  });
  if (plan.plan.length > 256 || currentConfigurationGeneration(infraDir) !== revisionId)
    throw Error("Hardlink generation conflict");
  return plan;
}
export function planGenerationHardlinksOwner(options: {
  infraDir: string;
  parent: ExecutionRef;
  revisionId: string;
  coordinatorMode: CoordinatorMode;
  serviceIds: readonly string[];
}): GenerationHardlinksOwnerPlan {
  const plan = readOwnedGenerationHardlinkPlan(options.infraDir, options.revisionId);
  const reservation = generationHardlinksReservation({ ...options, plan });
  return schema.parse({
    version: 1,
    parent: options.parent,
    revisionId: options.revisionId,
    coordinatorMode: options.coordinatorMode,
    plan,
    reservation,
  });
}
const name = (authority: VerifiedExecutionAuthority) =>
  `generation-hardlinks-${authority.execution.operationKey}.json`;
function validateOwner(
  s: ReturnType<typeof executionAuthorityState>,
  plan: GenerationHardlinksOwnerPlan,
) {
  const input = {
    kind: "generation-hardlinks",
    revisionId: plan.revisionId,
    coordinatorMode: plan.coordinatorMode,
    planDigest: controlDigest(plan.plan),
  };
  if (
    ![
      "configuration.hardlinks.apply",
      "service.start",
      "service.update",
      "data.update",
      "artifactTransfer.import",
    ].includes(s.kind) ||
    controlDigest(plan.parent) !== controlDigest(s.execution) ||
    (plan.reservation
      ? plan.reservation.operationFingerprint !== controlDigest(input) ||
        !s.reservations.some((r) => canonicalJson(r) === canonicalJson(plan.reservation))
      : s.reservations.some((r) => r.phase === "hardlinks"))
  )
    throw Error("Original hardlink owner required");
}
export function retainGenerationHardlinksOwnerPlan(
  authority: VerifiedExecutionAuthority,
  value: GenerationHardlinksOwnerPlan,
): void {
  const s = executionAuthorityState(authority),
    plan = schema.parse(value);
  validateOwner(s, plan);
  writePrivateRecord(s.installation, "observations", name(authority), plan, true);
}
export function readGenerationHardlinksOwnerPlan(
  authority: VerifiedExecutionAuthority,
): GenerationHardlinksOwnerPlan {
  const s = executionAuthorityState(authority),
    plan = schema.parse(
      readPrivateRecord(s.installation, "observations", name(authority), 128 * 1024),
    );
  validateOwner(s, plan);
  return plan;
}
export async function executeOwnedGenerationHardlinks(options: {
  authority: VerifiedExecutionAuthority;
  lease: TargetLeaseAuthority;
  infraDir: string;
  transport: DataManagerTransport;
  signal?: AbortSignal;
}) {
  const { authority, lease, transport, signal } = options,
    plan = readGenerationHardlinksOwnerPlan(authority);
  assertControlExecutionForward(authority);
  assertArtifactTargetLeaseExecution(lease, authority.execution);
  if (
    canonicalJson(readOwnedGenerationHardlinkPlan(options.infraDir, plan.revisionId)) !==
    canonicalJson(plan.plan)
  )
    throw Error("Frozen hardlink plan changed");
  if (!plan.reservation)
    return hardlinkApplySummarySchema.parse({
      applied: true,
      entries: 0,
      linked: 0,
      skipped: 0,
      pruned: 0,
      via: "none",
    });
  const prior = lookupControlChildPhaseBinding(authority, plan.reservation);
  const bound = prior?.child ?? (await bindControlChildPhase(authority, plan.reservation));
  const input = {
    kind: "generation-hardlinks" as const,
    revisionId: plan.revisionId,
    coordinatorMode: plan.coordinatorMode,
    planDigest: controlDigest(plan.plan),
  };
  const identity = {
    id: bound.execution.executionId,
    operationKey: bound.execution.operationKey,
    fingerprint: bound.execution.fingerprint,
  };
  const match = (value: unknown) => {
    const status = dataExecutionStatusSchema.parse(value);
    if (
      status.id !== identity.id ||
      status.operationKey !== identity.operationKey ||
      status.fingerprint !== identity.fingerprint ||
      status.deadlineAt !== bound.execution.deadlineAt ||
      status.kind !== input.kind
    )
      throw Error("Hardlink leaf identity conflict");
    return status;
  };
  let status: ReturnType<typeof dataExecutionStatusSchema.parse> | undefined;
  // A bound slot is already an attempted identity. Recovery only observes it.
  if (!prior) {
    const issued = await issueControlChildPhase(authority, {
      phase: "hardlinks",
      ordinal: plan.reservation.ordinal,
      childId: "data-manager",
      lease,
    });
    consumeControlChildDispatch(issued.dispatchTicket);
    try {
      status = match(
        unwrapDataManagerResponse(
          await startGenerationHardlinksExecution(
            {
              operationKey: identity.operationKey,
              requestedDeadlineAt: bound.execution.deadlineAt,
              input,
              plan: plan.plan,
            },
            { transport, signal, headers: { "x-openmapx-control-delegation": issued.assertion } },
          ),
        ),
      );
    } catch {
      /* Durable grant publication precedes POST; an ambiguous result is lookup-only. */
    }
  }
  try {
    if (!status)
      status = match(
        unwrapDataManagerResponse(
          await lookupDataExecution(identity.operationKey, { transport, signal }),
        ),
      );
    if (!["ok", "partial", "error", "canceled", "interrupted"].includes(status.status))
      status = await observeDataExecution(identity, {
        transport,
        signal,
        observerDeadlineAt: authority.execution.deadlineAt,
      });
  } catch {
    if (signal?.aborted)
      await requestDataExecutionCancellation(identity, { transport }).catch(() => undefined);
    throw new DataExecutionObservationPending(
      identity,
      signal?.aborted ? "interrupted" : "transport",
    );
  }
  // Data-manager's terminal status, read over its authenticated route, settles
  // the leaf in this owner's lease. An unknown publication leaves it held.
  const settlement = await settleDataManagerLeaseChild(lease, bound.execution, status);
  if (
    settlement?.outcome !== "committed" ||
    status.status !== "ok" ||
    status.result?.kind !== "generation-hardlinks"
  )
    throw new DataExecutionObservationPending(identity, "transport");
  return hardlinkApplySummarySchema.parse(status.result.hardlinks);
}

/** Settlement-only observation. Never bind, issue, dispatch, cancel or replay a
 * hardlink leaf after its original owner has stopped forwarding. */
export function inspectOwnedGenerationHardlinks(
  authority: VerifiedExecutionAuthority,
  lease?: TargetLeaseAuthority,
) {
  if (!lease) verifyLocalArtifactTargetRootRelease(authority);
  const owner = executionAuthorityState(authority),
    plan = readGenerationHardlinksOwnerPlan(authority);
  if (!plan.reservation) return "complete" as const;
  const binding = lookupControlChildPhaseBinding(authority, plan.reservation);
  if (!binding) return "not_attempted" as const;
  const proof = readDataControlTerminalObservation(
      owner.installation.installation,
      binding.child.execution,
    ),
    settled = lease ? inspectLocalLeaseChildSettlement(lease, binding.child.execution) : null;
  if (
    lease &&
    (!settled ||
      settled.outcome === "unknown" ||
      settled.publication === "unknown" ||
      settled.publication !== proof.status.publication)
  )
    throw Error("Original hardlink leaf remains unresolved");
  if (
    proof.status.status === "ok" &&
    proof.status.publication === "committed" &&
    proof.status.result?.kind === "generation-hardlinks"
  ) {
    if (lease && settled?.outcome !== "committed")
      throw Error("Original hardlink commit remains unresolved");
    hardlinkApplySummarySchema.parse(proof.status.result.hardlinks);
    return "complete" as const;
  }
  if (
    proof.status.publication !== "unknown" &&
    ["partial", "error", "canceled", "interrupted"].includes(proof.status.status)
  )
    return "failed" as const;
  throw Error("Original hardlink leaf remains unresolved");
}
