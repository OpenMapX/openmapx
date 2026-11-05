/** Portable results; no host runtime or executable operation imports. */
import { z } from "zod";
import {
  configurationGenerationRevisionSchema,
  serviceIdSchema,
} from "./configuration-identifiers";
export const configurationApplyResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("committed"),
    revisionId: configurationGenerationRevisionSchema,
    enabledServiceIds: z.array(serviceIdSchema).max(256),
    followUp: z.enum(["complete", "failed"]),
    cleanupFailed: z.boolean(),
  }),
  z.strictObject({
    outcome: z.literal("not_committed"),
    reason: z.enum(["conflict", "busy", "failed"]),
    currentRevisionId: configurationGenerationRevisionSchema.nullable().optional(),
    cleanupFailed: z.boolean(),
  }),
]);
export type ConfigurationApplyResult = z.infer<typeof configurationApplyResultSchema>;
