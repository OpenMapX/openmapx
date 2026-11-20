/** The credential result an immediate transit credential job reports after its
 * recovery. This never constructs a participant, consumes a proof or saves. */
import { apiKeyedDigest } from "./admin-job-digest";
import { JobObservationPending } from "./admin-job-failure";
import { readAdminJobProtocol } from "./admin-job-state";
import type { JobContext } from "./job-runner";
import { readRetainedFeedCredentialPreview } from "./transit-credential-preview";

export async function recoveredTransitCredentialResult(
  ctx: JobContext,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const immediate = readAdminJobProtocol(ctx.protocol).immediate,
    actorId = immediate?.actorId,
    operationKey = ctx.payload.operationKey;
  if (typeof actorId !== "string" || typeof operationKey !== "string") return result;
  const retained = await readRetainedFeedCredentialPreview({ actorId, operationKey });
  if (!retained) return result;
  const digest = apiKeyedDigest("immediate-configuration-intent", {
    purpose: "transit-credentials",
    previewId: retained.row.id,
    intentFingerprint: retained.row.intentFingerprint,
  });
  if (digest !== immediate?.intentDigest) throw new JobObservationPending("invalid_identity");
  const checkpoint = readAdminJobProtocol(ctx.protocol).candidate;
  if (
    retained.row.consumedAt &&
    (retained.row.candidateId !== checkpoint?.candidateId || !retained.row.credentialsRevision)
  )
    throw new JobObservationPending("invalid_identity");
  return {
    ...result,
    transitCredentials: {
      credentialsRevision:
        retained.row.credentialsRevision ?? retained.private.preview.credentialsRevision,
      configuration: result.configuration,
    },
  };
}
