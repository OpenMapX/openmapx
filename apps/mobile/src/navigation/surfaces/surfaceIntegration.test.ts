import { migrateSessionSchema } from "../../storage/migrations";
import { SessionRepository } from "../../storage/SessionRepository";
import { openTestDatabase } from "../../storage/testing/nodeSqliteDatabase";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import { EffectRunner } from "../effects";
import { createPublishPort } from "../snapshots/createPublishPort";
import { SurfaceController } from "./SurfaceController";

it("publishes and clears surfaces from owned SQLite without a WebView", async () => {
  const db = openTestDatabase();
  await migrateSessionSchema(db, 1000);
  const repository = new SessionRepository(db);
  const now = 1_700_000_100_000;
  const update = jest.fn(async () => {});
  const clear = jest.fn(async () => {});
  const controller = new SurfaceController({ update, clear }, () => now);
  const reconcile = async () => controller.reconcile(await repository.loadActive(now), false);
  try {
    const s = groundSessionFixture({ status: "active" });
    s.lastAcceptedFix = { coords: [1, 2], accuracy: 5, timestampMs: now };
    await repository.createPreparing(s);
    const { port } = createPublishPort({
      repository,
      send: () => false,
      now: () => now,
      reconcileSurface: reconcile,
    });
    await port.snapshot(true);
    expect(update).toHaveBeenCalledTimes(1);
    const result = await repository.terminate(s.sessionId, "stopped", now);
    expect(result.effects).toContainEqual({ kind: "reconcile-surface" });
    const noop = async () => {};
    await new EffectRunner({
      reconcileSurface: reconcile,
      driver: { start: noop, stop: noop, updateProfile: noop, isRunning: async () => false },
      audio: { speak: noop, stop: noop },
      alerts: { reconcile: noop, cancelSession: noop },
      publish: port,
      remote: { reroute: noop, transitRefresh: noop },
      diagnostics: { record: () => {} },
    }).run(result.effects);
    expect(clear).toHaveBeenCalledWith(s.sessionId);
    await port.snapshot(false);
    expect(update).toHaveBeenCalledTimes(1);
  } finally {
    await db.closeAsync();
  }
});
