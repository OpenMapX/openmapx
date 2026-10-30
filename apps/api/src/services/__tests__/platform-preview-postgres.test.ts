import { randomUUID } from "node:crypto";
import { services as coreServices } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "../../db/schema";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";

const { buildPlatformConfigurationPreview } = coreServices;

import { readPlatformPreview, retainPlatformPreview } from "../platform-preview-store";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
dbDescribe("durable exact platform preview", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
  }, 90000);
  afterAll(async () => {
    await fixture?.stop();
  });
  async function actor() {
    const id = randomUUID();
    await fixture.db.insert(user).values({
      id,
      name: "Synthetic administrator",
      email: `${id}@example.test`,
      role: "admin",
      banned: false,
    });
    return id;
  }
  function preview(actorId: string, previewId = randomUUID()) {
    return buildPlatformConfigurationPreview({
      actorId,
      previewId,
      authPolicyRevision: "a".repeat(64),
      sourceRevision: randomUUID(),
      currentRevisionId: `cfg1_${"a".repeat(43)}`,
      expectedCurrentRevisionId: `cfg1_${"a".repeat(43)}`,
      env: { DOMAIN: "before.example.test" },
      changes: { version: 1, domain: { source: "database", value: "after.example.test" } },
      services: [],
    });
  }
  it("retains one original request and rejects changed intent, actor substitution and expiry", async () => {
    const actorId = await actor(),
      operationKey = randomUUID(),
      original = preview(actorId),
      requestFingerprint = "b".repeat(64),
      now = new Date();
    const row = await retainPlatformPreview(
      { actorId, operationKey, requestFingerprint, preview: original, now },
      fixture.db,
    );
    expect(row.preview.previewFingerprint).toBe(original.previewFingerprint);
    expect(
      await readPlatformPreview(
        { actorId, previewFingerprint: original.previewFingerprint, now },
        fixture.db,
      ),
    ).toEqual(row);
    const replay = await retainPlatformPreview(
      { actorId, operationKey, requestFingerprint, preview: preview(actorId), now },
      fixture.db,
    );
    expect(replay).toEqual(row);
    await expect(
      retainPlatformPreview(
        { actorId, operationKey, requestFingerprint: "c".repeat(64), preview: original, now },
        fixture.db,
      ),
    ).rejects.toThrow(/changed/i);
    await expect(
      readPlatformPreview(
        { actorId: await actor(), previewFingerprint: original.previewFingerprint, now },
        fixture.db,
      ),
    ).rejects.toThrow();
    await expect(
      readPlatformPreview(
        {
          actorId,
          previewFingerprint: original.previewFingerprint,
          now: new Date(now.getTime() + 600001),
        },
        fixture.db,
      ),
    ).rejects.toThrow(/expired/i);
  });
  it("concurrent duplicate requests converge on the original row and invalid policy/source copies refuse", async () => {
    const actorId = await actor(),
      operationKey = randomUUID(),
      one = preview(actorId),
      two = preview(actorId),
      now = new Date();
    const results = await Promise.all(
      [one, two].map((p) =>
        retainPlatformPreview(
          { actorId, operationKey, requestFingerprint: "d".repeat(64), preview: p, now },
          fixture.db,
        ),
      ),
    );
    expect(results[0]).toEqual(results[1]);
    const { platformConfigurationPreview } = await import("../../db/schema");
    await fixture.db
      .update(platformConfigurationPreview)
      .set({ preview: { ...results[0]!.preview, authPolicyRevision: "e".repeat(64) } })
      .where(eq(platformConfigurationPreview.id, results[0]!.preview.previewId));
    await expect(
      readPlatformPreview(
        { actorId, previewFingerprint: results[0]!.preview.previewFingerprint, now },
        fixture.db,
      ),
    ).rejects.toThrow();
  });
  it("requires the same actor/revision/live policy in the desired-row transaction", async () => {
    const { assertDomainRecoveryPreview } = await import("../platform-configuration");
    const { loadAuthPolicy, applyAuthPolicy } = await import("../../account/auth-policy");
    const actorId = await actor(),
      policy = await loadAuthPolicy(fixture.db),
      value = preview(actorId);
    const bound = buildPlatformConfigurationPreview({
      actorId,
      previewId: value.previewId,
      authPolicyRevision: policy.revision,
      sourceRevision: value.sourceRevision,
      currentRevisionId: value.expectedCurrentRevisionId,
      expectedCurrentRevisionId: value.expectedCurrentRevisionId,
      env: { DOMAIN: "before.example.test" },
      changes: value.configuration,
      services: [],
    });
    await retainPlatformPreview(
      { actorId, operationKey: randomUUID(), requestFingerprint: "f".repeat(64), preview: bound },
      fixture.db,
    );
    const request = {
      actorId,
      previewFingerprint: bound.previewFingerprint,
      expectedCurrentRevisionId: bound.expectedCurrentRevisionId,
      expectedAuthPolicyRevision: policy.revision,
    };
    await fixture.db.transaction((tx) => assertDomainRecoveryPreview(request, tx));
    for (const altered of [
      { actorId: await actor() },
      { expectedCurrentRevisionId: null },
      { expectedAuthPolicyRevision: "b".repeat(64) },
    ])
      await expect(
        fixture.db.transaction((tx) => assertDomainRecoveryPreview({ ...request, ...altered }, tx)),
      ).rejects.toThrow();
    await applyAuthPolicy(
      {
        confirmed: true,
        expectedRevision: policy.revision,
        idempotencyKey: randomUUID(),
        settings: {
          emailVerificationRequired: true,
          twoFaEnabled: true,
          passwordMinLength: 12,
          sessionDurationHours: 168,
        },
      },
      actorId,
      fixture.db,
    );
    await expect(
      fixture.db.transaction((tx) => assertDomainRecoveryPreview(request, tx)),
    ).rejects.toThrow(/policy/i);
  });
});
