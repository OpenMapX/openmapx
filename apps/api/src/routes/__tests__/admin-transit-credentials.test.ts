import { randomUUID } from "node:crypto";
import { createApiClient } from "@openmapx/core";
import {
  applyAdminTransitCredentials,
  getAdminTransitCredentials,
  previewAdminTransitCredentials,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockAdminSession } from "../../test/auth";

const mocks = vi.hoisted(() => ({
  session: null as unknown,
  inspect: vi.fn(),
  preview: vi.fn(),
  bind: vi.fn(),
  apply: vi.fn(),
}));
vi.mock("../../auth", () => ({ auth: { api: { getSession: async () => mocks.session } } }));
vi.mock("../../services/transit-feed-credentials", () => ({
  inspectFeedCredentials: mocks.inspect,
  previewFeedCredentialChanges: mocks.preview,
}));
vi.mock("../../services/transit-credential-authorization", () => ({
  bindTransitCredentialAuthorization: mocks.bind,
}));
vi.mock("../../services/job-runner", () => ({
  jobRunner: { applyImmediateTransitCredentials: mocks.apply },
}));
vi.mock("../../services/ops-client", () => ({
  createApiOpsClient: () => ({}),
  createDurableOpsKey: () => `opk1_${"a".repeat(32)}`,
  executeAndWait: async () => ({ catalogRevisionId: "a".repeat(64) }),
}));

import { ADMIN_REAUTH_COOKIE_NAME } from "../../account/admin-reauthentication";
import { TransitCredentialConflict } from "../../services/transit-credential-preview";
import { adminTransitCredentialsRoute } from "../admin-transit-credentials";

let app: FastifyInstance, client: ReturnType<typeof createApiClient>;
const body = () => ({
  catalogRevisionId: "a".repeat(64),
  expectedCredentialsRevision: "b".repeat(64),
  expectedCurrentRevisionId: null,
  operationKey: `opk1_${"c".repeat(32)}`,
  changes: [{ key: "de/A", action: "set" as const, value: "private-input" }],
});
beforeEach(async () => {
  vi.stubEnv("OPENMAPX_DISABLE_LOCALHOST_AUTH", "1");
  vi.clearAllMocks();
  mocks.session = mockAdminSession();
  mocks.inspect.mockResolvedValue({
    catalogRevisionId: "a".repeat(64),
    credentialsRevision: "b".repeat(64),
    configurationRevisionId: null,
    owner: "unset",
    editable: true,
    reason: null,
    appliedCredentialsRevision: null,
    pendingApplication: false,
    entries: [{ key: "de/A", required: true, configured: false, orphaned: false }],
  });
  mocks.preview.mockResolvedValue({
    previewId: randomUUID(),
    intentFingerprint: "d".repeat(64),
    catalogRevisionId: "a".repeat(64),
    credentialsRevision: "b".repeat(64),
    expectedCurrentRevisionId: null,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    changes: [{ key: "de/A", action: "set" }],
    preservedCount: 1,
    mapBytes: 24,
  });
  mocks.bind.mockResolvedValue(undefined);
  mocks.apply.mockResolvedValue({
    credentialsRevision: "e".repeat(64),
    configuration: {
      outcome: "committed",
      revisionId: `cfg1_${"f".repeat(43)}`,
      enabledServiceIds: ["data-manager"],
      followUp: "complete",
      cleanupFailed: false,
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
    },
  });
  app = Fastify();
  await app.register(adminTransitCredentialsRoute, { prefix: "/api" });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  client = createApiClient({ baseUrl });
});
afterEach(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});
it("uses the generated SDK over real HTTP and serializes only masked metadata and reviewed key actions", async () => {
  expect(unwrapAdminResponse(await getAdminTransitCredentials({ client }))).toMatchObject({
    configurationRevisionId: null,
    owner: "unset",
  });
  const preview = unwrapAdminResponse(await previewAdminTransitCredentials(body(), { client }));
  expect(JSON.stringify(preview)).not.toContain("private-input");
  expect(mocks.preview).toHaveBeenCalledWith(
    expect.objectContaining({ actorId: "test-admin-id", changes: body().changes }),
  );
  const response = await applyAdminTransitCredentials(
    {
      previewId: preview.previewId,
      intentFingerprint: preview.intentFingerprint,
      operationKey: body().operationKey,
      transitProofToken: randomUUID(),
    },
    {
      client,
      headers: {
        cookie: `${ADMIN_REAUTH_COOKIE_NAME}=${Buffer.alloc(32, 9).toString("base64url")}`,
      },
    },
  );
  expect(unwrapAdminResponse(response)).toMatchObject({ credentialsRevision: "e".repeat(64) });
  expect(mocks.bind).toHaveBeenCalledWith(
    expect.objectContaining({ actorId: "test-admin-id", sessionId: "test-session-id" }),
  );
  expect(mocks.apply).toHaveBeenCalledOnce();
});
it.each([
  null,
  { ...mockAdminSession(), user: { ...mockAdminSession().user, role: "support_admin" } },
])("enforces the actual full-admin guard before credential reads or writes", async (session) => {
  mocks.session = session;
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/transit/credentials/preview",
    payload: body(),
  });
  expect(response.statusCode).toBe(session ? 403 : 401);
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.inspect).not.toHaveBeenCalled();
});
it.each(["impersonated", "loopback"])("refuses mutation from %s authority", async (mode) => {
  const session = mockAdminSession();
  if (mode === "loopback") session.user.id = "loopback";
  else session.session.impersonatedBy = "another-admin";
  mocks.session = session;
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/admin/transit/credentials/preview",
        payload: body(),
      })
    ).statusCode,
  ).toBe(403);
  expect(mocks.preview).not.toHaveBeenCalled();
});
it("rejects substitution fields and missing nonce before binding or applying", async () => {
  const input = {
    previewId: randomUUID(),
    intentFingerprint: "d".repeat(64),
    operationKey: body().operationKey,
    transitProofToken: randomUUID(),
  };
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/admin/transit/credentials",
        payload: { ...input, changes: body().changes },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await app.inject({ method: "PATCH", url: "/api/admin/transit/credentials", payload: input }))
      .statusCode,
  ).toBe(409);
  expect(mocks.bind).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
});
it("returns sanitized conflicts and failures with no-store headers", async () => {
  mocks.preview.mockRejectedValueOnce(new TransitCredentialConflict());
  let response = await app.inject({
    method: "POST",
    url: "/api/admin/transit/credentials/preview",
    payload: body(),
  });
  expect(response.statusCode).toBe(409);
  expect(response.headers["cache-control"]).toContain("no-store");
  mocks.preview.mockRejectedValueOnce(Error("private-input /private/host/path"));
  response = await app.inject({
    method: "POST",
    url: "/api/admin/transit/credentials/preview",
    payload: body(),
  });
  expect(response.statusCode).toBe(503);
  expect(response.body).not.toContain("private-input");
  expect(response.body).not.toContain("/private/");
});
it("bounds the actual parser and shared per-admin mutation rate", async () => {
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/admin/transit/credentials/preview",
        payload: {
          ...body(),
          changes: [{ key: "de/A", action: "set", value: "x".repeat(1024 * 1024) }],
        },
      })
    ).statusCode,
  ).toBe(413);
  for (let i = 0; i < 12; i++)
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/transit/credentials/preview",
          payload: body(),
        })
      ).statusCode,
    ).toBe(200);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/admin/transit/credentials/preview",
        payload: body(),
      })
    ).statusCode,
  ).toBe(429);
});
