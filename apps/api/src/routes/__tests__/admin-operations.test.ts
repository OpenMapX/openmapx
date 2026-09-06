import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminTestApp, installAdminRouteMocks } from "./admin-test-helpers.js";

const {
  session: fakeSession,
  requireAdmin: mockRequireAdmin,
  writeAuditLog: mockWriteAuditLog,
} = installAdminRouteMocks();

const mockJobRunnerEnqueue = vi.fn().mockResolvedValue("job-123");
vi.mock("../../services/job-runner.js", () => ({
  jobRunner: { enqueue: (...args: unknown[]) => mockJobRunnerEnqueue(...args) },
}));
vi.mock("@openmapx/core/server", () => ({
  findRepoRoot: () => "/repo",
}));
vi.mock("../../services/service-registry.js", () => ({
  getServiceRegistry: () => ({ list: () => [] }),
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { adminOperationsRoute } = await import("../admin-operations.js");
  app = await createAdminTestApp(adminOperationsRoute);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  mockJobRunnerEnqueue.mockClear();
  mockWriteAuditLog.mockClear();
});

describe("GET /admin/operations", () => {
  it("serves the browser contract without server-only members", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/operations" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { operations: Array<Record<string, unknown>> };
    expect(body.operations.map((operation) => operation.id)).toContain("search-index-build");
    for (const operation of body.operations) {
      expect(operation).not.toHaveProperty("effect");
      expect(operation).not.toHaveProperty("input");
      expect(Array.isArray(operation.fields)).toBe(true);
    }
  });

  it("rejects unauthenticated requests", async () => {
    mockRequireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );
    const res = await app.inject({ method: "GET", url: "/admin/operations" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /admin/operations/:id/preview", () => {
  it("returns normalized input and preview lines without side effects", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/operations/update/preview",
      payload: { region: " europe/germany ", countries: "de, at", failFast: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      input: { region: "europe/germany", countries: ["DE", "AT"], failFast: true },
      preview: [
        "Update OSM data and dependent builds for europe/germany",
        "Limit transit imports to DE, AT",
        "Stop at the first failing step",
      ],
      risk: "normal",
    });
    expect(mockJobRunnerEnqueue).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("includes confirmation copy for destructive operations", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/operations/clean/preview",
      payload: { target: "osm" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { risk: string; confirmation?: { title: string } };
    expect(body.risk).toBe("destructive");
    expect(body.confirmation?.title).toBe("Confirm data cleanup");
  });

  it("reports validation issues with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/operations/search-index-build/preview",
      payload: { region: "../etc" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: string; issues: unknown[] };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/region/);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("returns 404 for unknown operations", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/operations/rm-rf/preview",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /admin/operations/:id/run", () => {
  it("enqueues and audits a search-index build", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/operations/search-index-build/run",
      payload: { region: "europe/germany" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, jobId: "job-123" });
    expect(mockJobRunnerEnqueue).toHaveBeenCalledWith(
      "data.operation",
      { operation: "search-index-build", version: 1, input: { region: "europe/germany" } },
      fakeSession.user.id,
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: "data",
        targetId: "search-index-build",
        action: "data.search-index-build",
        details: { region: "europe/germany" },
      }),
    );
  });

  it("rejects caller URL/output/argv/environment before fixed API-key generation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/operations/generate-api-keys/run",
      payload: {
        repoUrl: "https://attacker.example/catalog.git",
        output: "/etc/passwd",
        argv: ["--output", "/etc/passwd"],
        environment: { NODE_OPTIONS: "--require=/tmp/payload" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(mockJobRunnerEnqueue).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("rejects operation-inapplicable fields before enqueue", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/operations/download-fonts/run",
      payload: { region: "europe/germany" },
    });
    expect(response.statusCode).toBe(400);
    expect(mockJobRunnerEnqueue).not.toHaveBeenCalled();
  });

  it("accepts an empty body for parameterless operations", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/operations/link/run",
    });
    expect(response.statusCode).toBe(200);
    expect(mockJobRunnerEnqueue).toHaveBeenCalledWith(
      "data.operation",
      { operation: "link", version: 1, input: {} },
      fakeSession.user.id,
    );
  });

  it("returns 404 for unknown operations", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/operations/rm-rf/run",
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(mockJobRunnerEnqueue).not.toHaveBeenCalled();
  });
});
