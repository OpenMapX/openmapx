/** Observation/continuation of one already saved nominal managed-map candidate.
 * This never constructs a participant, consumes a proof, saves, encrypts or seals. */
import type { db } from "../db";
import { apiKeyedDigest } from "./admin-job-digest";
import { JobObservationPending } from "./admin-job-failure";
import { readAdminJobProtocol } from "./admin-job-state";
import type { JobContext } from "./job-runner";
import type { ProspectiveConfigurationOverlay } from "./prospective-configuration";
import { readRetainedFeedCredentialPreview } from "./transit-credential-preview";

export async function assertSavedTransitCredentialCandidate(input: {
  actorId: string;
  operationKey: string;
  candidateId: string;
  revision: string | undefined;
  overlay: ProspectiveConfigurationOverlay;
  connection: Pick<typeof db, "select">;
}) {
  const retained = await readRetainedFeedCredentialPreview(input, input.connection),
    change = input.overlay.changes[0];
  if (
    !retained ||
    !retained.row.consumedAt ||
    retained.row.candidateId !== input.candidateId ||
    retained.row.credentialsRevision !== input.revision ||
    input.overlay.purpose !== "transit-credentials" ||
    input.overlay.coordinatorMode !== "require-running" ||
    input.overlay.changes.length !== 1 ||
    change?.kind !== "service-secret" ||
    change.serviceId !== "data-manager" ||
    change.key !== "TRANSITOUS_API_KEYS" ||
    change.action !== "set"
  )
    throw new JobObservationPending("recovery_required");
  const map: Record<string, string> = JSON.parse(change.value);
  if (
    retained.private.changes.some((selected) =>
      selected.action === "set"
        ? map[selected.key] !== selected.value
        : Object.hasOwn(map, selected.key),
    )
  )
    throw new JobObservationPending("recovery_required");
}
export async function recoveredTransitCredentialResult(
  ctx: JobContext,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const actorId = ctx.checkpointResult?._immediateActorId,
    operationKey = ctx.payload.operationKey;
  if (typeof actorId !== "string" || typeof operationKey !== "string") return result;
  const retained = await readRetainedFeedCredentialPreview({ actorId, operationKey });
  if (!retained) return result;
  const digest = apiKeyedDigest("immediate-configuration-intent", {
    purpose: "transit-credentials",
    previewId: retained.row.id,
    intentFingerprint: retained.row.intentFingerprint,
  });
  if (digest !== ctx.checkpointResult?._immediateIntentDigest)
    throw new JobObservationPending("invalid_identity");
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
