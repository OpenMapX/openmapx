/** What a coordinator Apply or Update candidate records about its own job. An
 * Update pulls data-manager's image first, as an ordinary operation that names
 * the candidate; the maintenance commits the image that pull reports. */
import { z } from "zod";

export const coordinatorLifecycleMetadataSchema = z.discriminatedUnion("action", [
  z.strictObject({
    version: z.literal(1),
    serviceId: z.literal("data-manager"),
    action: z.literal("apply"),
    originalOrdinal: z.null(),
    noDeps: z.literal(false),
  }),
  z.strictObject({
    version: z.literal(1),
    serviceId: z.literal("data-manager"),
    action: z.literal("update"),
    originalOrdinal: z.number().int().min(0).max(255),
    noDeps: z.boolean(),
  }),
]);
export type CoordinatorLifecycleMetadata = z.infer<typeof coordinatorLifecycleMetadataSchema>;
