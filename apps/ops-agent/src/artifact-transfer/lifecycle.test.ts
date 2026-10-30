import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerArtifactTransferLifecycle } from "./lifecycle";
import { ArtifactTransferStore } from "./store";

it("runs expiry cleanup at startup and periodically, then stops observation on close", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-transfer-lifecycle-"));
  let now = Date.now();
  const store = new ArtifactTransferStore({
    dataRoot: join(root, "stages"),
    privateRoot: join(root, "private"),
    token: "synthetic-lifecycle-token",
    now: () => now,
    capacity: () => ({ bytes: 2 * 1024 ** 3, inodes: 100000 }),
  });
  const app = Fastify();
  try {
    vi.useFakeTimers();
    const create = () =>
      store.createStage({
        purpose: "prepared-artifact",
        direction: "upload",
        ownerId: "admin",
        declaredBytes: 1,
        operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
      });
    const first = await create();
    now = Date.parse(first.expiresAt) + 1;
    const observer = vi.spyOn(store, "reconcileTransferStages");
    registerArtifactTransferLifecycle(app, store);
    await app.ready();
    expect(await store.listStages({ ownerId: "admin", offset: 0, limit: 20 })).toMatchObject({
      total: 0,
    });
    const second = await create();
    now = Date.parse(second.expiresAt) + 1;
    await vi.advanceTimersByTimeAsync(15 * 60000);
    expect(await store.reservedBytes()).toBe(0);
    expect(observer).toHaveBeenCalledTimes(2);
    await app.close();
    await vi.advanceTimersByTimeAsync(15 * 60000);
    expect(observer).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
