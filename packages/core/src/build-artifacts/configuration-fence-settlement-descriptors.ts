/** Pure fixed cell descriptors/bounds; no allocation or index mutation. */
import type { z } from "zod";
import type { ExecutionRef } from "../ops/execution-ref";
import type { configurationSettlementReservationProjectionSchema } from "./configuration-fence-settlement-records";

export type ConfigurationSettlementProjection = z.infer<
  typeof configurationSettlementReservationProjectionSchema
>;
export type ConfigurationSettlementRecordDescriptor = Readonly<{
  scope: "private" | "shared";
  namespace: "observations" | "execution";
  role: "ops-agent" | "data-manager";
  name: string;
  cap: number;
}>;
export interface ConfigurationSettlementFamilySlot {
  version: 2;
  role: "ops-agent" | "data-manager";
  settlementId: string;
  projectionDigest: string;
  reservationDigest: string;
  ownerPrepareDigest: string;
  proposedExecutionAddress: Pick<
    ExecutionRef,
    "executor" | "principal" | "executionId" | "operationKey"
  >;
  executionOrdinal: number | null;
  intentOrdinal: number | null;
  executionTicketId: string;
  intentTicketId: string;
  recordDescriptorsDigest: string;
  descriptors: ConfigurationSettlementRecordDescriptor[];
  state: "refusal_channel" | "capacity_refused" | "allocating" | "reserved" | "bound" | "UNUSED";
  reservedMetadataBytes: number;
  refusalConstraint: "members" | "tickets" | "metadata" | "records" | "filesystem" | null;
  executionDigest: string | null;
  controlBindingDigest: string | null;
  allocatedDescriptorDigests: string[];
  unusedIntentDigest: string | null;
  unusedConfirmedAt: number | null;
}
export function configurationSettlementRecordDescriptors(
  projection: Pick<ConfigurationSettlementProjection, "ownerPrepare" | "reservation">,
  prepareKey: string,
) {
  const rootKey = projection.ownerPrepare.operationKey,
    controlKey = projection.reservation.execution.operationKey;
  const descriptor = (
    scope: "private" | "shared",
    role: "ops-agent" | "data-manager",
    key: string,
    suffix: string,
    cap: number,
  ): ConfigurationSettlementRecordDescriptor =>
    Object.freeze({
      scope,
      namespace: scope === "private" ? "observations" : "execution",
      role,
      name: `${key}.configuration-settlement${suffix}.json`,
      cap,
    });
  const sender = [
    descriptor("shared", "ops-agent", rootKey, "", 16384),
    descriptor("private", "ops-agent", rootKey, "-binding", 4096),
    descriptor("shared", "ops-agent", rootKey, "-control", 8192),
    descriptor("private", "ops-agent", rootKey, "-dispatch", 2048),
    descriptor("private", "ops-agent", rootKey, "-ack", 4096),
    descriptor("shared", "ops-agent", rootKey, "-ack", 1024),
  ];
  const receiver = [
    descriptor("shared", "data-manager", prepareKey, "-capacity", 8192),
    descriptor("private", "data-manager", controlKey, "-admission", 4096),
    descriptor("private", "data-manager", controlKey, "-effect", 4096),
    descriptor("private", "data-manager", controlKey, "-terminal", 4096),
    descriptor("shared", "data-manager", controlKey, "-terminal", 4096),
    descriptor("private", "data-manager", controlKey, "-ack", 1024),
  ];
  if ([...sender, ...receiver].reduce((sum, record) => sum + record.cap, 0) > 65536)
    throw Error("Complete settlement packet capacity exceeded");
  return Object.freeze({ sender: Object.freeze(sender), receiver: Object.freeze(receiver) });
}
