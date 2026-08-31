import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStatusSnapshotStore,
  type StatusSnapshotStore,
} from "../../services/status-snapshot.js";
import { mockAdminSession } from "../../test/auth.js";
import { requireAdmin } from "../../utils/require-admin.js";

const mocks = vi.hoisted(() => ({
  getAllIntegrations: vi.fn(),
  getCachedIntegrationHealthSnapshot: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({ sql: mocks.sql }));
vi.mock("../../redis.js", () => ({ redis: null }));
vi.mock("../../integration-host.js", () => ({
  getAllIntegrations: mocks.getAllIntegrations,
}));
vi.mock("../../services/integration-health.js", () => ({
  getCachedIntegrationHealthSnapshot: mocks.getCachedIntegrationHealthSnapshot,
}));
vi.mock("../../utils/require-admin.js", () => ({
  requireAdmin: vi.fn(),
}));

import { probeStatusDependencies, type StatusProbeSnapshot, statusRoute } from "../status.js";

const detailedServices = [
  {
    id: "postgresql",
    name: "PostgreSQL",
    category: "Infrastructure",
    url: "postgresql://postgres:***@db:5432/openmapx",
    status: "down" as const,
    responseTime: 12,
    error: "Connection refused at db:5432",
  },
  {
    id: "github",
    name: "GitHub API",
    category: "External",
    url: "https://api.github.com",
    status: "up" as const,
    responseTime: 8,
  },
];

function staticStore(
  options: {
    stale?: boolean;
    refreshErrorClass?: "timeout" | "dependency-unavailable" | "unexpected";
  } = {},
) {
  return {
    read: vi.fn(async () => ({
      available: true as const,
      data: { services: detailedServices },
      capturedAt: "2026-08-24T12:00:00.000Z",
      ageMs: 1_234,
      stale: options.stale ?? false,
      ...(options.refreshErrorClass ? { refreshErrorClass: options.refreshErrorClass } : {}),
    })),
  };
}

async function buildStatusApp(
  statusStore: StatusSnapshotStore<StatusProbeSnapshot> = staticStore(),
) {
  const app = Fastify();
  await app.register(statusRoute, { prefix: "/api", statusStore });
  return app;
}

describe("status routes", () => {
  beforeEach(() => {
    vi.mocked(requireAdmin).mockResolvedValue(mockAdminSession());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("coalesces two concurrent public requests into one dependency fan-out", async () => {
    let resolveProbe!: (snapshot: StatusProbeSnapshot) => void;
    const probe = vi.fn(
      () =>
        new Promise<StatusProbeSnapshot>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const statusStore = createStatusSnapshotStore({
      probe,
      now: () => ({ monotonicMs: 0, wallTimeMs: Date.parse("2026-08-24T12:00:00.000Z") }),
    });
    const app = await buildStatusApp(statusStore);

    const first = app.inject({ method: "GET", url: "/api/status" });
    const second = app.inject({ method: "GET", url: "/api/status" });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    resolveProbe({ services: detailedServices });

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    await app.close();
  });

  it("always returns a cookie-independent redacted public snapshot", async () => {
    const app = await buildStatusApp(
      staticStore({ stale: true, refreshErrorClass: "dependency-unavailable" }),
    );

    const anonymous = await app.inject({ method: "GET", url: "/api/status" });
    const cookieBearing = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { cookie: "session=admin-secret" },
    });

    expect(anonymous.statusCode).toBe(200);
    expect(cookieBearing.json()).toEqual(anonymous.json());
    expect(anonymous.headers["cache-control"]).toBe(
      "public, max-age=15, stale-while-revalidate=45",
    );
    expect(anonymous.headers.vary ?? "").not.toContain("Cookie");
    expect(anonymous.json()).toMatchObject({ stale: true, snapshotAgeMs: 1_234 });
    for (const service of anonymous.json().services) {
      expect(service).not.toHaveProperty("url");
      expect(service).not.toHaveProperty("error");
    }
    expect(anonymous.json()).not.toHaveProperty("refreshErrorClass");
    expect(requireAdmin).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires an administrator and never publicly caches the detailed snapshot", async () => {
    const app = await buildStatusApp(
      staticStore({ stale: true, refreshErrorClass: "dependency-unavailable" }),
    );

    const response = await app.inject({ method: "GET", url: "/api/admin/status" });

    expect(response.statusCode).toBe(200);
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.json()).toMatchObject({
      stale: true,
      refreshErrorClass: "dependency-unavailable",
    });
    expect(response.json().services[0]).toMatchObject({
      url: expect.any(String),
      error: expect.any(String),
    });
    await app.close();
  });

  it("marks an administrator rejection private before authentication runs", async () => {
    const statusStore = staticStore();
    vi.mocked(requireAdmin).mockRejectedValue(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );
    const app = await buildStatusApp(statusStore);

    const response = await app.inject({ method: "GET", url: "/api/admin/status" });

    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(statusStore.read).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns no stale dependency detail after the bounded stale window", async () => {
    const statusStore = {
      read: vi.fn(async () => ({
        available: false as const,
        observedAt: "2026-08-24T12:06:00.000Z",
        stale: false as const,
        refreshErrorClass: "unexpected" as const,
      })),
    };
    const app = await buildStatusApp(statusStore);

    const publicResponse = await app.inject({ method: "GET", url: "/api/status" });
    const adminResponse = await app.inject({ method: "GET", url: "/api/admin/status" });

    expect(publicResponse.statusCode).toBe(503);
    expect(publicResponse.json()).toEqual({
      timestamp: "2026-08-24T12:06:00.000Z",
      snapshotAgeMs: null,
      stale: false,
      unavailable: true,
      services: [],
    });
    expect(adminResponse.statusCode).toBe(503);
    expect(adminResponse.json()).toMatchObject({
      stale: false,
      unavailable: true,
      services: [],
      refreshErrorClass: "unexpected",
    });
    await app.close();
  });
});

describe("status dependency probe", () => {
  beforeEach(() => {
    mocks.sql.mockResolvedValue([]);
    mocks.getAllIntegrations.mockReturnValue([
      { id: "enabled", enabled: true, manifest: { healthCheck: { type: "http" } } },
      { id: "disabled", enabled: false, manifest: { healthCheck: { type: "http" } } },
    ]);
    mocks.getCachedIntegrationHealthSnapshot.mockReturnValue({
      updatedAt: Date.parse("2026-08-24T12:00:00.000Z"),
      results: [
        {
          id: "enabled",
          name: "Enabled integration",
          category: "External",
          url: "https://example.com/health",
          status: "up",
        },
      ],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("zen", { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("fans out to platform dependencies and combines cached integration health", async () => {
    const snapshot = await probeStatusDependencies();

    expect(snapshot.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "postgresql", status: "up" }),
        expect.objectContaining({ id: "enabled", status: "up" }),
      ]),
    );
    expect(mocks.getCachedIntegrationHealthSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({ id: "enabled" }),
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
