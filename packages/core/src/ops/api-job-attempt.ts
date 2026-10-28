/** Exact portable decoding of the existing API HMAC parent preimage.
 * Schema property order is part of that existing signed encoding. */
import { z } from "zod";
export const apiJobChildAttemptSchema = z.strictObject({
  version: z.literal(1),
  apiJobId: z.uuid(),
  apiOwnerVersion: z.number().int().positive().safe(),
  parentOperationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  parentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  parentDeadlineAt: z.number().int().nonnegative().safe(),
  childOperationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  childOperationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requestedDeadlineAt: z.number().int().nonnegative().safe(),
  attemptId: z.uuid(),
});
export type ApiJobChildAttempt = z.infer<typeof apiJobChildAttemptSchema>;
