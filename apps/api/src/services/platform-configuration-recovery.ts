/** Read-only join for an already MAC-authenticated nominal saved candidate.
 * This issues no participant/proof, saves nothing and cannot authorize a root. */
import { canonicalJson, type PlatformConfigurationIntentRecord } from "@openmapx/core/ops";
import { eq } from "drizzle-orm";
import type { AuthDatabase } from "../account/auth-database";
import { loadAuthPolicy } from "../account/auth-policy";
import { systemSettings } from "../db/schema";
import { JobObservationPending } from "./admin-job-failure";
import { readProjection } from "./admin-job-projection";
import { PLATFORM_CONFIGURATION_SETTING } from "./platform-configuration";
import { readRetainedPlatformPreview } from "./platform-preview-store";

export async function assertSavedPlatformConfiguration(
  input: {
    actorId: string;
    jobId: string;
    candidateId: string;
    revisionId: string;
    intent: PlatformConfigurationIntentRecord;
    checkpoint: Record<string, unknown> | null | undefined;
  },
  connection: Pick<AuthDatabase, "select">,
) {
  const { intent } = input,
    retained = await readRetainedPlatformPreview(
      { actorId: input.actorId, previewFingerprint: intent.previewFingerprint },
      connection,
    ),
    p = retained.preview;
  const [saved] = await connection
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, PLATFORM_CONFIGURATION_SETTING));
  if (
    retained.consumedByJobId !== input.jobId ||
    p.previewId !== intent.previewId ||
    p.authPolicyRevision !== intent.authPolicyRevision ||
    p.sourceRevision !== intent.sourceRevision ||
    p.expectedCurrentRevisionId !== intent.expectedCurrentRevisionId ||
    canonicalJson(p.configuration) !== canonicalJson(intent.configuration) ||
    canonicalJson(p.affectedServiceIds) !== canonicalJson(intent.affectedServiceIds) ||
    canonicalJson(p.reconcileServiceIds ?? null) !==
      canonicalJson(intent.reconcileServiceIds ?? null) ||
    canonicalJson(p.release ?? null) !== canonicalJson(intent.release ?? null) ||
    canonicalJson(retained.sourceSnapshot) !== canonicalJson(intent.sourceSnapshot) ||
    retained.desiredRowVersion !== intent.expectedDesiredRowVersion ||
    Object.entries(p.requiredConfirmation).some(
      ([key, required]) =>
        required && !intent.confirmations[key as keyof typeof intent.confirmations],
    ) ||
    (p.requiredConfirmation.domain && !intent.authorization) ||
    canonicalJson(saved?.value) !==
      canonicalJson({
        version: 1,
        jobId: input.jobId,
        candidateId: input.candidateId,
        revisionId: input.revisionId,
        previewFingerprint: p.previewFingerprint,
        configuration: p.configuration,
      })
  )
    throw new JobObservationPending("invalid_identity");
  const generation = Object.values(readProjection(input.checkpoint).operations).find(
    (entry) =>
      entry.operation?.kind === "stack.render" &&
      entry.operation.candidateId === input.candidateId &&
      entry.operation.revisionId === input.revisionId,
  );
  if (
    !generation?.attempt &&
    (new Date(retained.expiresAt) <= new Date() ||
      (await loadAuthPolicy(connection)).revision !== p.authPolicyRevision)
  )
    throw new JobObservationPending("recovery_required");
}
