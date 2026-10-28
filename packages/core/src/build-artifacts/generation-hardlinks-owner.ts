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
  controlRolePublicKey,
  executionAuthorityState,
  readPrivateRecord,
  type VerifiedExecutionAuthority,
  writePrivateRecord,
} from "./control-authority";
import { controlDigest, signControl, verifyControl } from "./control-records";
import {
  assertArtifactTargetLeaseExecution,
  inspectArtifactTargetLeaseChildSettlement,
  type TargetLeaseAuthority,
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
const domain = "openmapx-generation-hardlinks-owner-v1";
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
    !["configuration.hardlinks.apply", "service.start", "service.update"].includes(s.kind) ||
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
  writePrivateRecord(
    s.installation,
    "observations",
    name(authority),
    signControl(s.installation.privateKey, domain, plan),
    true,
    s.origin,
  );
}
export function readGenerationHardlinksOwnerPlan(
  authority: VerifiedExecutionAuthority,
): GenerationHardlinksOwnerPlan {
  const s = executionAuthorityState(authority),
    plan = verifyControl(
      s.installation.installation.publicKey,
      domain,
      readPrivateRecord(s.installation, "observations", name(authority), 128 * 1024),
      schema,
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
    s = executionAuthorityState(authority),
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
      ordinal: 0,
      childPublicKey: controlRolePublicKey(s.installation.installation, "data-manager"),
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
  let contained = false;
  const until = Math.min(Date.now() + 5000, authority.execution.deadlineAt + 30000);
  do {
    try {
      const settlement = inspectArtifactTargetLeaseChildSettlement(lease, bound.execution);
      contained = settlement?.outcome === "committed" && settlement.publication === "committed";
    } catch {
      /* Public terminal publication can precede the final borrowed-node receipt. */
    }
    if (contained || Date.now() >= until) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (!contained && Date.now() < until);
  if (!contained || status.status !== "ok" || status.result?.kind !== "generation-hardlinks")
    throw new DataExecutionObservationPending(identity, "transport");
  return hardlinkApplySummarySchema.parse(status.result.hardlinks);
}
