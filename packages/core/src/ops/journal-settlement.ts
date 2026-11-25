/** Portable: the settlement a finished agent operation records for every release. */
import { z } from "zod";
import type { ConfigurationApplyResult } from "./configuration-result-records";

const REVISION_ID = /^cfg1_[A-Za-z0-9_-]{43}$/;
const SERVICE_ID = /^(?=.{1,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * What a finished configuration apply settled, beside its full result. A
 * journal row carries it as part of its identity, so a release whose operation
 * or result schema differs from the writer's still settles the row. Its shape
 * never changes: a release reads every release's settlement with this schema.
 */
export const opsSettlementSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("committed"),
    summary: z.strictObject({
      revisionId: z.string().regex(REVISION_ID),
      enabledServiceIds: z.array(z.string().regex(SERVICE_ID)).max(256),
      followUp: z.enum(["complete", "failed"]),
      cleanupFailed: z.boolean(),
    }),
  }),
  z.strictObject({
    outcome: z.literal("not_committed"),
    summary: z.strictObject({
      reason: z.enum(["conflict", "busy", "failed"]),
      cleanupFailed: z.boolean(),
    }),
  }),
]);
export type OpsSettlement = z.infer<typeof opsSettlementSchema>;

/** The settlement of a configuration apply's result. */
export function settlementOfConfigurationApply(result: ConfigurationApplyResult): OpsSettlement {
  return result.outcome === "committed"
    ? {
        outcome: "committed",
        summary: {
          revisionId: result.revisionId,
          enabledServiceIds: [...result.enabledServiceIds],
          followUp: result.followUp,
          cleanupFailed: result.cleanupFailed,
        },
      }
    : {
        outcome: "not_committed",
        summary: { reason: result.reason, cleanupFailed: result.cleanupFailed },
      };
}

/** The configuration apply result a settlement records. */
export function configurationApplyOfSettlement(
  settlement: OpsSettlement,
): ConfigurationApplyResult {
  return settlement.outcome === "committed"
    ? {
        outcome: "committed",
        ...settlement.summary,
        enabledServiceIds: [...settlement.summary.enabledServiceIds],
      }
    : { outcome: "not_committed", ...settlement.summary };
}
