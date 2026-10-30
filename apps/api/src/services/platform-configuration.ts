/** Platform target authorization. Host effects remain behind the nominal
 * configuration participant and typed maintenance/handoff operations. */
import { randomUUID } from "node:crypto";
import {
  type AdminPlatformPreview,
  adminPlatformConfirmationSchema,
} from "@openmapx/core/api-contracts";
import { configurationGenerationRevisionSchema } from "@openmapx/core/ops";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { AdminActionReauthentication } from "../account/admin-reauthentication";
import type { AuthDatabase } from "../account/auth-database";
import { loadAuthPolicy } from "../account/auth-policy";
import {
  adminAuditLog,
  adminJob,
  platformConfigurationPreview,
  systemSettings,
  user,
} from "../db/schema";
import { jobOwnership } from "./admin-job-state";
import { PlatformPreviewConflict, readPlatformPreview } from "./platform-preview-store";

/** Called in the SAME desired-row transaction as purpose-proof consumption
 * and its saved continue checkpoint; it does not itself consume a proof. */
export async function assertDomainRecoveryPreview(
  input: {
    actorId: string;
    previewFingerprint: string;
    expectedCurrentRevisionId: string | null;
    expectedAuthPolicyRevision: string;
  },
  tx: AuthDatabase,
): Promise<void> {
  // Also protects the not-yet-activated policy singleton from an INSERT.
  await tx.execute(sql`LOCK TABLE auth_policy_state IN SHARE MODE`);
  await tx
    .select({ id: platformConfigurationPreview.id })
    .from(platformConfigurationPreview)
    .where(
      and(
        eq(platformConfigurationPreview.actorId, input.actorId),
        eq(platformConfigurationPreview.previewFingerprint, input.previewFingerprint),
      ),
    )
    .for("share");
  const retained = await readPlatformPreview(
    { actorId: input.actorId, previewFingerprint: input.previewFingerprint },
    tx,
  );
  if (
    retained.consumedByJobId ||
    !retained.preview.requiredConfirmation.domain ||
    retained.preview.expectedCurrentRevisionId !== input.expectedCurrentRevisionId
  )
    throw new PlatformPreviewConflict();
  const policy = await loadAuthPolicy(tx);
  if (
    policy.revision !== input.expectedAuthPolicyRevision ||
    retained.preview.authPolicyRevision !== policy.revision
  )
    throw new PlatformPreviewConflict(
      "Platform authentication policy changed; create a new preview",
    );
}

export interface PlatformConfigurationCommitInput {
  actorId: string;
  jobId: string;
  execution: { owner: string; version: number };
  candidateId: string;
  revisionId: string;
  previewFingerprint: string;
  expectedCurrentRevisionId: string | null;
  expectedAuthPolicyRevision: string;
  sourceRevision: string;
  expectedDesiredRowVersion: string | null;
  confirmations: AdminPlatformPreview["requiredConfirmation"];
  proof?: { challengeId: string; sessionId: string; nonce: Buffer | string };
}
/** Desired state is deliberately separate from the applied generation. An
 * unrelated renderer must never adopt an uncompleted domain intent. */
export const PLATFORM_CONFIGURATION_SETTING = "platformConfiguration";

/** SQL-only part of the closed platform participant. The caller supplies its
 * ORIGINAL writer transaction after actual remote preparation. This routine
 * grants no host authority and never commits the transaction or dispatches a
 * continuation; its preview/proof/desired writes roll back with the caller's
 * saved continue checkpoint. Recovery observes that checkpoint, never calls
 * this routine a second time or consumes another proof. */
