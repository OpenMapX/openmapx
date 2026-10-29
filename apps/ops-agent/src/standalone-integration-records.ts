import {
  artifactStageClaimSchema,
  executionRefSchema,
  stageInspectionBindingSchema,
  standaloneInstallInspectionSchema,
  standaloneInstallSourceSchema,
} from "@openmapx/core/ops";
import {
  integrationPreparationReceiptSchema,
  integrationPublicationReceiptSchema,
} from "@openmapx/integration-framework/installer";
import z from "zod/v4";

const inode = z.strictObject({ dev: z.string(), ino: z.string() });
export const standaloneInspectionRecordSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.uuid(),
  ownerId: z.string().min(1).max(128),
  source: standaloneInstallSourceSchema,
  inspection: standaloneInstallInspectionSchema,
  preparation: integrationPreparationReceiptSchema,
  previous: z
    .strictObject({ contentDigest: z.string().regex(/^[a-f0-9]{64}$/), identity: inode })
    .nullable(),
  stage: stageInspectionBindingSchema.nullable(),
});
export const standaloneTransactionRecordSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.uuid(),
  transactionId: z.uuid(),
  ownerId: z.string().min(1).max(128),
  installExecution: executionRefSchema,
  inspection: standaloneInspectionRecordSchema,
  claim: artifactStageClaimSchema.nullable(),
  publication: integrationPublicationReceiptSchema.nullable(),
});

export type StandaloneInspectionRecord = z.infer<typeof standaloneInspectionRecordSchema>;
export type StandaloneTransactionRecord = z.infer<typeof standaloneTransactionRecordSchema>;
