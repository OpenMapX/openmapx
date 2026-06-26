import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockAdminSession } from "./admin-test-helpers.js";

const fakeSession = mockAdminSession();
vi.mock("../../utils/require-admin.js", () => ({
  requireAdmin: vi.fn().mockResolvedValue(fakeSession),
  getAdminSession: vi.fn().mockReturnValue(fakeSession),
  tryAdminSession: vi.fn().mockResolvedValue(fakeSession),
}));

const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("../../utils/audit-log.js", () => ({
  writeAuditLog: (...a: unknown[]) => mockWriteAuditLog(...a),
}));

vi.mock("../../utils/rate-limit.js", () => ({
  storeInstallLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
}));

const mockEnqueue = vi.fn().mockResolvedValue("job-ext-1");
vi.mock("../../services/job-runner.js", () => ({
  jobRunner: { enqueue: (...a: unknown[]) => mockEnqueue(...a) },
}));

vi.mock("@openmapx/core/server", () => ({
  services: {
    computeServiceSecurityRating: vi.fn().mockReturnValue({ score: 7 }),
    extensionComponentSummary: vi.fn().mockReturnValue([{ kind: "service", id: "oc-ingest" }]),
  },
}));

vi.mock("../../services/service-registry.js", () => ({
  getServiceRegistry: () => ({ get: () => null }),
}));

const ENTRY = {
  id: "openconditions",
  name: "OpenConditions",
  version: "1.0.0",
  trust: "verified" as const,
  minPlatform: "1.0",
  manifest: "https://example.com/openconditions/extension.json",
  services: [{ repo: "https://github.com/openconditions/openconditions", service: "oc-ingest" }],
};
const MANIFEST = {
  id: "openconditions",
  name: "OpenConditions",
  version: "1.0.0",
  services: [{ repo: "https://github.com/openconditions/openconditions", service: "oc-ingest" }],
};

const mockGetCatalog = vi.fn().mockResolvedValue([ENTRY]);
const mockGetEntry = vi.fn().mockResolvedValue(ENTRY);
const mockResolveManifest = vi.fn().mockResolvedValue(MANIFEST);
const emptyKill = { removed: new Map(), critical: new Map() };

vi.mock("../../services/extension-store.js", () => ({
  getExtensionCatalog: (...a: unknown[]) => mockGetCatalog(...a),
  getExtensionCatalogEntry: (...a: unknown[]) => mockGetEntry(...a),
  getKillSwitch: vi.fn().mockResolvedValue(emptyKill),
  resolveExtensionManifest: (...a: unknown[]) => mockResolveManifest(...a),
  isExtensionCompatible: vi.fn().mockReturnValue(true),
  listExtensionSources: vi.fn().mockResolvedValue([]),
  listInstalledExtensions: vi.fn().mockResolvedValue([]),
  addExtensionSource: vi.fn().mockResolvedValue(undefined),
  removeExtensionSource: vi.fn().mockResolvedValue(undefined),
  PLATFORM_VERSION: "1.0",
}));

let app: FastifyInstance;
beforeAll(async () => {
  const { adminExtensionsRoute } = await import("../admin-extensions.js");
  app = Fastify({ logger: false });
  await app.register(adminExtensionsRoute);
  await app.ready();
});
afterAll(() => app.close());
afterEach(() => vi.clearAllMocks());

describe("GET /admin/extensions/catalog", () => {
  it("returns entries with trust + compatibility", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/extensions/catalog" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.entries[0]).toMatchObject({
      id: "openconditions",
      trust: "verified",
      installed: false,
    });
  });
});

describe("POST /admin/extensions/install", () => {
  it("installs by catalog id and enqueues extension.install", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/extensions/install",
      payload: { id: "openconditions" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().jobId).toBe("job-ext-1");
    expect(mockEnqueue).toHaveBeenCalledWith(
      "extension.install",
      expect.objectContaining({ sourceTrust: "verified", manifest: MANIFEST }),
      fakeSession.user.id,
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "extension.install" }),
    );
  });

  it("rejects a request with neither id nor manifestUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/extensions/install",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /admin/extensions/:id", () => {
  it("enqueues extension.remove", async () => {
    const res = await app.inject({ method: "DELETE", url: "/admin/extensions/openconditions" });
    expect(res.statusCode).toBe(202);
    expect(mockEnqueue).toHaveBeenCalledWith(
      "extension.remove",
      expect.objectContaining({ id: "openconditions" }),
      fakeSession.user.id,
    );
  });
});
