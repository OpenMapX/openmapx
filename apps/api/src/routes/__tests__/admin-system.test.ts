import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockAdminSession } from "../../test/auth.js";

const session = mockAdminSession();
const requireAdmin = vi.fn().mockResolvedValue(session);
const enqueue = vi.fn().mockResolvedValue("job-system-1");
const findActive = vi.fn().mockResolvedValue(null);
const audit = vi.fn().mockResolvedValue(undefined);
const systemInspection = {
  dockerReachable: true,
  composeReady: true,
  maintenanceReady: true,
  release: { currentReleaseId: "release-old", availableReleaseId: "release-123" },
  services: [
    {
      serviceId: "app-api",
      containerState: "running",
      pinnedImage: `ghcr.io/openmapx/api@sha256:${"a".repeat(64)}`,
      runningImageId: `sha256:${"b".repeat(64)}`,
      localImageId: `sha256:${"a".repeat(64)}`,
      releaseMember: true,
      state: "update_available",
    },
  ],
};
const executeAndWait = vi.fn(
  async (_client: unknown, _operation: { kind: string }) => systemInspection,
);
const opsClient = {};

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
vi.mock("../../services/ops-client", () => ({
  createApiOpsClient: () => opsClient,
  createDurableOpsKey: () => `opk1_${"a".repeat(43)}`,
  executeAndWait: (client: unknown, operation: { kind: string }) =>
    executeAndWait(client, operation),
}));
vi.mock("../../services/system-maintenance", () => ({
  getCoreImageStatuses: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../services/admin-ops", () => ({ isDockerAvailable: vi.fn().mockResolvedValue(true) }));
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
  it.each([
    ["/admin/system/updates/check", { image: "attacker/image:latest" }],
    ["/admin/system/diagnostics", { argv: ["--host", "/"] }],
    [
      "/admin/system/updates/apply",
      { confirmation: "UPDATE OPENMAPX", createBackup: true, container: "app-api" },
    ],
  ])("rejects forbidden effect fields on %s before enqueue", async (url, payload) => {
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("returns host readiness and core image state", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/system" });
    expect(response.statusCode).toBe(200);
    expect(response.json().deployment.maintenanceReady).toBe(true);
    expect(response.json().images[0]).toEqual({
      id: "app-api",
      name: "app-api",
      image: systemInspection.services[0].pinnedImage,
      containerState: "running",
      runningImageId: systemInspection.services[0].runningImageId,
      localImageId: systemInspection.services[0].localImageId,
      updateAvailable: true,
      releaseMember: true,
      status: "update-available",
    });
    expect(response.json().release).toEqual({
      currentReleaseId: "release-old",
      availableReleaseId: "release-123",
    });
    expect(executeAndWait.mock.calls.map((call) => (call[1] as { kind: string }).kind)).toEqual([
      "system.inspect",
    ]);
  });

  it.each([
    ["current", "up-to-date", false],
    ["update_available", "update-available", true],
    ["not_running", "not-running", false],
    ["unknown", "unknown", false],
  ] as const)(
    "projects the agent-owned %s state without inventing success",
    async (state, status, updateAvailable) => {
      executeAndWait.mockResolvedValueOnce({
        ...systemInspection,
        services: [
          {
            ...systemInspection.services[0],
            state,
            ...(state === "not_running" || state === "unknown"
              ? { runningImageId: undefined }
              : {}),
            ...(state === "unknown" ? { localImageId: undefined } : {}),
          },
        ],
      });
      const response = await app.inject({ method: "GET", url: "/admin/system" });
      expect(response.statusCode).toBe(200);
      expect(response.json().images[0]).toMatchObject({ status, updateAvailable });
    },
  );

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
