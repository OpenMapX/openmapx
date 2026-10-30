/** Platform target authorization. Host effects remain behind the nominal
 * configuration participant and typed maintenance/handoff operations. */
import { and, eq, sql } from "drizzle-orm";
import type { AuthDatabase } from "../account/auth-database";
import { loadAuthPolicy } from "../account/auth-policy";
import { platformConfigurationPreview } from "../db/schema";
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
