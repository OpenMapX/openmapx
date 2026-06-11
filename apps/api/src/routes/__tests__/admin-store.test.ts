import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockAdminSession } from "./admin-test-helpers.js";

// Auth guard mock — all three exports required
const fakeSession = mockAdminSession();
const mockRequireAdmin = vi.fn().mockResolvedValue(fakeSession);
const mockGetAdminSession = vi.fn().mockReturnValue(fakeSession);
const mockTryAdminSession = vi.fn().mockResolvedValue(fakeSession);

vi.mock("../../utils/require-admin.js", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  getAdminSession: (...args: unknown[]) => mockGetAdminSession(...args),
  tryAdminSession: (...args: unknown[]) => mockTryAdminSession(...args),
}));

// Audit log
const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("../../utils/audit-log.js", () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

// Rate limiters — no-op
vi.mock("../../utils/rate-limit.js", () => ({
  storeInstallLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  serviceActionLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  emailTestLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  publicApiLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  authLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  expensivePublicApiLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  tilePublicApiLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
}));

// Job runner
const mockJobRunnerEnqueue = vi.fn().mockResolvedValue("job-store-123");
vi.mock("../../services/job-runner.js", () => ({
  jobRunner: { enqueue: (...args: unknown[]) => mockJobRunnerEnqueue(...args) },
}));

// DB
const mockDbSelect = vi.fn();
const mockDbInsert = vi.fn();

let selectResolveWith: unknown[] = [];

function makeSelectChain() {
  const chain: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; stub must mirror that.
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(selectResolveWith).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

const insertChain = {
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
};
mockDbSelect.mockImplementation(() => makeSelectChain());
mockDbInsert.mockReturnValue(insertChain);

vi.mock("../../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}));
vi.mock("../../db/schema.js", () => ({
  installedIntegration: { id: "id", repository: "repository" },
}));

// Store service
const MOCK_CATALOG_ENTRY = {
  id: "geocoding-photon",
  name: "Photon",
  description: "OSM geocoding",
  version: "1.2.0",
  author: "OpenMapX",
  repository: "https://github.com/openmapx/integration-geocoding-photon",
  tags: ["geocoding"],
  domains: ["search"],
  quality: "stable",
  lastUpdated: "2024-01-01T00:00:00Z",
  artifact: {
    url: "https://cdn.example.com/photon-1.2.0.tar.gz",
    sha256: "abc123",
  },
};

const mockGetCatalog = vi.fn().mockResolvedValue([MOCK_CATALOG_ENTRY]);
const mockGetCatalogEntry = vi.fn().mockResolvedValue(MOCK_CATALOG_ENTRY);
const mockFetchReadme = vi.fn().mockResolvedValue("# Photon\n\nFast geocoding.");
const mockIsCompatible = vi.fn().mockReturnValue(true);
const mockCanUpdateFromCatalog = vi.fn().mockReturnValue(false);
const mockCheckForUpdates = vi.fn().mockResolvedValue([]);
const mockListCatalogSources = vi.fn().mockResolvedValue([]);
const mockAddCatalogSource = vi.fn().mockResolvedValue(undefined);
const mockRemoveCatalogSource = vi.fn().mockResolvedValue(undefined);

vi.mock("../../services/store.js", () => ({
  getCatalog: (...args: unknown[]) => mockGetCatalog(...args),
  getCatalogEntry: (...args: unknown[]) => mockGetCatalogEntry(...args),
  fetchReadme: (...args: unknown[]) => mockFetchReadme(...args),
  isCompatible: (...args: unknown[]) => mockIsCompatible(...args),
  canUpdateFromCatalog: (...args: unknown[]) => mockCanUpdateFromCatalog(...args),
  checkForUpdates: (...args: unknown[]) => mockCheckForUpdates(...args),
  listCatalogSources: (...args: unknown[]) => mockListCatalogSources(...args),
  addCatalogSource: (...args: unknown[]) => mockAddCatalogSource(...args),
  removeCatalogSource: (...args: unknown[]) => mockRemoveCatalogSource(...args),
  PLATFORM_VERSION: "1.0.0",
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { adminStoreRoute } = await import("../admin-store.js");
  app = Fastify({ logger: false });
  await app.register(adminStoreRoute);
  await app.ready();
});

afterAll(() => app.close());
afterEach(() => vi.clearAllMocks());

describe("GET /admin/store/catalog", () => {
  it("returns catalog entries with install status", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/store/catalog" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      id: "geocoding-photon",
      name: "Photon",
      installed: false,
      compatible: true,
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockRequireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );

    const res = await app.inject({ method: "GET", url: "/admin/store/catalog" });

    expect(res.statusCode).toBe(401);
  });

  it("filters by domain query parameter", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/store/catalog?domain=other-domain",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // photon only has the 'search' domain, so it gets filtered out
    expect(body.total).toBe(0);
    expect(body.entries).toHaveLength(0);
  });
});

describe("GET /admin/store/catalog/:id", () => {
  it("returns catalog entry detail with readme", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/store/catalog/geocoding-photon" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("geocoding-photon");
    expect(body.readme).toBe("# Photon\n\nFast geocoding.");
    expect(body.installed).toBe(false);
  });

  it("returns 404 for unknown catalog entry", async () => {
    mockGetCatalogEntry.mockResolvedValueOnce(null);

    const res = await app.inject({ method: "GET", url: "/admin/store/catalog/unknown-pkg" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Not found");
  });
});

describe("POST /admin/store/install", () => {
  it("installs from catalog by repository URL, returns 202 with jobId", async () => {
    mockGetCatalog.mockResolvedValueOnce([MOCK_CATALOG_ENTRY]);
    mockJobRunnerEnqueue.mockResolvedValueOnce("job-install-1");

    const res = await app.inject({
      method: "POST",
      url: "/admin/store/install",
      payload: { repository: MOCK_CATALOG_ENTRY.repository },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().jobId).toBe("job-install-1");
    expect(mockJobRunnerEnqueue).toHaveBeenCalledWith(
      "store.install",
      expect.objectContaining({ artifactUrl: MOCK_CATALOG_ENTRY.artifact.url }),
      fakeSession.user.id,
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "store.install" }),
    );
  });

  it("installs from direct artifact URL, returns 202 with jobId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/store/install",
      payload: {
        artifactUrl: "https://cdn.example.com/my-integration-1.0.tar.gz",
        version: "1.0",
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().jobId).toBeTruthy();
  });

  it("returns 400 when neither repository nor artifactUrl is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/store/install",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("required");
  });
});

