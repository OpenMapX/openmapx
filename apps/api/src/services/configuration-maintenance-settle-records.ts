/** Non-secret original request checkpoint; parsing confers no authority. */

import { configurationMaintenanceSettleSchema } from "@openmapx/core/ops";
import { z } from "zod";

const key = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  epoch = z.number().int().nonnegative().safe();
export const configurationMaintenanceSettleCheckpointSchema = z.strictObject({
  version: z.literal(1),
  operation: configurationMaintenanceSettleSchema,
  attempt: z.enum(["not_attempted", "attempted"]),
  delivery: z.strictObject({
    stepAddress: key,
    root: z.strictObject({
      operationKey: key,
      requestedDeadlineAt: epoch,
      parent: z.strictObject({
        operationKey: key,
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        deadlineAt: epoch,
      }),
    }),
  }),
});
