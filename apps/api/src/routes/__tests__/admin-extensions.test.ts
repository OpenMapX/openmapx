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
  manifest:
    "https://fixture-user:fixture-pass@extensions.example.test/private/extension.json?token=fixture-extension-token#fixture-fragment",
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
const emptyKill = { removed: new Map(), critical: new Map(), stale: false };
const mockKillSwitch = vi.fn().mockResolvedValue(emptyKill);

vi.mock("../../services/extension-store.js", () => ({
  getExtensionCatalog: (...a: unknown[]) => mockGetCatalog(...a),
  getExtensionCatalogEntry: (...a: unknown[]) => mockGetEntry(...a),
  getKillSwitch: (...a: unknown[]) => mockKillSwitch(...a),
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
      status: "verified",
    });
    expect(body.revocationDataStale).toBe(false);
  });

  it("reports a revoked entry as revoked whatever tier it came from", async () => {
    mockKillSwitch.mockResolvedValueOnce({
      removed: new Map([["openconditions", "delisted"]]),
      critical: new Map(),
      stale: false,
    });
    const res = await app.inject({ method: "GET", url: "/admin/extensions/catalog" });
    expect(res.json().entries[0]).toMatchObject({ status: "revoked", trust: "verified" });
  });

  it("distinguishes an unrefreshable revocation feed from nothing being revoked", async () => {
    mockKillSwitch.mockResolvedValueOnce({
      removed: new Map(),
      critical: new Map(),
      stale: true,
    });
    const res = await app.inject({ method: "GET", url: "/admin/extensions/catalog" });
    const body = res.json();
    expect(body.entries[0]).toMatchObject({ status: "stale-revocation-data" });
    expect(body.revocationDataStale).toBe(true);
  });
});

describe("POST /admin/extensions/install", () => {
  it("installs by catalog id and retains only a safe audit source summary", async () => {
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
    const auditEntry = mockWriteAuditLog.mock.calls[0]?.[0] as {
      action: string;
      details: Record<string, unknown>;
    };
    expect(auditEntry).toMatchObject({
      action: "extension.install",
      details: {
        version: "1.0.0",
        sourceTrust: "verified",
        sourceUrl: {
          host: "extensions.example.test",
          digest: "55f256172f64e55c11e87683de7a1217",
        },
        jobId: "job-ext-1",
      },
    });
    expect(JSON.stringify(auditEntry.details)).not.toMatch(
      /fixture-user|fixture-pass|private\/extension|fixture-extension-token|fixture-fragment/,
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

describe("extension source audit details", () => {
  it("summarizes both added and removed external source URLs", async () => {
    const sourceUrl =
      "https://fixture-user:fixture-pass@sources.example.test/private/catalog.json?token=fixture-source-token#fixture-fragment";

    const added = await app.inject({
      method: "POST",
      url: "/admin/extensions/sources",
      payload: { url: sourceUrl, label: "Fixture source" },
    });
    const removed = await app.inject({
      method: "DELETE",
      url: "/admin/extensions/sources",
      payload: { url: sourceUrl },
    });

    expect(added.statusCode).toBe(200);
    expect(removed.statusCode).toBe(200);
    const auditEntries = mockWriteAuditLog.mock.calls.map(([entry]) => {
      const typed = entry as { action: string; details: Record<string, unknown> };
      return { action: typed.action, details: typed.details };
    });
    expect(auditEntries).toEqual([
      expect.objectContaining({
        action: "extension.add_source",
        details: {
          sourceUrl: {
            host: "sources.example.test",
            digest: "f72cb5b0d7040d04b3425f715f653830",
          },
          label: "Fixture source",
        },
      }),
      expect.objectContaining({
        action: "extension.remove_source",
        details: {
          sourceUrl: {
            host: "sources.example.test",
            digest: "f72cb5b0d7040d04b3425f715f653830",
          },
        },
      }),
    ]);
    expect(JSON.stringify(auditEntries)).not.toMatch(
      /fixture-user|fixture-pass|private\/catalog|fixture-source-token|fixture-fragment/,
    );
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
