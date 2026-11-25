/** Sole nominal issuer for the existing queued DM Apply / Update producers.
 * It derives provenance from the retained owned job; no target, callback,
 * participant, result, authority flag or prepared attempt can be supplied. */
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  coordinatorLifecycleMetadataSchema,
  type PreparedConfigurationRecord,
} from "@openmapx/core/ops";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { jobOwnership } from "./admin-job-state";
import {
  type AdministrativeConfigurationWriter,
  administrativeConfigurationState,
} from "./administrative-configuration-writer-owner";
import type { JobContext } from "./job-runner";
import { createDurableOpsKey } from "./ops-client";

declare const coordinatorIntent: unique symbol;
export interface CoordinatorLifecycleIntent {
  readonly [coordinatorIntent]: true;
}
type State = {
  writer: AdministrativeConfigurationWriter;
  job: JobContext;
  provenance: string;
  candidateId: string;
  action: "apply" | "update";
  originalOrdinal: number | null;
  noDeps: boolean;
};
const intents = new WeakMap<CoordinatorLifecycleIntent, State>();
const refuse = () => Error("Original coordinator lifecycle job required");
export function coordinatorLifecycleOperationKey(jobId: string, ordinal: number | null) {
  return createDurableOpsKey(
    "configuration.coordinator-lifecycle",
    `${jobId}:${ordinal ?? "apply"}`,
  );
}
/** The step address of a coordinator Update's image pull. */
export function coordinatorPullStepAddress(jobId: string, ordinal: number) {
  return createDurableOpsKey("configuration.coordinator-pull", `${jobId}:${ordinal}`);
}
// Bind the entire original row, including retained admission bookkeeping.
// The business-field allowlists below exclude only that reserved envelope;
// it never selects an operation, target, decision or recovery capability.
function provenance(row: typeof adminJob.$inferSelect) {
  return canonicalJson({
    id: row.id,
    type: row.type,
    payload: row.payload,
    createdBy: row.createdByUserId,
  });
}
export async function prepareCoordinatorLifecycleIntent(
  writer: AdministrativeConfigurationWriter,
  originalOrdinal: number | null,
): Promise<CoordinatorLifecycleIntent> {
  const { job, participant, transactionActive } = administrativeConfigurationState(writer);
  if (
    !job.execution ||
    participant ||
    transactionActive ||
    job.observationOnly ||
    writer.actorId !== job.jobId ||
    writer.operationKey !== coordinatorLifecycleOperationKey(job.jobId, originalOrdinal) ||
    writer.integrationIds.length
  )
    throw refuse();
  const [row] = await db.select().from(adminJob).where(jobOwnership(job.jobId, job.execution));
  if (!row || row.type !== job.jobType || canonicalJson(row.payload) !== canonicalJson(job.payload))
    throw refuse();
  const payload = row.payload as Record<string, unknown>;
  let action: "apply" | "update",
    noDeps = false;
  if (originalOrdinal === null) {
    if (
      row.type !== "service.apply" ||
      payload.service !== "data-manager" ||
      Object.keys(payload).some((k) => k !== "service" && k !== "_maintenanceRequest")
    )
      throw refuse();
    action = "apply";
  } else {
    if (
      !Number.isInteger(originalOrdinal) ||
      originalOrdinal < 0 ||
      originalOrdinal > 255 ||
      row.type !== "service.batch.run" ||
      payload.action !== "update" ||
      !Array.isArray(payload.serviceIds) ||
      payload.serviceIds[originalOrdinal] !== "data-manager" ||
      payload.serviceIds.filter((id) => id === "data-manager").length !== 1 ||
      (payload.noDeps !== undefined && typeof payload.noDeps !== "boolean") ||
      Object.keys(payload).some(
        (k) =>
          ![
            "action",
            "serviceIds",
            "all",
            "region",
            "continueOnError",
            "noDeps",
            "_maintenanceRequest",
          ].includes(k),
      )
    )
      throw refuse();
    action = "update";
    noDeps = payload.noDeps === true;
  }
  const intent = Object.freeze({}) as CoordinatorLifecycleIntent;
  intents.set(intent, {
    writer,
    job,
    provenance: provenance(row),
    candidateId: randomUUID(),
    action,
    originalOrdinal,
    noDeps,
  });
  return intent;
}
export async function assertCoordinatorLifecycleIntent(
  intent: CoordinatorLifecycleIntent,
  writer: AdministrativeConfigurationWriter,
) {
  const state = intents.get(intent),
    owner = administrativeConfigurationState(writer);
  if (
    !state ||
    state.writer !== writer ||
    state.job !== owner.job ||
    owner.participant ||
    (owner.transactionActive && owner.transactionMode !== "read")
  )
    throw refuse();
  const [row] = await db
    .select()
    .from(adminJob)
    .where(jobOwnership(state.job.jobId, state.job.execution));
  if (!row || state.provenance !== provenance(row)) throw refuse();
  return state;
}

/** Rechecks a retained coordinator candidate against the job row that owns
 * it. This does not mint a fresh intent, candidate or attempt. */
export function assertRetainedCoordinatorLifecycleProvenance(
  row: typeof adminJob.$inferSelect,
  record: PreparedConfigurationRecord,
) {
  const fixed = coordinatorLifecycleMetadataSchema.parse(record.privateCoordinatorLifecycle),
    payload = row.payload as Record<string, unknown>;
  if (
    row.id !== record.apiJobId ||
    record.actorId !== row.id ||
    record.apiFollowUp !== `coordinator-${fixed.action}` ||
    !record.maintenanceId ||
    !record.prepareOperationKey ||
    canonicalJson(record.affectedServiceIds) !== '["data-manager"]' ||
    canonicalJson(record.privateOverlay) !==
      canonicalJson({ purpose: "render", coordinatorMode: "ensure-running", changes: [] }) ||
    (fixed.action === "apply"
      ? row.type !== "service.apply" ||
        payload.service !== "data-manager" ||
        Object.keys(payload).some((k) => k !== "service" && k !== "_maintenanceRequest")
      : row.type !== "service.batch.run" ||
        payload.action !== "update" ||
        !Array.isArray(payload.serviceIds) ||
        payload.serviceIds[fixed.originalOrdinal] !== "data-manager" ||
        payload.serviceIds.filter((id) => id === "data-manager").length !== 1 ||
        fixed.noDeps !== (payload.noDeps === true))
  )
    throw refuse();
  return fixed;
}
