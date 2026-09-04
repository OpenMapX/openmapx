import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { dataExportArtifact, dataSubjectRequest, dataSubjectRequestEvent } from "../db/schema.js";
import type { MasterKeyRing } from "./crypto.js";
import { recordSuccessfulArtifactDelivery } from "./delivery.js";
import { PrivacyRequestService } from "./request-service.js";

const describeDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
const keyRing: MasterKeyRing = {
  activeVersion: 1,
  activeKey: Buffer.alloc(32, 83),
  keys: new Map([[1, Buffer.alloc(32, 83)]]),
};
const requestIds: string[] = [];

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test fixture value");
  return value;
}

afterEach(async () => {
  for (const requestId of requestIds.splice(0))
    await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, requestId));
});

async function readyArtifact() {
  const request = await new PrivacyRequestService({
    database: db,
    keyRing,
    deploymentId: "test",
  }).create({
    channel: "email",
    subject: {
      locatorType: "email",
      locator: `delivery-${randomUUID()}@example.test`,
      accountState: "inaccessible",
    },
    locale: "en",
    timeZone: "UTC",
  });
  requestIds.push(request.id);
  await db
    .update(dataSubjectRequest)
    .set({ state: "ready", identityState: "verified" })
    .where(eq(dataSubjectRequest.id, request.id));
  const [artifact] = await db
    .insert(dataExportArtifact)
    .values({
      requestId: request.id,
      state: "ready",
      storageKey: `test/${randomUUID()}`,
      filename: "openmapx-data-export.zip",
      mediaType: "application/zip",
      iv: Buffer.alloc(12).toString("base64"),
      readyAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  return { request, artifact: required(artifact) };
}

describeDatabase("successful artifact delivery", () => {
  it("marks first delivery and permits counted repeat downloads until expiry", async () => {
    const { request, artifact } = await readyArtifact();
    const input = {
      requestId: request.id,
      artifactId: artifact.id,
      channel: "self_service" as const,
      actorKind: "subject" as const,
      actorId: null,
    };

    await expect(recordSuccessfulArtifactDelivery(input, db)).resolves.toBe(true);
    await expect(recordSuccessfulArtifactDelivery(input, db)).resolves.toBe(true);

    const [storedRequest] = await db
      .select()
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, request.id));
    const [storedArtifact] = await db
      .select()
      .from(dataExportArtifact)
      .where(eq(dataExportArtifact.id, artifact.id));
    const events = await db
      .select()
      .from(dataSubjectRequestEvent)
      .where(eq(dataSubjectRequestEvent.requestId, request.id));
    expect(storedRequest).toMatchObject({ state: "delivered", deliveryState: "delivered" });
    expect(storedArtifact?.downloadCount).toBe(2);
    expect(
      events.filter((event) => event.eventType === "self_service_delivery_completed"),
    ).toHaveLength(2);
  });

  it("does not let a late finish callback resurrect a withdrawn request", async () => {
    const { request, artifact } = await readyArtifact();
    await db
      .update(dataSubjectRequest)
      .set({ state: "withdrawn", withdrawalAt: new Date() })
      .where(eq(dataSubjectRequest.id, request.id));

    await expect(
      recordSuccessfulArtifactDelivery(
        {
          requestId: request.id,
          artifactId: artifact.id,
          channel: "assisted",
          actorKind: "privacy_admin",
          actorId: "caseworker",
        },
        db,
      ),
    ).resolves.toBe(false);
    const [storedArtifact] = await db
      .select()
      .from(dataExportArtifact)
      .where(eq(dataExportArtifact.id, artifact.id));
    expect(storedArtifact?.downloadCount).toBe(0);
  });
});
