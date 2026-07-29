import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockAdminSession } from "./admin-test-helpers";

const session = mockAdminSession();
const requireAdmin = vi.fn().mockResolvedValue(session);
const enqueue = vi.fn().mockResolvedValue("job-system-1");
const findActive = vi.fn().mockResolvedValue(null);
const audit = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs", () => ({ existsSync: vi.fn().mockReturnValue(true) }));
vi.mock("@openmapx/core/server", () => ({
  repoPaths: () => ({ composeOutPath: "/repo/docker-compose.generated.yml" }),
}));
vi.mock("../../utils/require-admin", () => ({
  requireAdmin: (...args: unknown[]) => requireAdmin(...args),
  getAdminSession: () => session,
}));
vi.mock("../../utils/audit-log", () => ({
  writeAuditLog: (...args: unknown[]) => audit(...args),
}));
vi.mock("../../utils/rate-limit", () => ({
  systemMaintenanceLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../services/admin-ops", () => ({ isDockerAvailable: vi.fn().mockResolvedValue(true) }));
vi.mock("../../services/system-maintenance", () => ({
  getCoreImageStatuses: vi.fn().mockResolvedValue([
    {
      id: "app-api",
      name: "OpenMapX API",
      image: "ghcr.io/openmapx/api:latest",
      containerState: "running",
      runningImageId: "old",
      localImageId: "new",
      updateAvailable: true,
      status: "update-available",
    },
  ]),
}));
vi.mock("../../services/job-runner", () => ({
  jobRunner: {
    enqueue: (...args: unknown[]) => enqueue(...args),
    findActive: (...args: unknown[]) => findActive(...args),
  },
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { adminSystemRoute } = await import("../admin-system");
  app = Fastify({ logger: false });
  await app.register(adminSystemRoute);
  await app.ready();
});

afterAll(() => app.close());
afterEach(() => {
  enqueue.mockClear();
  findActive.mockReset().mockResolvedValue(null);
  audit.mockClear();
});

describe("admin system routes", () => {
  it("returns host readiness and core image state", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/system" });
    expect(response.statusCode).toBe(200);
    expect(response.json().deployment.maintenanceReady).toBe(true);
    expect(response.json().images[0].updateAvailable).toBe(true);
  });

  it("requires an exact confirmation phrase before updating", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/system/updates/apply",
      payload: { confirmation: "update" },
    });
    expect(response.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("queues and audits a backup-first update", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/system/updates/apply",
      payload: { confirmation: "UPDATE OPENMAPX", createBackup: true },
    });
    expect(response.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(
      "system.update",
      { operation: "apply", createBackup: true },
      session.user.id,
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "system.update.apply" }));
  });

  it("allows an operator to skip the optional backup", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/system/updates/apply",
      payload: { confirmation: "UPDATE OPENMAPX", createBackup: false },
    });
    expect(response.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(
      "system.update",
      { operation: "apply", createBackup: false },
      session.user.id,
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "system.update.apply",
        details: { createBackup: false },
      }),
    );
  });

  it("rejects concurrent update operations", async () => {
    findActive.mockResolvedValueOnce({ id: "already-running", status: "running" });
    const response = await app.inject({
      method: "POST",
      url: "/admin/system/updates/check",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().jobId).toBe("already-running");
  });

  it("rejects updates while another host-mutating job is active", async () => {
    findActive.mockImplementation(async (type: string) =>
      type === "backup.operation" ? { id: "backup-running", status: "running" } : null,
    );
    const response = await app.inject({
      method: "POST",
      url: "/admin/system/updates/apply",
      payload: { confirmation: "UPDATE OPENMAPX", createBackup: false },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().jobId).toBe("backup-running");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
