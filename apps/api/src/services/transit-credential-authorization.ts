/** Private authenticated request binding, distinct from public job metadata. */
import { canonicalJson } from "@openmapx/core/ops";
import { and, eq, sql } from "drizzle-orm";
import { AdminActionReauthentication } from "../account/admin-reauthentication";
import { db } from "../db";
import { transitCredentialPreview } from "../db/schema";
import { decrypt, encrypt, secretAad } from "./secrets";
import { readFeedCredentialPreview, TransitCredentialConflict } from "./transit-credential-preview";
export interface TransitCredentialRequestBinding {
  actorId: string;
  previewId: string;
  intentFingerprint: string;
  operationKey: string;
  transitProofToken: string;
  sessionId: string;
  nonce: string;
}
export async function bindTransitCredentialAuthorization(input: TransitCredentialRequestBinding) {
  return db.transaction(async (tx) => {
    const stored = await readFeedCredentialPreview(input, tx);
    if (stored.row.authorizationCiphertext) {
      const original = decode(stored.row);
      if (
        original.transitProofToken !== input.transitProofToken ||
        original.actorId !== input.actorId
      )
        throw new TransitCredentialConflict();
      if (!stored.row.consumedAt && canonicalJson(original) !== canonicalJson(input))
        throw new TransitCredentialConflict("TRANSIT_CREDENTIALS_AUTHORIZATION_CHANGED");
      return;
    }
    if (stored.row.expiresAt <= new Date() || stored.row.consumedAt)
      throw new TransitCredentialConflict();
    await new AdminActionReauthentication(tx).check(
      {
        challengeId: input.transitProofToken,
        purpose: "transit.credential.update",
        targetId: stored.private.preview.catalogRevisionId,
        intentFingerprint: input.intentFingerprint,
        sessionId: input.sessionId,
        nonce: Buffer.from(input.nonce, "base64url"),
      },
      tx,
    );
    const bytes = encrypt(
      canonicalJson(input),
      secretAad.transitCredentialAuthorization(input.previewId),
    );
    const marked = await tx
      .update(transitCredentialPreview)
      .set({
        authorizationCiphertext: bytes.ciphertext,
        authorizationIv: bytes.iv,
        authorizationTag: bytes.tag,
        authorizationKeyVersion: bytes.keyVersion,
      })
      .where(
        and(
          eq(transitCredentialPreview.id, input.previewId),
          sql`${transitCredentialPreview.authorizationCiphertext} is null`,
        ),
      )
      .returning({ id: transitCredentialPreview.id });
    if (marked.length !== 1) throw new TransitCredentialConflict();
  });
}
function decode(
  row: typeof transitCredentialPreview.$inferSelect,
): TransitCredentialRequestBinding {
  try {
    if (
      !row.authorizationCiphertext ||
      !row.authorizationIv ||
      !row.authorizationTag ||
      row.authorizationKeyVersion === null
    )
      throw new Error();
    const input: TransitCredentialRequestBinding = JSON.parse(
      decrypt(
        {
          ciphertext: row.authorizationCiphertext,
          iv: row.authorizationIv,
          tag: row.authorizationTag,
          keyVersion: row.authorizationKeyVersion,
        },
        secretAad.transitCredentialAuthorization(row.id),
      ),
    );
    if (
      input.actorId !== row.actorUserId ||
      input.previewId !== row.id ||
      input.intentFingerprint !== row.intentFingerprint ||
      input.operationKey !== row.operationKey ||
      typeof input.sessionId !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.nonce) ||
      typeof input.transitProofToken !== "string"
    )
      throw new Error();
    return input;
  } catch {
    throw new TransitCredentialConflict("TRANSIT_CREDENTIALS_AUTHORIZATION_UNAVAILABLE");
  }
}
export async function readTransitCredentialAuthorization(input: {
  actorId: string;
  previewId: string;
  intentFingerprint: string;
  operationKey: string;
}) {
  return decode((await readFeedCredentialPreview(input)).row);
}
