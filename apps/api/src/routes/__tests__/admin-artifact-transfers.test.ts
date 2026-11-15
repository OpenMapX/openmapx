import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cors from "@fastify/cors";
import { createApiClient } from "@openmapx/core";
import {
  createAdminArtifactTransfer,
  downloadAdminArtifactTransferContent,
  getAdminArtifactTransfer,
  listAdminArtifactTransfers,
  uploadAdminArtifactTransferContent,
} from "@openmapx/core/api-admin-sdk";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { installArtifactTransferRuntime } from "../../../../ops-agent/src/artifact-transfer/runtime";
import { ArtifactTransferStore } from "../../../../ops-agent/src/artifact-transfer/store";
import { createUnavailableRuntime } from "../../../../ops-agent/src/runtime";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import { corsOptions } from "../../server-wiring";
import { adminArtifactTransfersRoute } from "../admin-artifact-transfers";

// Authentication storage only is synthetic. Actual full-admin/session-owner guard and both HTTP brokers run unchanged.
vi.mock("../../auth", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const who = headers.get("x-fixture-session");
        return who
          ? { user: { id: who, role: who === "member" ? "user" : "admin" }, session: { id: who } }
          : null;
      },
    },
  },
}));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
it("generated SDK streams through real admin/API and typed/raw agent paths, enforcing owner, CSRF and media", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-admin-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const token = "a".repeat(43);
  const tokenFile = join(root, "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const store = new ArtifactTransferStore({
    dataRoot: join(root, "data"),
    privateRoot: join(root, "private"),
    token,
    capacity: () => ({ bytes: 2 * 1024 ** 3, inodes: 10000 }),
  });
  const runtime = createUnavailableRuntime();
  installArtifactTransferRuntime(runtime, store);
  const audit: unknown[] = [];
  const agent = buildOpsAgentServer({
    audit: (event) => audit.push(event),
    tokens: { api: token, "data-manager": "b".repeat(43) },
    runtime,
    artifactTransfers: store,
    resourcePolicy: { allowGlobal: () => true },
  });
  cleanups.push(async () => {
    await agent.close();
    store.close();
  });
  const agentUrl = await agent.listen({ host: "127.0.0.1", port: 0 });
  vi.stubEnv("OPS_AGENT_URL", agentUrl);
  vi.stubEnv("OPS_AGENT_TOKEN_FILE", tokenFile);
  vi.stubEnv("OPENMAPX_DISABLE_LOCALHOST_AUTH", "1");
  const app = Fastify();
  await app.register(cors, corsOptions(["https://web.example"]));
  await app.register(adminArtifactTransfersRoute, { prefix: "/api" });
  cleanups.push(() => app.close());
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = createApiClient({
    baseUrl: url,
    credentials: "omit",
    headerInterceptor: () => ({ "x-fixture-session": "admin", Origin: "https://web.example" }),
  });
  const bytes = new Uint8Array([0, 255, 192, 128]);
  const result = await createAdminArtifactTransfer(
    { purpose: "prepared-artifact", direction: "upload", declaredBytes: 4 },
    { "idempotency-key": "binary-test" },
    { client },
  );
  expect(result.status, JSON.stringify({ result: result.data, audit })).toBe(200);
  if (result.status !== 200) throw Error("No stage");
  const stage = result.data;
  const uploaded = await uploadAdminArtifactTransferContent(
    stage.stageId,
    new Blob([bytes], { type: "text/plain" }),
    { client },
  );
  expect(uploaded.status).toBe(200);
  expect(uploaded.headers.get("access-control-allow-origin")).toBe("https://web.example");
  expect(uploaded.headers.get("access-control-expose-headers")).toContain("X-Artifact-Sha256");
  if (uploaded.status !== 200) throw Error("No upload");
  expect(uploaded.data).toMatchObject({
    bytes: 4,
    state: "uploaded",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect((await getAdminArtifactTransfer(stage.stageId, { client })).status).toBe(200);
  const other = createApiClient({
    baseUrl: url,
    headerInterceptor: () => ({ "x-fixture-session": "other" }),
  });
  expect((await getAdminArtifactTransfer(stage.stageId, { client: other })).status).toBe(404);
  const noSession = await fetch(`${url}/api/admin/artifact-transfers`);
  expect(noSession.status).toBe(401);
  const member = await fetch(`${url}/api/admin/artifact-transfers`, {
    headers: { "x-fixture-session": "member" },
  });
  expect(member.status).toBe(403);
  expect(
    (
      await fetch(`${url}/api/admin/artifact-transfers/${stage.stageId}/content`, {
        method: "PUT",
        headers: {
          "x-fixture-session": "admin",
          cookie: "session=x",
          origin: "https://foreign.invalid",
          "content-type": "application/octet-stream",
        },
        body: bytes,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${url}/api/admin/artifact-transfers/${stage.stageId}/content`, {
        method: "PUT",
        headers: { "x-fixture-session": "admin", "content-type": "text/plain" },
        body: bytes,
      })
    ).status,
  ).toBe(415);
  expect((await listAdminArtifactTransfers({ limit: 50, offset: 0 }, { client })).status).toBe(200);
  let callbacks = 0;
  const premature = await downloadAdminArtifactTransferContent(stage.stageId, {
    client,
    onByteChunk: () => {
      callbacks++;
    },
  });
  expect(premature.status).toBe(409);
  expect(callbacks).toBe(0);
}, 30000);

it("canonical byte-send adapter and generated download preserve non-UTF8 EOF and headers", async () => {
  const { createAdminRouteRegistrar } = await import("../admin-contract");
  const { sendAdminByteResponse } = await import("../admin-byte-response");
  const { artifactTransferAdminOperations } = await import("@openmapx/core/api-contracts");
  const app = Fastify();
  cleanups.push(() => app.close());
  let canceled = false;
  await app.register(
    async (scoped) => {
      const register = createAdminRouteRegistrar(artifactTransferAdminOperations, {
        tag: "service-admin",
        validationPhase: "preHandler",
      });
      register(scoped, "downloadAdminArtifactTransferContent", async (_req, reply) => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([0, 255, 192, 128]));
            c.close();
          },
          cancel() {
            canceled = true;
          },
        });
        await sendAdminByteResponse(reply, {
          body,
          signal: new AbortController().signal,
          headers: new Headers({
            "content-type": "application/octet-stream",
            "content-length": "4",
            "content-disposition": 'attachment; filename="openmapx-artifact.tar"',
            "x-artifact-sha256": "a".repeat(64),
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          }),
        });
      });
    },
    { prefix: "/api" },
  );
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = createApiClient({ baseUrl: url, credentials: "omit" });
  const bytes: number[] = [];
  const result = await downloadAdminArtifactTransferContent(
    "91a78b3e-208b-4ba4-9ddf-870fbdf1da22",
    {
      client,
      onByteChunk: (chunk) => {
        bytes.push(...chunk);
      },
    },
  );
  expect(result.status).toBe(200);
  expect(result.data).toBeUndefined();
  expect(bytes).toEqual([0, 255, 192, 128]);
  expect(canceled).toBe(false);
});
