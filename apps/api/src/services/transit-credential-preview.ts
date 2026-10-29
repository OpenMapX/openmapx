/** Private immutable encrypted proposals; public intents contain no value-derived hashes. */
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@openmapx/core/ops";
import type { FeedCredentialChange } from "@openmapx/transitous-core/feed-credentials";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { transitCredentialPreview } from "../db/schema";
import { withPreservationRetentionLock } from "../privacy/preservation";
import { decrypt, encrypt } from "./secrets";
import { pruneTransitCredentialPreviews } from "./transit-credential-retention";
export class TransitCredentialConflict extends Error {
  constructor(readonly code = "TRANSIT_CREDENTIALS_CHANGED") {
    super(code);
  }
}
export interface FeedCredentialChangePreview {
  previewId: string;
  intentFingerprint: string;
  catalogRevisionId: string;
  proposalId?: string;
  credentialsRevision: string;
  expectedCurrentRevisionId: string | null;
  expiresAt: string;
  changes: Array<{ key: string; action: "set" | "delete" }>;
  preservedCount: number;
  mapBytes: number;
}
export interface PrivateFeedCredentialPreview {
  version: 1;
  actorId: string;
  operationKey: string;
  preview: FeedCredentialChangePreview;
  changes: FeedCredentialChange[];
}
export function feedCredentialIntent(input: {
  previewId: string;
  actorId: string;
  catalogRevisionId: string;
  proposalId?: string;
  credentialsRevision: string;
  expectedCurrentRevisionId: string | null;
  changes: readonly FeedCredentialChange[];
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        purpose: "transit.credentials",
        previewId: input.previewId,
        actorId: input.actorId,
        catalogRevisionId: input.catalogRevisionId,
        ...(input.proposalId ? { proposalId: input.proposalId } : {}),
        credentialsRevision: input.credentialsRevision,
        expectedCurrentRevisionId: input.expectedCurrentRevisionId,
        changes: input.changes
          .map(({ key, action }) => ({ key, action }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      }),
    )
    .digest("hex");
}
function decoded(row: typeof transitCredentialPreview.$inferSelect): PrivateFeedCredentialPreview {
  try {
    const value: PrivateFeedCredentialPreview = JSON.parse(
      decrypt(row.ciphertext, row.iv, row.tag),
    );
    if (
      value.version !== 1 ||
      value.actorId !== row.actorId ||
      value.operationKey !== row.operationKey ||
      value.preview.previewId !== row.id ||
      value.preview.intentFingerprint !== row.intentFingerprint ||
      value.preview.expiresAt !== row.expiresAt.toISOString() ||
      feedCredentialIntent({
        ...value.preview,
        previewId: row.id,
        actorId: row.actorId,
        credentialsRevision: value.preview.credentialsRevision,
        changes: value.changes,
      }) !== row.intentFingerprint
    )
      throw new Error();
    return value;
  } catch {
    throw new TransitCredentialConflict("TRANSIT_CREDENTIALS_PREVIEW_UNAVAILABLE");
  }
}
export async function retainFeedCredentialPreview(
  input: Omit<PrivateFeedCredentialPreview, "version" | "preview"> & {
    catalogRevisionId: string;
    proposalId?: string;
    credentialsRevision: string;
    expectedCurrentRevisionId: string | null;
    preservedCount: number;
    mapBytes: number;
  },
): Promise<FeedCredentialChangePreview> {
  return withPreservationRetentionLock(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(71954,1)`);
    await pruneTransitCredentialPreviews(tx);
    const [existing] = await tx
      .select()
      .from(transitCredentialPreview)
      .where(
        and(
          eq(transitCredentialPreview.actorId, input.actorId),
          eq(transitCredentialPreview.operationKey, input.operationKey),
        ),
      )
      .for("share");
    if (existing) {
      const value = decoded(existing);
      if (
        existing.expiresAt <= new Date() ||
        canonicalJson({
          catalogRevisionId: value.preview.catalogRevisionId,
          ...(value.preview.proposalId ? { proposalId: value.preview.proposalId } : {}),
          credentialsRevision: value.preview.credentialsRevision,
          expectedCurrentRevisionId: value.preview.expectedCurrentRevisionId,
          changes: value.changes,
        }) !==
          canonicalJson({
            catalogRevisionId: input.catalogRevisionId,
            ...(input.proposalId ? { proposalId: input.proposalId } : {}),
            credentialsRevision: input.credentialsRevision,
            expectedCurrentRevisionId: input.expectedCurrentRevisionId,
            changes: input.changes,
          })
      )
        throw new TransitCredentialConflict();
      return value.preview;
    }
    const [{ total, actor }] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        actor: sql<number>`count(*) filter (where ${transitCredentialPreview.actorId} = ${input.actorId})::int`,
      })
      .from(transitCredentialPreview);
    if (total >= 4096 || actor >= 100)
      throw new TransitCredentialConflict("TRANSIT_CREDENTIALS_PREVIEW_CAPACITY");
    const previewId = randomUUID(),
      expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const preview: FeedCredentialChangePreview = {
      previewId,
      intentFingerprint: feedCredentialIntent({ ...input, previewId }),
      catalogRevisionId: input.catalogRevisionId,
      ...(input.proposalId ? { proposalId: input.proposalId } : {}),
      credentialsRevision: input.credentialsRevision,
      expectedCurrentRevisionId: input.expectedCurrentRevisionId,
      expiresAt,
      changes: input.changes.map(({ key, action }) => ({ key, action })),
      preservedCount: input.preservedCount,
      mapBytes: input.mapBytes,
    };
    const privateValue: PrivateFeedCredentialPreview = {
      version: 1,
      actorId: input.actorId,
      operationKey: input.operationKey,
      preview,
      changes: input.changes,
    };
    const plaintext = canonicalJson(privateValue);
    if (Buffer.byteLength(plaintext) > 1024 * 1024)
      throw new TransitCredentialConflict("TRANSIT_CREDENTIALS_PREVIEW_CAPACITY");
    await tx.insert(transitCredentialPreview).values({
      id: previewId,
      actorId: input.actorId,
      operationKey: input.operationKey,
      intentFingerprint: preview.intentFingerprint,
      expiresAt: new Date(expiresAt),
      ...encrypt(plaintext),
    });
    return preview;
  });
}
export async function readFeedCredentialPreview(
  input: { actorId: string; previewId: string; intentFingerprint: string; operationKey: string },
  connection: Pick<typeof db, "select"> = db,
) {
  const [row] = await connection
    .select()
    .from(transitCredentialPreview)
    .where(
      and(
        eq(transitCredentialPreview.id, input.previewId),
        eq(transitCredentialPreview.actorId, input.actorId),
        eq(transitCredentialPreview.operationKey, input.operationKey),
        eq(transitCredentialPreview.intentFingerprint, input.intentFingerprint),
      ),
    )
    .for("share");
  if (!row) throw new TransitCredentialConflict("TRANSIT_CREDENTIALS_PREVIEW_UNAVAILABLE");
  return { row, private: decoded(row) };
}

/** Private recovery lookup. The caller must still verify the original job/candidate. */
export async function readRetainedFeedCredentialPreview(
  input: { actorId: string; operationKey: string },
  connection: Pick<typeof db, "select"> = db,
) {
  const rows = await connection
    .select()
    .from(transitCredentialPreview)
    .where(
      and(
        eq(transitCredentialPreview.actorId, input.actorId),
        eq(transitCredentialPreview.operationKey, input.operationKey),
      ),
    )
    .limit(2);
  if (rows.length !== 1) return undefined;
  return { row: rows[0]!, private: decoded(rows[0]!) };
}
