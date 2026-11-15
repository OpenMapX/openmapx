import z from "zod/v4";
import { executionRefSchema } from "./execution-ref";

/** Target leases as the agent's store records them; plain data only. */
export const leaseTargetsSchema = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
  .min(1)
  .max(256)
  .refine(
    (targets) => targets.every((id, index) => index === 0 || (targets[index - 1] ?? id) < id),
    "Targets must be sorted and unique",
  );
export const leaseSettlementSchema = z.strictObject({
  identity: executionRefSchema,
  outcome: z.enum(["contained", "committed", "failed_without_effect", "unknown"]),
  publication: z.enum(["not_started", "committed", "unknown"]),
  terminalReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type LeaseSettlement = z.infer<typeof leaseSettlementSchema>;
const nodeStateSchema = z.enum(["held", "cancel_pending", "recovery_required", "settled"]);
/** A child as its issuer records it, before it starts. */
export const leaseChildIntentSchema = z.strictObject({
  key: z.uuid(),
  /** The child that issued this one, or null for the owner. */
  parentKey: z.uuid().nullable(),
  parent: executionRefSchema,
  execution: executionRefSchema,
  kind: z.string().min(1).max(128),
  phase: z.string().min(1).max(64),
  recipient: z.enum(["fixed-cli", "data-manager", "ops-agent", "configuration-helper"]),
  targets: leaseTargetsSchema,
  permittedFurtherEdges: z.array(z.string().max(64)).max(1),
  depth: z.number().int().min(1).max(2),
  /**
   * What the issuer prepared for the recipient to act on, such as the transit
   * candidate data-manager staged for the agent. The recipient re-checks it
   * against the files before any effect.
   */
  evidence: z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= 8192, "Evidence too large")
    .optional(),
});
export const leaseChildSchema = leaseChildIntentSchema.extend({
  /** Set when the recipient took the child over; an unadopted child never started. */
  adopted: z.boolean(),
  state: nodeStateSchema,
  settlement: leaseSettlementSchema.optional(),
});
export type LeaseChild = z.infer<typeof leaseChildSchema>;
export const leaseRecordSchema = z.strictObject({
  leaseId: z.uuid(),
  owner: executionRefSchema,
  ownerKind: z.string().min(1).max(128),
  targets: leaseTargetsSchema,
  state: nodeStateSchema,
  settlement: leaseSettlementSchema.optional(),
  children: z.array(leaseChildSchema).max(64),
  reason: z.string().max(512).optional(),
  createdAt: z.number().int().nonnegative().safe(),
});
export type LeaseRecord = z.infer<typeof leaseRecordSchema>;
const holderSchema = leaseRecordSchema.pick({
  leaseId: true,
  owner: true,
  ownerKind: true,
  state: true,
});

/** What data-manager and the host CLI ask the agent to do with their leases. */
export const leaseOperationSchemas = [
  z.strictObject({
    kind: z.literal("lease.acquire"),
    owner: executionRefSchema,
    ownerKind: z.string().min(1).max(128),
    targets: leaseTargetsSchema,
  }),
  z.strictObject({ kind: z.literal("lease.read"), leaseId: z.uuid() }),
  z.strictObject({
    kind: z.literal("lease.update"),
    leaseId: z.uuid(),
    action: z.discriminatedUnion("action", [
      z.strictObject({ action: z.literal("delegate"), child: leaseChildIntentSchema }),
      z.strictObject({
        action: z.literal("settle"),
        key: z.uuid().nullable(),
        settlement: leaseSettlementSchema,
      }),
      z.strictObject({ action: z.literal("cancel"), key: z.uuid().nullable() }),
      z.strictObject({ action: z.literal("release") }),
    ]),
  }),
] as const;
export const leaseResultSchemas = {
  "lease.acquire": z.discriminatedUnion("outcome", [
    z.strictObject({ outcome: z.literal("acquired"), lease: leaseRecordSchema }),
    z.strictObject({ outcome: z.literal("busy"), target: z.string(), holder: holderSchema }),
  ]),
  "lease.read": z.strictObject({ lease: leaseRecordSchema.nullable() }),
  "lease.update": z.strictObject({ lease: leaseRecordSchema.nullable() }),
} as const;
