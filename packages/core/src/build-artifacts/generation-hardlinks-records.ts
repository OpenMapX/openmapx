/** Pure fixed hardlink reservation data; no issuer/lease/runtime dependency. */
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { ExecutionRef } from "../ops/execution-ref";
import type { CoordinatorMode } from "../ops/service-results";
import { generationHardlinksPlanSchema } from "../services/data-manager/contracts/executions";
import {
  type ControlChildReservation,
  controlChildOperationKey,
  controlChildReservationSchema,
} from "./control-child-records";
import { controlDigest } from "./control-records";

function uuid(key: string) {
  const b = createHash("sha256")
    .update(`openmapx-generation-hardlinks-leaf-v1\0${key}`)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6]! & 15) | 64;
  b[8] = (b[8]! & 63) | 128;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Pure fixed graph construction; this never issues a grant or an execution. */
export function generationHardlinksReservation(options: {
  parent: Pick<ExecutionRef, "executor" | "principal" | "executionId" | "operationKey">;
  revisionId: string;
  coordinatorMode: CoordinatorMode;
  plan: z.infer<typeof generationHardlinksPlanSchema>;
  serviceIds: readonly string[];
}): ControlChildReservation | null {
  const plan = generationHardlinksPlanSchema.parse(options.plan),
    input = {
      kind: "generation-hardlinks" as const,
      revisionId: options.revisionId,
      coordinatorMode: options.coordinatorMode,
      planDigest: controlDigest(plan),
    };
  return plan.plan.length
    ? controlChildReservationSchema.parse({
        version: 1,
        phase: "hardlinks",
        ordinal: 0,
        kind: "generation-hardlinks",
        recipient: "data-manager",
        serviceIds: [...options.serviceIds].sort(),
        operationFingerprint: controlDigest(input),
        execution: {
          executor: "data-manager",
          principal: options.parent.executor === "host-cli" ? "host-cli" : "api",
          executionId: uuid(options.parent.operationKey),
          operationKey: controlChildOperationKey(options.parent.operationKey, "hardlinks", 0),
        },
      })
    : null;
}
