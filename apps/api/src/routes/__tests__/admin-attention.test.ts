import type { AttentionItem } from "@openmapx/core/api-contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { acknowledgeAttention, listAttention } from "../../services/attention";
import { installAdminRouteMocks } from "./admin-test-helpers";

const {
  session: fakeSession,
  requireAdmin: mockRequireAdmin,
  writeAuditLog,
} = installAdminRouteMocks();

vi.mock("../../services/attention.js", () => ({
  listAttention: vi.fn(async () => []),
  acknowledgeAttention: vi.fn(async () => false),
}));
vi.mock("../../db/index.js", () => ({ db: {} }));
// The administration plugin registers these families too; they are tested on their own.
vi.mock("../admin-overview.js", () => ({ adminOverviewRoute: async () => {} }));
vi.mock("../admin-integrations.js", () => ({ adminIntegrationsRoute: async () => {} }));
vi.mock("../admin-integration-credentials.js", () => ({
  adminIntegrationCredentialsRoute: async () => {},
}));

const item: AttentionItem = {
  key: "storage-low:data",
  severity: "warning",
  source: "operations",
  title: "Disk space low (data)",
  detail: "Less than 10 % of the data volume is free.",
  action: { label: "Open", href: "/admin/system/storage" },
  clearance: "condition",
  acknowledgedAt: null,
  raisedAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z",
};

let app: FastifyInstance;

beforeAll(async () => {
  const { adminRoute } = await import("../admin.js");
  app = Fastify({ logger: false });
  await app.register(adminRoute, { prefix: "/api" });
  await app.ready();
});
afterAll(() => app?.close());
afterEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockReset().mockResolvedValue(fakeSession);
});

const adminRequest = (method: "GET" | "POST", url: string) => app.inject({ method, url });
const deniedRequest = (statusCode: 401 | 403) => (method: "GET" | "POST", url: string) => {
  mockRequireAdmin.mockRejectedValueOnce(Object.assign(Error("Denied"), { statusCode }));
  return app.inject({ method, url });
};
const userRequest = deniedRequest(403);
const anonymousRequest = deniedRequest(401);

describe("admin attention routes", () => {
  it("lists stored items to an administrator and refuses others", async () => {
    vi.mocked(listAttention).mockResolvedValue([item]);
    expect((await adminRequest("GET", "/api/admin/attention")).json()).toEqual({ items: [item] });
    expect((await userRequest("GET", "/api/admin/attention")).statusCode).toBe(403);
    expect((await anonymousRequest("GET", "/api/admin/attention")).statusCode).toBe(401);
  });

  it("acknowledges a stored item, audits it, and answers 404 for an unknown key", async () => {
    vi.mocked(acknowledgeAttention).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const done = await adminRequest("POST", "/api/admin/attention/storage-low:data/acknowledge");
    expect(done.statusCode).toBe(204);
    expect(done.body).toBe("");
    expect(acknowledgeAttention).toHaveBeenCalledWith("storage-low:data");
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "attention.acknowledge",
        targetId: "storage-low:data",
        actorId: fakeSession.user.id,
      }),
    );
    expect(
      (await adminRequest("POST", "/api/admin/attention/never.raised/acknowledge")).statusCode,
    ).toBe(404);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(
      (await adminRequest("POST", "/api/admin/attention/Has%20Spaces/acknowledge")).statusCode,
    ).toBe(400);
    expect(
      (await userRequest("POST", "/api/admin/attention/storage-low:data/acknowledge")).statusCode,
    ).toBe(403);
    expect(acknowledgeAttention).toHaveBeenCalledTimes(2);
  });
});
