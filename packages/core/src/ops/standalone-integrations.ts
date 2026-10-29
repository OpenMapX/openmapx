import z from "zod/v4";
import { assertAllowedGitUrl } from "../git-url";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const owner = z.string().min(1).max(128);
const component = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const remote = z
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search
      );
    } catch {
      return false;
    }
  });
const repository = remote.refine((value) => {
  try {
    assertAllowedGitUrl(value);
    return true;
  } catch {
    return false;
  }
});
export const standaloneInstallSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("artifact"), url: remote, sha256: digest }),
  z.strictObject({
    kind: z.literal("source"),
    repository,
    ref: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/)
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("uploaded-artifact"),
    stageId: z.uuid(),
    expectedSha256: digest,
  }),
]);
export const standaloneInstallInspectionSchema = z.strictObject({
  inspectionId: z.uuid(),
  sourceKind: z.enum(["artifact", "source", "uploaded-artifact"]),
  integrationId: component,
  version: z.string().min(1).max(128),
  contentDigest: digest,
  commit: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  stageId: z.uuid().nullable(),
  archiveSha256: digest.nullable(),
  expiresAt: z.iso.datetime(),
  denials: z.array(z.string().max(512)).max(64),
});
export const standaloneIntegrationProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("artifact"),
    url: remote,
    artifactSha256: digest,
    contentDigest: digest,
  }),
  z.strictObject({
    kind: z.literal("source"),
    url: repository,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    contentDigest: digest,
  }),
  z.strictObject({
    kind: z.literal("uploaded-artifact"),
    stageId: z.uuid(),
    artifactSha256: digest,
    contentDigest: digest,
  }),
]);
export type StandaloneIntegrationProvenance = z.infer<typeof standaloneIntegrationProvenanceSchema>;
export const standaloneInstallReceiptSchema = z.strictObject({
  transactionId: z.uuid(),
  integrationId: component,
  previousContentDigest: digest.nullable(),
  contentDigest: digest,
  outcome: z.literal("published"),
});
export const standaloneIntegrationOperationSchemas = [
  z.strictObject({
    kind: z.literal("integration.inspectInstall"),
    source: standaloneInstallSourceSchema,
    ownerId: owner,
  }),
  z.strictObject({
    kind: z.literal("integration.install"),
    inspectionId: z.uuid(),
    ownerId: owner,
    expectedContentDigest: digest,
    operationId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal("integration.settle"),
    transactionId: z.uuid(),
    decision: z.enum(["commit", "restore"]),
    expectedContentDigest: digest,
  }),
] as const;
export const standaloneIntegrationResultSchemas = {
  "integration.inspectInstall": standaloneInstallInspectionSchema,
  "integration.install": standaloneInstallReceiptSchema,
  "integration.settle": z.strictObject({
    transactionId: z.uuid(),
    outcome: z.enum(["committed", "restored"]),
    contentDigest: digest.nullable(),
  }),
} as const;
export type StandaloneInstallSource = z.infer<typeof standaloneInstallSourceSchema>;
export type StandaloneInstallInspection = z.infer<typeof standaloneInstallInspectionSchema>;
export type StandaloneInstallReceipt = z.infer<typeof standaloneInstallReceiptSchema>;
