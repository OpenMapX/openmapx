import z from "zod/v4";
import type { ExecutionRef } from "./execution-identity";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const pairedPinApprovalInputSchema = z.strictObject({
  kind: z.literal("transitousLock.approve"),
  proposalId: z.uuid(),
  validationId: z.uuid(),
  expectedGenerationId: digest.nullable(),
  diffDigest: digest,
  acknowledgeLicenseChanges: z.boolean(),
});
export const pairedPinApprovalResultSchema = z.strictObject({
  outcome: z.literal("activated"),
  proposalId: z.uuid(),
  validationId: z.uuid(),
  previousGenerationId: digest.nullable(),
  generationId: digest,
  commitId: z.uuid(),
  committedAt: z.iso.datetime({ offset: true }),
});
export type PairedPinApprovalInput = z.infer<typeof pairedPinApprovalInputSchema>;
export type PairedPinApprovalResult = z.infer<typeof pairedPinApprovalResultSchema>;
export type CatalogPinCommitIdentity = {
  commitId: string;
  execution: ExecutionRef;
  proposalId: string;
  validationId: string;
  diffDigest: string;
};