export async function commitPlatformConfigurationIntent(
  input: PlatformConfigurationCommitInput,
  tx: AuthDatabase,
) {
  z.uuid().parse(input.candidateId);
  configurationGenerationRevisionSchema.parse(input.revisionId);
  const confirmations = adminPlatformConfirmationSchema.parse(input.confirmations);
  const [job] = await tx
    .select()
    .from(adminJob)
    .where(jobOwnership(input.jobId, input.execution))
    .for("update");
  const [actor] = await tx.select().from(user).where(eq(user.id, input.actorId)).for("share");
  if (
    !job ||
    job.type !== "platform.apply" ||
    job.createdBy !== input.actorId ||
    actor?.role !== "admin" ||
    actor.banned === true
  )
    throw new PlatformPreviewConflict();
  // Fixed order also covers the not-yet-activated policy singleton.
  await tx.execute(sql`LOCK TABLE auth_policy_state IN SHARE MODE`);
  await tx
    .select({ id: platformConfigurationPreview.id })
    .from(platformConfigurationPreview)
    .where(
      and(
        eq(platformConfigurationPreview.actorId, input.actorId),
        eq(platformConfigurationPreview.previewFingerprint, input.previewFingerprint),
      ),
    )
    .for("update");
  const retained = await readPlatformPreview(input, tx),
    preview = retained.preview;
  if (
    retained.consumedByJobId ||
    preview.sourceRevision !== input.sourceRevision ||
    preview.expectedCurrentRevisionId !== input.expectedCurrentRevisionId ||
    preview.authPolicyRevision !== input.expectedAuthPolicyRevision ||
    (await loadAuthPolicy(tx)).revision !== preview.authPolicyRevision ||
    Object.entries(preview.requiredConfirmation).some(
      ([key, required]) => required && confirmations[key as keyof typeof confirmations] !== true,
    )
  )
    throw new PlatformPreviewConflict();
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('openmapx.platform.desired',71956))`,
  );
  const [prior] = await tx
    .select({ value: systemSettings.value, version: sql<string>`xmin::text` })
    .from(systemSettings)
    .where(eq(systemSettings.key, PLATFORM_CONFIGURATION_SETTING))
    .for("update");
  if ((prior?.version ?? null) !== input.expectedDesiredRowVersion)
    throw new PlatformPreviewConflict("Platform desired state changed; create a new preview");
  if (preview.requiredConfirmation.domain) {
    await assertDomainRecoveryPreview(input, tx);
    if (!input.proof) throw new PlatformPreviewConflict("Domain recovery proof required");
    await new AdminActionReauthentication(tx).consume(
      {
        ...input.proof,
        purpose: "platform.domain.apply",
        targetId: preview.previewFingerprint,
        intentFingerprint: preview.previewFingerprint,
      },
      tx,
    );
  }
  const value = {
    version: 1,
    jobId: input.jobId,
    candidateId: input.candidateId,
    revisionId: input.revisionId,
    previewFingerprint: preview.previewFingerprint,
    configuration: preview.configuration,
  };
  const written = prior
    ? await tx
        .update(systemSettings)
        .set({ value, updatedAt: new Date(), updatedBy: input.actorId })
        .where(
          and(
            eq(systemSettings.key, PLATFORM_CONFIGURATION_SETTING),
            sql`xmin::text=${prior.version}`,
          ),
        )
        .returning({ rowVersion: sql<string>`xmin::text` })
    : await tx
        .insert(systemSettings)
        .values({ key: PLATFORM_CONFIGURATION_SETTING, value, updatedBy: input.actorId })
        .onConflictDoNothing()
        .returning({ rowVersion: sql<string>`xmin::text` });
  if (written.length !== 1) throw new PlatformPreviewConflict();
  const consumed = await tx
    .update(platformConfigurationPreview)
    .set({ consumedByJobId: input.jobId, consumedAt: new Date() })
    .where(
      and(
        eq(platformConfigurationPreview.id, preview.previewId),
        sql`${platformConfigurationPreview.consumedAt} IS NULL`,
        sql`${platformConfigurationPreview.expiresAt}>now()`,
      ),
    )
    .returning({ id: platformConfigurationPreview.id });
  if (consumed.length !== 1) throw new PlatformPreviewConflict();
  await tx.insert(adminAuditLog).values({
    id: randomUUID(),
    actorId: input.actorId,
    targetType: "platform",
    targetId: preview.previewId,
    action: "platform.configuration.save",
    details: {
      previewFingerprint: preview.previewFingerprint,
      candidateId: input.candidateId,
      revisionId: input.revisionId,
      oldOrigin: preview.oldOrigin,
      newOrigin: preview.newOrigin,
    },
  });
  // Only non-secret row identity/version enters the retained decision checksum.
  const result = {
    kind: "platform" as const,
    ownerId: "platform",
    rowId: PLATFORM_CONFIGURATION_SETTING,
    previousRowVersion: prior?.version ?? null,
    rowVersion: written[0]!.rowVersion,
    state: "present" as const,
  };
  return result;
}
