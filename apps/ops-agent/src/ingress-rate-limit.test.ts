import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerArtifactTransferRoutes } from "./artifact-transfer/routes";
import { ArtifactTransferStore } from "./artifact-transfer/store";
import { buildOpsAgentServer } from "./server";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function transferStore() {
  const root = await mkdtemp(join(tmpdir(), "ops-ingress-rate-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data"), { mode: 0o700 });
  await mkdir(join(root, "private"), { mode: 0o700 });
  const store = new ArtifactTransferStore({
    dataRoot: join(root, "data"),
    privateRoot: join(root, "private"),
    token: "a".repeat(43),
    capacity: () => ({ bytes: 2 * 1024 ** 3, inodes: 10000 }),
  });
  cleanups.push(async () => store.close());
  return store;
}

it("limits standalone artifact methods before bearer, capability, store and body work despite forged forwarding headers", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const store = await transferStore();
  const stageReads = vi.spyOn(store, "getStage");
  const app = Fastify({ trustProxy: true });
  cleanups.push(() => app.close());
  let tokenReads = 0;
  let parsedBodies = 0;
  app.addHook("preParsing", async (_request, _reply, payload) => {
    parsedBodies++;
    return payload;
  });
  registerArtifactTransferRoutes(app, {
    store,
    get apiToken() {
      tokenReads++;
      return "a".repeat(43);
    },
  });
  const path = "/v1/artifact-transfers/123e4567-e89b-42d3-a456-426614174000/content";
  for (let index = 0; index < 6000; index++) {
    const response = await app.inject({
      method: (["GET", "HEAD", "PUT"] as const)[index % 3],
      url: path,
      headers: { "x-forwarded-for": `203.0.${Math.floor(index / 255)}.${index % 255}` },
    });
    expect(response.statusCode).toBe(401);
  }
  const before = tokenReads;
  for (const method of ["GET", "HEAD", "PUT"] as const) {
    const response = await app.inject({
      method,
      url: path,
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        "x-openmapx-artifact-capability": "invalid-capability",
        "x-forwarded-for": "198.51.100.254",
        ...(method === "PUT" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "PUT" ? { payload: "{" } : {}),
    });
    expect(response.statusCode).toBe(429);
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  }
  expect(tokenReads).toBe(before);
  expect(stageReads).not.toHaveBeenCalled();
  expect(parsedBodies).toBe(0);
  expect((await app.inject({ url: path, remoteAddress: "127.0.0.2" })).statusCode).toBe(401);
  vi.setSystemTime(Date.now() + 60000);
  expect((await app.inject({ url: path })).statusCode).toBe(401);
});

it("shares the actual server ingress budget across operations and artifact routes before authentication and JSON parsing", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const store = await transferStore();
  let tokenReads = 0;
  const app = buildOpsAgentServer({
    tokens: {
      get api() {
        tokenReads++;
        return "a".repeat(43);
      },
      "data-manager": "b".repeat(43),
    },
    artifactTransfers: store,
  });
  cleanups.push(() => app.close());
  for (let index = 0; index < 6000; index++) {
    const response = await app.inject({ method: "POST", url: "/v1/operations", payload: {} });
    expect(response.statusCode).toBe(401);
  }
  const before = tokenReads;
  const operation = await app.inject({
    method: "POST",
    url: "/v1/operations",
    headers: { authorization: `Bearer ${"a".repeat(43)}`, "content-type": "application/json" },
    payload: "{",
  });
  expect(operation.statusCode).toBe(429);
  expect(Number(operation.headers["retry-after"])).toBeGreaterThan(0);
  const authenticated = await app.inject({
    method: "POST",
    url: "/v1/operations",
    headers: { authorization: `Bearer ${"a".repeat(43)}` },
    payload: {},
  });
  expect(authenticated.statusCode).toBe(429);
  expect(tokenReads).toBe(before);
  const stream = await app.inject({
    url: "/v1/artifact-transfers/123e4567-e89b-42d3-a456-426614174000/content",
  });
  expect(stream.statusCode).toBe(429);
  expect(Number(stream.headers["retry-after"])).toBeGreaterThan(0);
  vi.setSystemTime(Date.now() + 60000);
  expect(
    (await app.inject({ method: "POST", url: "/v1/operations", payload: {} })).statusCode,
  ).toBe(401);
});
