/** The agent's one file per configuration maintenance: the record the transition
 * table changes, beside what the agent planned at admission and runs its steps
 * with. Only the agent writes it; the kernel reads it for the maintenance root. */
import { z } from "zod";
import { maintenanceRecordSchema } from "../ops/configuration-maintenance-record";
import { ownedServiceSnapshotSchema } from "../ops/owned-service-records";
import {
  coordinatorPullWitnessSchema,
  stagedCoordinatorObservationSchema,
} from "./coordinator-pull-records";
import { fixedConfigurationMaintenancePlanSchema } from "./fixed-configuration-maintenance";

export const MAINTENANCE_NAMESPACE = "maintenance";

export const maintenanceFileSchema = z.strictObject({
  version: z.literal(1),
  record: maintenanceRecordSchema,
  plan: z.lazy(() => fixedConfigurationMaintenancePlanSchema),
  originalContainers: z.array(ownedServiceSnapshotSchema).max(256),
  coordinatorPull: coordinatorPullWitnessSchema.optional(),
  stagedCoordinatorProvenance: stagedCoordinatorObservationSchema.optional(),
});
export type MaintenanceFile = z.infer<typeof maintenanceFileSchema>;

export const maintenanceFileName = (maintenanceId: string) =>
  `${z.uuid().parse(maintenanceId)}.json`;

/** Parses a file read from the namespace and checks it names `maintenanceId`. */
export function parseMaintenanceFile(raw: unknown, maintenanceId: string): MaintenanceFile {
  const file = maintenanceFileSchema.parse(raw);
  if (file.record.maintenanceId !== maintenanceId)
    throw Error("Maintenance record identity changed");
  return file;
}
