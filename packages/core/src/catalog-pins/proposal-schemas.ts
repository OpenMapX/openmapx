/** Portable review identity, with no caller-authored validation assertion. */
import z from "zod/v4";
import { catalogPinSetSchema } from "./schemas";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const catalogProposalInputSchema = z.strictObject({
  proposalId: z.uuid(),
  baseGenerationId: digest.nullable(),
  pins: catalogPinSetSchema,
  diffDigest: digest,
  sourcePolicyRevision: digest,
});
export const catalogProposalSchema = catalogProposalInputSchema.extend({
  state: z.enum(["proposed", "validating", "validated", "rejected", "activating", "activated"]),
  createdAt: z.iso.datetime({ offset: true }),
});
export const catalogProposalEnvelopePayloadSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.uuid(),
  proposal: catalogProposalSchema,
});
export type CatalogProposalInput = z.infer<typeof catalogProposalInputSchema>;
export type CatalogProposal = z.infer<typeof catalogProposalSchema>;
export const catalogProposalSummarySchema = catalogProposalSchema
  .pick({
    proposalId: true,
    baseGenerationId: true,
    diffDigest: true,
    sourcePolicyRevision: true,
    state: true,
    createdAt: true,
  })
  .extend({
    catalogRevisionId: digest,
    transitousRef: z.string().max(256),
    atlasCommit: z.string().regex(/^[a-f0-9]{40}$/),
    gbfsCommit: z.string().regex(/^[a-f0-9]{40}$/),
  });
