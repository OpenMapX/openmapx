/** Observation/continuation of one already saved nominal managed-map candidate.
 * This never constructs a participant, consumes a proof, saves, encrypts or seals. */
import { createHmac } from "node:crypto";
import { canonicalJson, readOpsTokenFile } from "@openmapx/core/ops";
import type { db } from "../db";
import { JobObservationPending } from "./admin-job-failure";
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
  const token = await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? ""),
    digest = createHmac("sha256", token)
      .update("openmapx-immediate-configuration-intent-v1\0")
      .update(
        canonicalJson({
          purpose: "transit-credentials",
          previewId: retained.row.id,
          intentFingerprint: retained.row.intentFingerprint,
        }),
      )
      .digest("hex");
  if (digest !== ctx.checkpointResult?._immediateIntentDigest)
    throw new JobObservationPending("invalid_identity");
  const checkpoint = ctx.checkpointResult?._configurationCandidate as
    | { candidateId?: string }
    | undefined;
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
