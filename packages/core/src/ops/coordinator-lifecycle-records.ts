/** Closed immutable submission data. Parsing never issues an API intent or pull proof. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { apiJobChildAttemptSchema } from "./api-job-attempt";
import { canonicalJson } from "./canonical-json";
import { servicePullOperationSchema } from "./service-operation-records";

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  key = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/);
export const coordinatorPullSubmissionSchema = z
  .strictObject({
    version: z.literal(1),
    requestVersion: z.literal(2),
    expectedExecutor: z.literal("ops-agent"),
    expectedPrincipal: z.literal("api"),
    stepAddress: key,
    operation: servicePullOperationSchema.extend({
      serviceId: z.literal("data-manager"),
      candidateId: z.uuid(),
    }),
    operationKey: key,
    operationFingerprint: digest,
    requestedDeadlineAt: z.number().int().nonnegative().safe(),
    attempt: apiJobChildAttemptSchema,
  })
  .refine(
    (s) =>
      s.operationKey === s.attempt.childOperationKey &&
      s.operationFingerprint === s.attempt.childOperationFingerprint &&
      s.requestedDeadlineAt === s.attempt.requestedDeadlineAt &&
      s.requestedDeadlineAt <= s.attempt.parentDeadlineAt &&
      s.operationFingerprint ===
        createHash("sha256").update(canonicalJson(s.operation)).digest("hex"),
  );
export type CoordinatorPullSubmission = z.infer<typeof coordinatorPullSubmissionSchema>;
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
    pull: coordinatorPullSubmissionSchema,
  }),
]);
export type CoordinatorLifecycleMetadata = z.infer<typeof coordinatorLifecycleMetadataSchema>;
export function coordinatorPullSubmissionDigest(submission: CoordinatorPullSubmission) {
  return createHash("sha256")
    .update("openmapx-coordinator-pull-submission-v1\0")
    .update(canonicalJson(coordinatorPullSubmissionSchema.parse(submission)))
    .digest("hex");
}
