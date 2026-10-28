/** Immutable phase/address/reservation data only. No admission, dispatch or guard constructors. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import { digest } from "./control-records";

export type ControlRecipient = "fixed-cli" | "data-manager" | "ops-agent" | "configuration-helper";
export type ControlChildPhase =
  | "lifecycle"
  | "build"
  | "data-link"
  | "data-clean"
  | "data-workflow"
  | "data-finalization"
  | "hardlinks"
  | "stop-primary"
  | "stop-staging"
  | "restart-staging"
  | "promote-primary"
  | "recover-primary"
  | "proxy-stage"
  | "proxy-commit"
  | "proxy-restore"
  | "paired-pin-commit"
  | "configuration-fence"
  | "configuration-fence-settle"
  | "configuration-commit"
  | "maintenance-hardlinks"
  | "maintenance-recreate"
  | "maintenance-handoff"
  | "osm"
  | "transit"
  | "fonts"
  | "data-step"
  | "configuration-handoff";
export const childPhaseKinds: Readonly<Record<ControlChildPhase, readonly string[]>> = {
  lifecycle: ["service.start", "service.update", "system.update"],
  build: ["service.build", "services.buildAll"],
  "data-link": ["data.link", "configuration.hardlinks.apply"],
  "data-clean": ["data.clean"],
  "data-finalization": ["data.update"],
  "data-workflow": [
    "data.update",
    "data.downloadOsm",
    "data.downloadFonts",
    "data.convertOverpass",
    "data.overtureSync",
    "data.overtureConflate",
    "data.searchIndexBuild",
    "data.notablePlacesBuild",
  ],
  hardlinks: ["generation-hardlinks"],
  "stop-primary": ["motis.primary.stop"],
  "stop-staging": ["motis.staging.stop"],
  "restart-staging": ["motis.staging.restart"],
  "promote-primary": ["motis.primary.promote"],
  "recover-primary": ["motis.primary.restart"],
  "proxy-stage": ["feedProxy.validateAndReload"],
  "proxy-commit": ["feedProxy.validateAndReload"],
  "proxy-restore": ["feedProxy.validateAndReload"],
  "paired-pin-commit": ["transitousLock.approve"],
  "configuration-fence": ["configuration-maintenance.prepare"],
  "configuration-fence-settle": ["configuration-maintenance.settle"],
  "configuration-commit": [
    "stack.render",
    "serviceSelection.apply",
    "serviceConfig.apply",
    "integrationConfig.apply",
    "vault.apply",
  ],
  "maintenance-hardlinks": ["configuration.hardlinks.apply"],
  "maintenance-recreate": ["service.recreate", "service.recreateIsolated"],
  "maintenance-handoff": ["configurationHandoff.prepare"],
  osm: ["download-osm"],
  transit: ["transit-sync"],
  fonts: ["download-fonts"],
  "data-step": [
    "download-osm",
    "download-fonts",
    "convert-overpass",
    "overture-sync",
    "overture-conflate",
    "search-index-build",
    "notable-places-build",
  ],
  "configuration-handoff": ["configuration-helper"],
};
export function controlChildOperationKey(
  parentKey: string,
  phase: ControlChildPhase,
  ordinal: number,
): string {
  if (
    !/^opk1_[A-Za-z0-9_-]{16,64}$/.test(parentKey) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal > 63 ||
    !Object.hasOwn(childPhaseKinds, phase)
  )
    throw Error("Invalid fixed phase key");
  return `opk1_${createHash("sha256").update(`openmapx-control-child-v1\0${parentKey}\0${phase}\0${ordinal}`).digest("base64url").slice(0, 32)}`;
}
export type ControlChildReservation = {
  version: 1;
  phase: ControlChildPhase;
  ordinal: number;
  kind: string;
  recipient: ControlRecipient;
  serviceIds: readonly string[];
  execution: Pick<ExecutionRef, "executor" | "principal" | "executionId" | "operationKey">;
  operationFingerprint: string;
};
const address = z
  .strictObject({
    executor: executionRefSchema.shape.executor,
    principal: executionRefSchema.shape.principal,
    executionId: z.string(),
    operationKey: executionRefSchema.shape.operationKey,
  })
  .refine((v) =>
    v.executor === "ops-agent"
      ? /^job1_[A-Za-z0-9_-]{16,64}$/.test(v.executionId)
      : z.uuid().safeParse(v.executionId).success,
  );
export const controlChildReservationSchema: z.ZodType<ControlChildReservation> = z.lazy(() =>
  z.strictObject({
    version: z.literal(1),
    phase: z.enum(Object.keys(childPhaseKinds) as [ControlChildPhase, ...ControlChildPhase[]]),
    ordinal: z.number().int().min(0).max(63),
    kind: z.string().min(1).max(128),
    recipient: z.enum(["fixed-cli", "data-manager", "ops-agent", "configuration-helper"]),
    serviceIds: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
      .min(1)
      .max(256)
      .refine((a) => a.every((v, i) => i === 0 || (a[i - 1] ?? v) < v)),
    execution: address,
    operationFingerprint: digest,
  }),
);
