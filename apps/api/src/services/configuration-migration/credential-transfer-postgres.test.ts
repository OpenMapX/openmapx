import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";

const state = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
}));
vi.mock("../../db", () => ({
  get db() {
    return state.fixture.db;
  },
}));

import { adminJob, configurationMigrationPreview, user } from "../../db/schema";
import {
  assertRetainedMigrationStage,
  consumeMigrationStage,
  pruneMigrationStages,
  readMigrationStage,
  replaceMigrationStage,
  retainMigrationStage,
} from "./staging";

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "actual encrypted migration staging / owned PostgreSQL",
  () => {
    beforeAll(async () => {
      state.fixture = await createMigratedPostgresFixture();
      vi.stubEnv("OPENMAPX_SECRETS_KEY", "71".repeat(32));
      await state.fixture.db.insert(user).values([
        {
          id: "migration-admin",
          email: "migration-admin@example.test",
          name: "Migration admin",
          role: "admin",
        },
        {
          id: "other-admin",
          email: "other-admin@example.test",
          name: "Other admin",
          role: "admin",
        },
      ]);
    }, 90000);
    afterAll(async () => {
      vi.unstubAllEnvs();
      await state.fixture?.stop();
    });
    it("persists only destination-encrypted data and rejects actor, stale choice and consumed replays", async () => {
      const stage = await retainMigrationStage({
        actorId: "migration-admin",
        kind: "credentials",
        value: { syntheticSecret: "private synthetic credential" },
      });
      expect(Object.isFrozen(stage)).toBe(true);
      expect(Object.isFrozen(stage.value)).toBe(true);
      expect(() => assertRetainedMigrationStage(structuredClone(stage))).toThrow();
      const row = (
        await state.fixture.db
          .select()
          .from(configurationMigrationPreview)
          .where(eq(configurationMigrationPreview.id, stage.previewId))
      )[0]!;
      expect(JSON.stringify(row)).not.toContain("private synthetic credential");
      expect(
        (
          await readMigrationStage({
            actorId: stage.actorId,
            previewId: stage.previewId,
            fingerprint: stage.fingerprint,
            kind: stage.kind,
          })
        ).value,
      ).toEqual({ syntheticSecret: "private synthetic credential" });
      await expect(
        readMigrationStage({
          actorId: "other-admin",
          previewId: stage.previewId,
          fingerprint: stage.fingerprint,
          kind: stage.kind,
        }),
      ).rejects.toThrow();
      const next = await replaceMigrationStage({
        actorId: stage.actorId,
        previewId: stage.previewId,
        fingerprint: stage.fingerprint,
        kind: stage.kind,
        value: { syntheticSecret: "replacement synthetic credential" },
      });
      expect(next.fingerprint).not.toBe(stage.fingerprint);
      await expect(
        readMigrationStage({
          actorId: stage.actorId,
          previewId: stage.previewId,
          fingerprint: stage.fingerprint,
          kind: stage.kind,
        }),
      ).rejects.toThrow();
      await state.fixture.db.transaction((tx) => consumeMigrationStage(next, randomUUID(), tx));
      await expect(
        readMigrationStage({
          actorId: next.actorId,
          previewId: next.previewId,
          fingerprint: next.fingerprint,
          kind: next.kind,
        }),
      ).rejects.toThrow();
    });
    it("rolls stage consumption back atomically with a failed selected-row transaction", async () => {
      const stage = await retainMigrationStage({
        actorId: "migration-admin",
        kind: "migration",
        value: { settings: { instanceName: "synthetic" } },
      });
      await expect(
        state.fixture.db.transaction(async (tx) => {
          await consumeMigrationStage(stage, randomUUID(), tx);
          throw Error("synthetic transaction failure");
        }),
      ).rejects.toThrow("synthetic transaction failure");
      expect(
        (
          await readMigrationStage({
            actorId: stage.actorId,
            previewId: stage.previewId,
            fingerprint: stage.fingerprint,
            kind: stage.kind,
          })
        ).value,
      ).toEqual(stage.value);
    });
    it("expires unused ciphertext while retaining an admitted or unknown owner until proven discard", async () => {
      const active = await retainMigrationStage({
          actorId: "migration-admin",
          kind: "credentials",
          value: { syntheticSecret: "active" },
        }),
        unused = await retainMigrationStage({
          actorId: "migration-admin",
          kind: "credentials",
          value: { syntheticSecret: "unused" },
        }),
        jobId = randomUUID();
      for (const id of [active.previewId, unused.previewId])
        await state.fixture.db
          .update(configurationMigrationPreview)
          .set({
            createdAt: new Date(Date.now() - 1200000),
            expiresAt: new Date(Date.now() - 600000),
          })
          .where(eq(configurationMigrationPreview.id, id));
      await state.fixture.db.insert(adminJob).values({
        id: jobId,
        type: "credential.import",
        status: "running",
        createdBy: "migration-admin",
        result: {
          _migrationStage: { id: active.previewId },
          _configurationCandidate: { phase: "prepared" },
        },
      });
      expect((await pruneMigrationStages()).map((r) => r.id)).toContain(unused.previewId);
      expect(
        (await state.fixture.db.select().from(configurationMigrationPreview)).some(
          (r) => r.id === active.previewId,
        ),
      ).toBe(true);
      await state.fixture.db
        .update(adminJob)
        .set({
          status: "failed",
          finishedAt: new Date(),
          result: {
            _migrationStage: { id: active.previewId },
            _configurationCandidate: { phase: "unknown" },
          },
        })
        .where(eq(adminJob.id, jobId));
      await pruneMigrationStages();
      expect(
        (await state.fixture.db.select().from(configurationMigrationPreview)).some(
          (r) => r.id === active.previewId,
        ),
      ).toBe(true);
      await state.fixture.db
        .update(adminJob)
        .set({
          result: {
            _migrationStage: { id: active.previewId },
            _configurationCandidate: { phase: "discarded" },
          },
        })
        .where(eq(adminJob.id, jobId));
      expect((await pruneMigrationStages()).map((r) => r.id)).toContain(active.previewId);
    });
  },
);
