import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createAdminTestApp, installAdminRouteMocks } from "./admin-test-helpers";

const auth = installAdminRouteMocks();
const mocks = vi.hoisted(() => ({ enqueue: vi.fn(async () => "prune-job"), preview: vi.fn() }));
vi.mock("../../services/job-runner", () => ({ jobRunner: { enqueueMaintenance: mocks.enqueue } }));
vi.mock("../../services/ops-client", () => ({
  createApiOpsClient: () => ({}),
  executeAndWait: mocks.preview,
  createDurableOpsKey: () => "opk1_prunePreview001",
}));
const proof = {
    inventoryDigest: "a".repeat(64),
    policyRevision: "b".repeat(64),
    previewedAt: "2026-10-30T10:00:00.000Z",
    expiresAt: "2026-10-30T10:15:00.000Z",
    authenticator: "c".repeat(64),
  },
  key = { "idempotency-key": "backup-prune-retained-intent-001" },
  body = { proof, confirmation: "PRUNE EXPIRED BACKUPS" };
let app: FastifyInstance;
beforeAll(async () => {
  const { adminBackupMaintenanceRoute } = await import("../admin-backup-maintenance");
  app = await createAdminTestApp(adminBackupMaintenanceRoute, { prefix: "/api" });
});
afterAll(() => app?.close());
afterEach(() => vi.clearAllMocks());
it("serializes a read-only preview without host paths or enqueuing a mutation", async () => {
  mocks.preview.mockResolvedValueOnce({
    proof,
    cutoff: "2026-09-30T10:00:00.000Z",
    retentionDays: 30,
    policySource: "host",
    candidates: [],
    retainedCount: 2,
    corruptBackups: [],
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/services/backups/prune/preview",
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ proof, retainedCount: 2 });
  expect(response.body).not.toContain("privateHostPath");
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it("retains the exact proof, confirmation and actor key for the queued mutation", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/services/backups/prune",
    headers: key,
    payload: body,
  });
  expect(response.statusCode).toBe(202);
  expect(mocks.enqueue).toHaveBeenCalledWith(
    "backup.prune",
    body,
    auth.getAdminSession.mock.results.at(-1)?.value.user.id,
    key["idempotency-key"],
  );
});
it.each([
  { ...body, confirmation: "yes" },
  { ...body, directory: "/caller/path" },
  { ...body, proof: { ...proof, inventoryDigest: "invalid" } },
  {},
])("rejects invalid prune input %j without a job", async (payload) => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/services/backups/prune",
    headers: key,
    payload,
  });
  expect(response.statusCode).toBe(400);
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it("requires a retained key and administrator session", async () => {
  expect(
    (await app.inject({ method: "POST", url: "/api/admin/services/backups/prune", payload: body }))
      .statusCode,
  ).toBe(400);
  auth.requireAdmin.mockRejectedValueOnce(
    Object.assign(Error("Administrator required"), { statusCode: 403 }),
  );
  expect(
    (await app.inject({ method: "POST", url: "/api/admin/services/backups/prune/preview" }))
      .statusCode,
  ).toBe(403);
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