describe("DELETE /admin/store/:id", () => {
  it("enqueues store.remove job and returns 202", async () => {
    // Simulate an installed integration record via limit()
    mockDbSelect.mockImplementationOnce(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        {
          id: "geocoding-photon",
          repository: MOCK_CATALOG_ENTRY.repository,
          installedVersion: "1.2.0",
          sourceType: "registry",
          installedAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    }));

    const res = await app.inject({
      method: "DELETE",
      url: "/admin/store/geocoding-photon",
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().jobId).toBeTruthy();
    expect(mockJobRunnerEnqueue).toHaveBeenCalledWith(
      "store.remove",
      expect.objectContaining({ id: "geocoding-photon" }),
      fakeSession.user.id,
    );
  });

  it("returns 404 for non-installed integration", async () => {
    mockDbSelect.mockImplementationOnce(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    }));

    const res = await app.inject({
      method: "DELETE",
      url: "/admin/store/not-installed",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not installed");
  });
});

describe("GET /admin/store/installed", () => {
  it("returns installed integrations list", async () => {
    const installedRow = {
      id: "geocoding-photon",
      repository: MOCK_CATALOG_ENTRY.repository,
      installedVersion: "1.2.0",
      sourceType: "registry",
      installedAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    };
    // db.select().from(installedIntegration) awaits the chain — set via selectResolveWith
    selectResolveWith = [installedRow];

    const res = await app.inject({ method: "GET", url: "/admin/store/installed" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.integrations).toHaveLength(1);
    expect(body.integrations[0]).toMatchObject({ id: "geocoding-photon" });

    selectResolveWith = [];
  });
});

describe("POST /admin/store/sources", () => {
  it("adds a valid catalog source and writes audit log", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/store/sources",
      payload: { url: "https://catalog.example.com/index.json", label: "My Catalog" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(mockAddCatalogSource).toHaveBeenCalledWith(
      "https://catalog.example.com/index.json",
      "My Catalog",
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "store.add_source" }),
    );
  });

  it("returns 400 when url is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/store/sources",
      payload: { label: "Missing URL" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("url");
  });

  it("returns 400 for an invalid URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/store/sources",
      payload: { url: "not-a-url", label: "Bad" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("valid URL");
  });
});
