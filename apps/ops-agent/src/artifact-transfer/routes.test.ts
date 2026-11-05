import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueArtifactStreamCapability } from "@openmapx/core/ops";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { registerArtifactTransferRoutes } from "./routes";
import { ArtifactTransferStore } from "./store";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
it("authenticates before streaming, preserves binary bytes, refuses purpose and attempt replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-http-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data"), { mode: 0o700 });
  await mkdir(join(root, "private"), { mode: 0o700 });
  const token = "a".repeat(43);
  const store = new ArtifactTransferStore({
    dataRoot: join(root, "data"),
    privateRoot: join(root, "private"),
    token,
    capacity: () => ({ bytes: 2 * 1024 ** 3, inodes: 10000 }),
  });
  const app = Fastify();
  registerArtifactTransferRoutes(app, { store, apiToken: token });
  cleanups.push(async () => {
    await app.close();
    store.close();
  });
  const stage = await store.createStage({
    ownerId: "admin",
    purpose: "prepared-artifact",
    direction: "upload",
    declaredBytes: 4,
    operationKey: `opk1_${"a".repeat(20)}`,
  });
  const input = {
    version: 1 as const,
    stageId: stage.stageId,
    ownerId: "admin",
    purpose: stage.purpose,
    direction: "upload" as const,
    byteCap: 4,
    attemptId: randomUUID(),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    deadlineAt: Date.now() + 10000,
  };
  const cap = issueArtifactStreamCapability(token, input);
  const path = `/v1/artifact-transfers/${stage.stageId}/content`;
  const body = Buffer.from([0, 255, 192, 128]);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: path,
        payload: body,
        headers: { "Content-Type": "application/octet-stream" },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: path,
        payload: body,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "x-openmapx-artifact-capability": issueArtifactStreamCapability(token, {
            ...input,
            ownerId: "foreign",
          }),
        },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: path,
        payload: body,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "x-openmapx-artifact-capability": issueArtifactStreamCapability(token, {
            ...input,
            purpose: "integration-artifact",
          }),
        },
      })
    ).statusCode,
  ).toBe(404);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/octet-stream",
    "x-openmapx-artifact-capability": cap,
  };
  const result = await app.inject({ method: "PUT", url: path, payload: body, headers });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    state: "uploaded",
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: 4,
  });
  expect((await app.inject({ method: "PUT", url: path, payload: body, headers })).statusCode).toBe(
    409,
  );
});
