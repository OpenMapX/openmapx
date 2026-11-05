import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const state = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
}));
vi.mock("../db", () => ({
  get db() {
    return state.fixture.db;
  },
  get sql() {
    return state.fixture.sql;
  },
}));

import { transitCredentialPreview, user } from "../db/schema";
import {
  readFeedCredentialPreview,
  retainFeedCredentialPreview,
} from "./transit-credential-preview";

const enabled = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1";
beforeAll(async () => {
  if (!enabled) return;
  vi.stubEnv("OPENMAPX_SECRETS_KEY", "57".repeat(32));
  state.fixture = await createMigratedPostgresFixture();
  await state.fixture.db.insert(user).values({
    id: "transit-preview-admin",
    name: "Fixture",
    email: "transit-preview@example.test",
    emailVerified: true,
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}, 90000);
afterAll(async () => {
  await state.fixture?.stop();
  vi.unstubAllEnvs();
});
it.skipIf(!enabled)(
  "retains encrypted immutable actor-bound changes with a value-free replayable public preview",
  async () => {
    const input = {
      actorId: "transit-preview-admin",
      operationKey: "preview-immutable-1",
      catalogRevisionId: "a".repeat(64),
      credentialsRevision: "b".repeat(64),
      expectedCurrentRevisionId: null,
      changes: [
        { key: "de/required", action: "set" as const, value: "private-transit-credential" },
      ],
      preservedCount: 2,
      mapBytes: 53,
    };
    const preview = await retainFeedCredentialPreview(input);
    expect(JSON.stringify(preview)).not.toContain(input.changes[0]!.value);
    const [row] = await state.fixture.db.select().from(transitCredentialPreview);
    expect(JSON.stringify(row)).not.toContain(input.changes[0]!.value);
    expect(await retainFeedCredentialPreview(input)).toEqual(preview);
    expect(
      (
        await readFeedCredentialPreview({
          actorId: input.actorId,
          previewId: preview.previewId,
          intentFingerprint: preview.intentFingerprint,
          operationKey: input.operationKey,
        })
      ).private.changes,
    ).toEqual(input.changes);
    await expect(
      retainFeedCredentialPreview({
        ...input,
        changes: [{ ...input.changes[0]!, value: "substitution" }],
      }),
    ).rejects.toThrow("TRANSIT_CREDENTIALS_CHANGED");
    await expect(
      readFeedCredentialPreview({
        actorId: "foreign",
        previewId: preview.previewId,
        intentFingerprint: preview.intentFingerprint,
        operationKey: input.operationKey,
      }),
    ).rejects.toThrow("PREVIEW_UNAVAILABLE");
  },
  30000,
);
it.skipIf(!enabled)(
  "reclaims expired completed proposals while retaining bound unresolved ones",
  async () => {
    const { adminJob } = await import("../db/schema"),
      { eq, inArray } = await import("drizzle-orm"),
      { encrypt } = await import("./secrets"),
      { randomUUID } = await import("node:crypto");
    const make = (operationKey: string) =>
      retainFeedCredentialPreview({
        actorId: "transit-preview-admin",
        operationKey,
        catalogRevisionId: "a".repeat(64),
        credentialsRevision: "b".repeat(64),
        expectedCurrentRevisionId: null,
        changes: [{ key: "de/A", action: "set", value: "synthetic-private" }],
        preservedCount: 0,
        mapBytes: 29,
      });
    const completedKey = `opk1_${randomUUID().replaceAll("-", "")}`,
      pendingKey = `opk1_${randomUUID().replaceAll("-", "")}`,
      completed = await make(completedKey),
      pending = await make(pendingKey),
      expired = new Date(Date.now() - 4 * 86400000),
      binding = encrypt("{}");
    for (const preview of [completed, pending])
      await state.fixture.db
        .update(transitCredentialPreview)
        .set({
          expiresAt: expired,
          authorizationCiphertext: binding.ciphertext,
          authorizationIv: binding.iv,
          authorizationTag: binding.tag,
        })
        .where(eq(transitCredentialPreview.id, preview.previewId));
    await state.fixture.db.insert(adminJob).values([
      {
        id: randomUUID(),
        type: "configuration.apply",
        status: "failed",
        createdBy: "transit-preview-admin",
        finishedAt: expired,
        payload: { operationKey: completedKey },
        result: { _immediateActorId: "transit-preview-admin" },
      },
      {
        id: randomUUID(),
        type: "configuration.apply",
        status: "running",
        createdBy: "transit-preview-admin",
        payload: { operationKey: pendingKey },
        result: { _immediateActorId: "transit-preview-admin" },
      },
    ]);
    await make(`opk1_${randomUUID().replaceAll("-", "")}`);
    const rows = await state.fixture.db
      .select({ id: transitCredentialPreview.id })
      .from(transitCredentialPreview)
      .where(inArray(transitCredentialPreview.id, [completed.previewId, pending.previewId]));
    expect(rows).toEqual([{ id: pending.previewId }]);
  },
  30000,
);
