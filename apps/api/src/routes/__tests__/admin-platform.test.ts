import { randomUUID } from "node:crypto";
import { createApiClient } from "@openmapx/core";
import {
  getAdminPlatformConfiguration,
  previewAdminPlatformConfiguration,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import { services } from "@openmapx/core/server";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockAdminSession } from "../../test/auth";

const mocks = vi.hoisted(() => ({
  session: null as unknown,
  inspect: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
}));
vi.mock("../../auth", () => ({ auth: { api: { getSession: async () => mocks.session } } }));
vi.mock("../../services/platform-configuration-view", () => ({
  inspectPlatformConfiguration: mocks.inspect,
  previewPlatformConfiguration: mocks.preview,
}));
vi.mock("../../services/job-runner", () => ({
  jobRunner: { startPlatformConfiguration: mocks.apply },
}));

import { adminPlatformRoute } from "../admin-platform";

let app: FastifyInstance;
let client: ReturnType<typeof createApiClient>;
const request = { expectedCurrentRevisionId: null, changes: { version: 1 as const } };
let preview: ReturnType<typeof services.buildPlatformConfigurationPreview>;
beforeEach(async () => {
  vi.stubEnv("OPENMAPX_DISABLE_LOCALHOST_AUTH", "1");
  vi.clearAllMocks();
  mocks.session = mockAdminSession();
  preview = services.buildPlatformConfigurationPreview({
    actorId: "test-admin-id",
    previewId: randomUUID(),
    authPolicyRevision: "a".repeat(64),
    sourceRevision: randomUUID(),
    currentRevisionId: null,
    expectedCurrentRevisionId: null,
    changes: { version: 1 },
    env: {},
    services: [],
  });
  mocks.inspect.mockResolvedValue({
    expectedCurrentRevisionId: null,
    configuration: { version: 1 },
    values: preview.values,
    sources: preview.sources,
  });
  mocks.preview.mockResolvedValue({
    preview,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  mocks.apply.mockResolvedValue({ ok: true, jobId: randomUUID() });
  app = Fastify();
  await app.register(adminPlatformRoute, { prefix: "/api" });
  client = createApiClient({ baseUrl: await app.listen({ host: "127.0.0.1", port: 0 }) });
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});
it("serves an administrator's effective configuration and retains a reviewed preview", async () => {
  expect(unwrapAdminResponse(await getAdminPlatformConfiguration({ client }))).toMatchObject({
    values: preview.values,
  });
  expect(
    unwrapAdminResponse(
      await previewAdminPlatformConfiguration(
        request,
        { "idempotency-key": "platform-preview-sdk-01" },
        { client },
      ),
    ),
  ).toMatchObject({ preview });
  const current = await app.inject({ url: "/api/admin/platform/configuration" });
  expect(current.statusCode).toBe(200);
  expect(current.json()).toMatchObject({ configuration: { version: 1 }, values: preview.values });
  expect(current.headers["cache-control"]).toBe("private, no-store");
  const result = await app.inject({
    method: "POST",
    url: "/api/admin/platform/configuration/preview",
    headers: { "idempotency-key": "platform-preview-key-01" },
    payload: request,
  });
  expect(result.statusCode).toBe(200);
  expect(result.json().preview.previewFingerprint).toBe(preview.previewFingerprint);
  expect(mocks.preview).toHaveBeenCalledWith(
    expect.objectContaining({ actorId: "test-admin-id", ...request }),
  );
});
it.each([
  null,
  { ...mockAdminSession(), user: { ...mockAdminSession().user, role: "support_admin" } },
])("requires the actual full-administrator guard", async (session) => {
  mocks.session = session;
  const result = await app.inject({ url: "/api/admin/platform/configuration" });
  expect(result.statusCode).toBe(session ? 403 : 401);
  expect(mocks.inspect).not.toHaveBeenCalled();
});
it.each(["loopback", "impersonated"])("refuses %s preview authority", async (kind) => {
  const actor = mockAdminSession();
  if (kind === "loopback") actor.user.id = "loopback";
  else actor.session.impersonatedBy = "other";
  mocks.session = actor;
  const result = await app.inject({
    method: "POST",
    url: "/api/admin/platform/configuration/preview",
    headers: { "idempotency-key": "platform-preview-key-01" },
    payload: request,
  });
  expect(result.statusCode).toBe(403);
  expect(mocks.preview).not.toHaveBeenCalled();
});
it("rejects unknown input and missing mutation identity before invoking a producer", async () => {
  for (const payload of [request, { ...request, changes: { version: 1, arbitrary: true } }]) {
    const result = await app.inject({
      method: "POST",
      url: "/api/admin/platform/configuration/preview",
      ...(payload === request ? {} : { headers: { "idempotency-key": "platform-preview-key-01" } }),
      payload,
    });
    expect(result.statusCode).toBe(400);
  }
  expect(mocks.preview).not.toHaveBeenCalled();
});
it("keeps host failure details out of public responses", async () => {
  mocks.inspect.mockRejectedValue(Error("/private/host/path secret-value"));
  const result = await app.inject({ url: "/api/admin/platform/configuration" });
  expect(result.statusCode).toBe(503);
  expect(result.body).not.toContain("secret-value");
  expect(result.body).not.toContain("/private");
});
