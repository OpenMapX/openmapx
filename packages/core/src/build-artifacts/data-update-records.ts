/** Frozen Full Update graph data. Constructors issue no authority. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { opsOperationSchema } from "../ops/contract";
import { executionRefSchema } from "../ops/execution-ref";
import { opsOperationFingerprint } from "../ops/fingerprint";
import {
  generationHardlinksPlanSchema,
  normalizeDataExecutionInput,
  ordinaryDataExecutionInputSchema,
} from "../services/data-manager/contracts/executions";
import {
  type ControlChildReservation,
  controlChildOperationKey,
  controlChildReservationSchema,
} from "./control-child-records";
import { controlDigest } from "./control-records";
import { generationHardlinksReservation } from "./generation-hardlinks-records";
export const dataUpdatePlanSchema = z.strictObject({
  version: z.literal(1),
  parent: executionRefSchema,
  operation: opsOperationSchema,
  region: z.string().min(1).max(256),
  countries: z.array(z.string().regex(/^[A-Z]{2,3}$/)).max(256),
  domain: z.string().min(1).max(253),
  revisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
  sourcesDigest: z.string().regex(/^[a-f0-9]{64}$/),
  finalRevisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
  hardlinks: generationHardlinksPlanSchema,
  dataReservation: controlChildReservationSchema,
  finalizationReservation: controlChildReservationSchema,
  dataChildren: z.array(controlChildReservationSchema).length(3),
  finalizationChildren: z.array(controlChildReservationSchema).max(1),
  dataDelegationId: z.uuid(),
  finalizationDelegationId: z.uuid(),
});
export type DataUpdatePlan = z.infer<typeof dataUpdatePlanSchema>;
export function dataUpdateAddress(key: string, purpose: string) {
  const b = createHash("sha256")
    .update(`openmapx-data-update-v1\0${key}\0${purpose}`)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6]! & 15) | 64;
  b[8] = (b[8]! & 63) | 128;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function createDataUpdatePlan(
  options: Pick<
    DataUpdatePlan,
    | "parent"
    | "operation"
    | "region"
    | "countries"
    | "domain"
    | "revisionId"
    | "sourcesDigest"
    | "hardlinks"
  > & { serviceIds: readonly string[] },
): DataUpdatePlan {
  if (options.operation.kind !== "data.update") throw Error("Full Update operation required");
  const targets = [...options.serviceIds].sort(),
    root = options.parent,
    opfp = opsOperationFingerprint(options.operation);
  const slot = (phase: "data-workflow" | "data-finalization"): ControlChildReservation => ({
    version: 1,
    phase,
    ordinal: phase === "data-workflow" ? 0 : 1,
    kind: "data.update",
    recipient: "fixed-cli",
    serviceIds: targets,
    operationFingerprint: opfp,
    execution: {
      executor: "host-cli",
      principal: root.principal,
      executionId: dataUpdateAddress(root.operationKey, phase),
      operationKey: controlChildOperationKey(
        root.operationKey,
        phase,
        phase === "data-workflow" ? 0 : 1,
      ),
    },
  });
  const dataReservation = slot("data-workflow"),
    finalizationReservation = slot("data-finalization");
  const inputs = [
    { phase: "osm" as const, input: { kind: "download-osm", region: options.region } },
    { phase: "transit" as const, input: { kind: "transit-sync", countries: options.countries } },
    { phase: "fonts" as const, input: { kind: "download-fonts" } },
  ];
  const dataParent = root.executor === "host-cli" ? root : dataReservation.execution;
  const dataChildren = inputs.map(({ phase, input }, ordinal) =>
    controlChildReservationSchema.parse({
      version: 1,
      phase,
      ordinal,
      kind: input.kind,
      recipient: "data-manager",
      serviceIds: targets,
      operationFingerprint: controlDigest(
        normalizeDataExecutionInput(ordinaryDataExecutionInputSchema.parse(input)),
      ),
      execution: {
        executor: "data-manager",
        principal: "host-cli",
        executionId: dataUpdateAddress(root.operationKey, phase),
        operationKey: controlChildOperationKey(dataParent.operationKey, phase, ordinal),
      },
    }),
  );
  const finalRevisionId = `cfg1_${createHash("sha256").update(`openmapx-data-update-generation-v1\0${root.operationKey}`).digest("base64url")}`;
  const leaf = generationHardlinksReservation({
    parent: root.executor === "host-cli" ? root : finalizationReservation.execution,
    revisionId: finalRevisionId,
    coordinatorMode: "ensure-running",
    plan: options.hardlinks,
    serviceIds: targets,
  });
  if (leaf && root.executor === "host-cli") {
    leaf.ordinal = 3;
    leaf.execution.operationKey = controlChildOperationKey(root.operationKey, "hardlinks", 3);
  }
  const { serviceIds: _targets, ...body } = options;
  const plan = dataUpdatePlanSchema.parse({
    ...body,
    version: 1,
    dataReservation,
    finalizationReservation,
    dataChildren,
    finalizationChildren: leaf ? [leaf] : [],
    finalRevisionId,
    dataDelegationId: dataUpdateAddress(root.operationKey, "data-grant"),
    finalizationDelegationId: dataUpdateAddress(root.operationKey, "finalization-grant"),
  });
  if (Buffer.byteLength(JSON.stringify(plan)) > 48 * 1024)
    throw Error("Full Update plan exceeds fixed spawn capacity");
  return plan;
}
