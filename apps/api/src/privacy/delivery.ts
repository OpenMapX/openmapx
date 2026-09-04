import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import { dataExportArtifact, dataSubjectRequest, dataSubjectRequestEvent } from "../db/schema.js";

export type PrivacyDeliveryChannel = "self_service" | "assisted" | "representative";

/**
 * Records delivery only after the HTTP response has finished. The request and
 * artifact are locked together so a concurrent withdrawal, revocation, or
 * expiry wins cleanly instead of being overwritten by a late finish callback.
 */
export async function recordSuccessfulArtifactDelivery(
  input: {
    requestId: string;
    artifactId: string;
    channel: PrivacyDeliveryChannel;
    actorKind: "subject" | "privacy_admin";
    actorId: string | null;
  },
  database: typeof defaultDb = defaultDb,
  now: Date = new Date(),
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select({
        requestState: dataSubjectRequest.state,
        artifactState: dataExportArtifact.state,
        artifactExpiresAt: dataExportArtifact.expiresAt,
      })
      .from(dataExportArtifact)
      .innerJoin(dataSubjectRequest, eq(dataExportArtifact.requestId, dataSubjectRequest.id))
      .where(
        and(
          eq(dataExportArtifact.id, input.artifactId),
          eq(dataExportArtifact.requestId, input.requestId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      row?.artifactState !== "ready" ||
      !row.artifactExpiresAt ||
      row.artifactExpiresAt <= now ||
      !["ready", "delivered"].includes(row.requestState)
    )
      return false;

    const artifactUpdated = await tx
      .update(dataExportArtifact)
      .set({ downloadCount: sql`${dataExportArtifact.downloadCount} + 1` })
      .where(
        and(
          eq(dataExportArtifact.id, input.artifactId),
          eq(dataExportArtifact.state, "ready"),
          sql`${dataExportArtifact.expiresAt} > ${now.toISOString()}`,
        ),
      )
      .returning({ id: dataExportArtifact.id });
    if (!artifactUpdated[0]) return false;

    const requestUpdated = await tx
      .update(dataSubjectRequest)
      .set({
        state: "delivered",
        deliveryState: "delivered",
        completedAt: sql`coalesce(${dataSubjectRequest.completedAt}, ${now.toISOString()})`,
        version:
          row.requestState === "ready"
            ? sql`${dataSubjectRequest.version} + 1`
            : dataSubjectRequest.version,
        updatedAt: now,
      })
      .where(
        and(
          eq(dataSubjectRequest.id, input.requestId),
          inArray(dataSubjectRequest.state, ["ready", "delivered"]),
        ),
      )
      .returning({ id: dataSubjectRequest.id });
    if (!requestUpdated[0]) return false;

    await tx.insert(dataSubjectRequestEvent).values({
      id: randomUUID(),
      requestId: input.requestId,
      eventType:
        input.channel === "self_service"
          ? "self_service_delivery_completed"
          : "assisted_delivery_completed",
      actorKind: input.actorKind,
      actorId: input.actorId,
      payloadVersion: 1,
      payload:
        input.channel === "self_service"
          ? { channel: "self_service" }
          : {
              channel: input.channel,
              recipientParty: input.channel === "representative" ? "representative" : "subject",
            },
      createdAt: now,
    });
    return true;
  });
}
