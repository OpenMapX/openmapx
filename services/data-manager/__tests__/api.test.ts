import { transitSourceRevision } from "../src/transit-sources.js";

vi.mock("../src/jobs/execution/legacy-mutation.js", () => ({
  beginLegacyCatalogPreflight: async () => {},
  rejectLegacyMissingCatalog: async () => {},
  markLegacyCatalogFetchAttempt: async () => {},
  startLegacyDataMutation: async (_kind: string, run: () => Promise<unknown>) => ({
    id: "unit-writer",
    completion: run(),
  }),
  withLegacyDataMutation: async (_kind: string, run: () => Promise<unknown>) => run(),
  independentLegacyDataMutation: async (_kind: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../src/jobs/persistence.js", async () => ({
  ...(await vi.importActual<typeof import("../src/jobs/persistence.js")>(
    "../src/jobs/persistence.js",
  )),
  finalizeJobRow: vi.fn(async () => {}),
}));

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SafeDownloadOptions } from "@openmapx/core/utils/safe-download";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerApi } from "../src/api.js";
import { resolveOperationsProfile } from "../src/jobs/transitous/operations-profile.js";
import { OperatorFeedRelayStore } from "../src/jobs/transitous/operator-feed-relay.js";
import type { SingleFlightController } from "../src/jobs/transitous/single-flight.js";
import { dataReceipt, receiverFixture } from "./helpers/execution-receiver.js";

const mockDownloadOsm = vi.hoisted(() =>
  vi.fn(async ({ region }: { region: string }) => ({
    path: `/data/osm/${region.replace(/\//g, "-")}.osm.pbf`,
    url: `https://download.example/${region}`,
    sizeBytes: 1,
  })),
);

vi.mock("../src/jobs/download-osm.js", () => ({ downloadOsm: mockDownloadOsm }));

function observedUnitReceiver(
  kind: import("@openmapx/core/data-manager-contracts").DataExecutionInput["kind"],
  run: (progress: (event: Record<string, unknown>) => void) => Promise<Record<string, unknown>>,
) {
  let current = dataReceipt({ kind, status: "running", publication: "unknown" }),
    done: Record<string, unknown> | undefined,
    listener: ((event: Record<string, unknown>) => void) | undefined;
  return receiverFixture({
    admitLocal: async () => {
      setTimeout(() => {
        void run((event) => listener?.({ event: "progress", ...event })).then(
          (result) => {
            done = { event: "done", ok: true, ...result };
            current = { ...current, status: "ok", publication: "committed" };
          },
          () => {
            current = { ...current, status: "error", publication: "not_started" };
          },
        );
      }, 0);
      return current;
    },
    inspect: async () => current,
    subscribe: (_id, onEvent) => {
      listener = onEvent;
      return () => {
        listener = undefined;
      };
    },
    legacyResult: () => done,
  });
}

describe("data-manager API", () => {
  let fixtureRoot: string;
  let apps: FastifyInstance[];

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "openmapx-dm-api-"));
    apps = [];
  });

  afterEach(async () => {
    try {
      await Promise.all(apps.map((app) => app.close()));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  function createTestApp(): FastifyInstance {
    const app = Fastify();
    apps.push(app);
    return app;
  }

  function createDataDir(): string {
    const dataDir = join(fixtureRoot, "data");
    mkdirSync(dataDir);
    return dataDir;
  }

  function sourceCatalog(dataDir: string): void {
    const feedsDir = join(dataDir, ".transitous-catalog", "feeds");
    const gitDir = join(dataDir, ".transitous-catalog", ".git");
    mkdirSync(feedsDir, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      join(feedsDir, "de.json"),
      JSON.stringify({
        sources: [{ name: "catalog-feed", url: "https://catalog.example/feed.zip" }],
      }),
    );
  }

  it("GET /datasets returns empty list when no state", async () => {
    const app = createTestApp();
    registerApi(app, { dataDir: join(fixtureRoot, "data") });
    const res = await app.inject({ method: "GET", url: "/datasets" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ datasets: [] });
  });

  it("GET /status returns service status", async () => {
    const app = createTestApp();
    registerApi(app, { dataDir: join(fixtureRoot, "data") });
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("GET /status returns 503 until mandatory startup has completed", async () => {
    const app = createTestApp();
    registerApi(app, {
      dataDir: join(fixtureRoot, "data"),
      readiness: () => ({ status: "starting", phase: "job-reconciliation" }),
    });

    const res = await app.inject({ method: "GET", url: "/status" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      ok: false,
      status: "starting",
      phase: "job-reconciliation",
    });
  });

  it("GET /live remains a liveness-only probe while readiness is false", async () => {
    const app = createTestApp();
    registerApi(app, {
      dataDir: join(fixtureRoot, "data"),
      readiness: () => ({ status: "failed", phase: "job-reconciliation" }),
    });

    const res = await app.inject({ method: "GET", url: "/live" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("streams a relay capability once with private response headers", async () => {
    const dataDir = createDataDir();
    const relay = new OperatorFeedRelayStore({
      download: async (options: SafeDownloadOptions) => {
        writeFileSync(options.destination, "operator archive");
        return {
          bytesWritten: 16,
          contentType: "application/zip",
          finalUrl: options.url,
        };
      },
    });
    const registration = relay.register({
      runId: "run-route",
      sourceId: "operator:de:route",
      remoteUrl: new URL("https://operator.example/feed.zip"),
    });
    const app = createTestApp();
    registerApi(app, { dataDir, operatorFeedRelay: relay });

    const first = await app.inject({ method: "GET", url: registration.url.pathname });
    const second = await app.inject({ method: "GET", url: registration.url.pathname });

    expect(first.statusCode).toBe(200);
    expect(first.body).toBe("operator archive");
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers.pragma).toBe("no-cache");
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
    expect(second.statusCode).toBe(410);
    expect(second.body).not.toContain("operator.example");
    await relay.endRun("run-route");
  });

  it("GET /search-index/status returns 404 when no snapshot is published", async () => {
    const app = createTestApp();
    const unsafe = vi.fn().mockResolvedValue([{ exists: false }]);
    registerApi(app, {
      dataDir: join(fixtureRoot, "data"),
      searchIndexSql: { unsafe, reserve: vi.fn() } as never,
    });
    const res = await app.inject({ method: "GET", url: "/search-index/status" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ ok: false, error: "osm_search index not built" });
  });

  it("continues a legacy observer through running unknown publication without canceling its worker", async () => {
    const status = dataReceipt({
        kind: "download-fonts",
        status: "running",
        publication: "unknown",
      }),
      inspect = vi
        .fn()
        .mockResolvedValueOnce(status)
        .mockResolvedValueOnce({ ...status, status: "ok", publication: "committed" }),
      cancel = vi.fn(),
      app = createTestApp();
    registerApi(app, {
      dataDir: createDataDir(),
      executionReceiver: receiverFixture({
        admitLocal: async () => status,
        inspect,
        requestCancel: cancel,
      }),
    });
    const response = await app.inject({ method: "POST", url: "/download/fonts" });
    expect(response.statusCode).toBe(200);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(response.json()).toEqual({ ok: true });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("POST /search-index/build streams progress and the final snapshot", async () => {
    const dataDir = createDataDir();
    const app = createTestApp();
    const buildSearchIndex = vi.fn(
      async (options: { onProgress?: (event: Record<string, unknown>) => void }) => {
        options.onProgress?.({ stage: "extract", message: "streaming" });
        return {
          region: "europe/germany",
          epoch: "new-epoch",
          sourceFingerprint: "md5:abc",
          placeCount: 2,
          termCount: 3,
        };
      },
    );
    registerApi(app, {
      dataDir,
      searchIndexSql: { reserve: vi.fn() } as never,
      executionReceiver: observedUnitReceiver("search-index-build", (onProgress) =>
        buildSearchIndex({ onProgress }),
      ),
    });
    const res = await app.inject({
      method: "POST",
      url: "/search-index/build",
      payload: { region: "europe/germany" },
    });
    expect(res.statusCode).toBe(200);
    const events = res.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      expect.objectContaining({ event: "progress", stage: "extract" }),
      expect.objectContaining({ event: "done", ok: true, epoch: "new-epoch" }),
    ]);
    expect(buildSearchIndex).toHaveBeenCalledOnce();
  });

  it("GET /notable-places/status returns 404 until a first snapshot is published", async () => {
    const app = createTestApp();
    const unsafe = vi.fn().mockResolvedValue([{ exists: false }]);
    registerApi(app, {
      dataDir: join(fixtureRoot, "data"),
      searchIndexSql: { unsafe, reserve: vi.fn() } as never,
    });
    const res = await app.inject({ method: "GET", url: "/notable-places/status" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ ok: false, error: "notable_places index not built" });
  });

  it("POST /notable-places/build streams progress and the published snapshot", async () => {
    const app = createTestApp();
    const build = vi.fn(
      async (options: { onProgress?: (event: Record<string, unknown>) => void }) => {
        options.onProgress?.({ stage: "names", message: "Fetching labels in en" });
        return {
          epoch: "e1",
          source: "https://sparql.test",
          minSitelinks: 8,
          placeCount: 5,
          nameCount: 9,
        };
      },
    );
    registerApi(app, {
      dataDir: join(fixtureRoot, "data"),
      searchIndexSql: { reserve: vi.fn() } as never,
      executionReceiver: observedUnitReceiver("notable-places-build", (onProgress) =>
        build({ onProgress }),
      ),
      notablePlaces: {
        runtimeState: { building: false, failure: null },
        operationLock: { inFlight: false, run: (operation) => operation() },
      },
    });
    const res = await app.inject({ method: "POST", url: "/notable-places/build" });
    const events = res.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      expect.objectContaining({ event: "progress", stage: "names" }),
      expect.objectContaining({ event: "done", ok: true, placeCount: 5, nameCount: 9 }),
    ]);
  });

  it("preserves a successful owned OSM receipt in the legacy observer", async () => {
    const dataDir = createDataDir();
    writeFileSync(
      join(dataDir, ".data-manager-state.json"),
      JSON.stringify({
        datasets: [
          {
            type: "osm-pbf",
            id: "europe/germany",
            region: "europe/germany",
            sizeBytes: 1,
            downloadedAt: "2026-08-13T00:00:00.000Z",
            path: "/data/osm/europe-germany.osm.pbf",
            md5: "abc",
          },
        ],
      }),
    );
    const unsafe = vi
      .fn()
      .mockResolvedValueOnce([{ exists: true }])
      .mockRejectedValueOnce(new Error("database unavailable"));
    const app = createTestApp();
    registerApi(app, {
      dataDir,
      searchIndexSql: { unsafe, reserve: vi.fn() } as never,
      executionReceiver: observedUnitReceiver("download-osm", () =>
        mockDownloadOsm({ region: "europe/germany" }),
      ),
    });
    const res = await app.inject({
      method: "POST",
      url: "/download/osm",
      payload: { region: "europe/germany" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"event":"done"');
    expect(res.body).not.toContain('"event":"error"');
  });

  it("POST /datasets/reload reloads state from disk", async () => {
    const dataDir = createDataDir();
    const app = createTestApp();
    registerApi(app, { dataDir });

    writeFileSync(
      join(dataDir, ".data-manager-state.json"),
      JSON.stringify({
        datasets: [
          {
            type: "osm-pbf",
            id: "europe-germany",
            sizeBytes: 123,
            downloadedAt: "2026-01-01T00:00:00.000Z",
            path: "/data/osm/europe-germany.osm.pbf",
          },
        ],
      }),
      "utf-8",
    );

    const reloadRes = await app.inject({ method: "POST", url: "/datasets/reload" });
    expect(reloadRes.statusCode).toBe(200);
    expect(JSON.parse(reloadRes.body)).toEqual({ ok: true, datasets: 1 });

    const datasetsRes = await app.inject({ method: "GET", url: "/datasets" });
    expect(datasetsRes.statusCode).toBe(200);
    expect(JSON.parse(datasetsRes.body)).toEqual({
      datasets: [
        {
          type: "osm-pbf",
          id: "europe-germany",
          sizeBytes: 123,
          downloadedAt: "2026-01-01T00:00:00.000Z",
          path: "/data/osm/europe-germany.osm.pbf",
        },
      ],
    });
  });

  it("returns 409 without changing the overlay when single-flight is occupied", async () => {
    const dataDir = createDataDir();
    sourceCatalog(dataDir);
    const overlayPath = join(dataDir, "overrides", "feeds-overlay.json");
    const singleFlight: SingleFlightController = {
      tryStartSync: vi.fn(async () => ({
        ok: false as const,
        reason: "in-flight" as const,
        existingJobId: "running-job",
      })),
      reserveOwned: vi.fn(() => true),
      markSyncFinished: vi.fn(),
      getInflight: () => ({ jobId: "running-job", startedAt: new Date() }),
    };
    const app = createTestApp();
    registerApi(app, { dataDir, singleFlight, executionReceiver: receiverFixture() });
    const res = await app.inject({
      method: "POST",
      url: "/transit/sources",
      payload: {
        region: "de",
        name: "operator-feed",
        expectedSourceRevision: transitSourceRevision({
          catalogDir: join(dataDir, ".transitous-catalog"),
          overlayPath: join(dataDir, "overrides/feeds-overlay.json"),
        }),
        url: "https://operator.example/feed.zip",
        license: { spdxIdentifier: "CC-BY-4.0", attribution: "Operator" },
      },
    });
    expect(res.statusCode).toBe(409);
    expect(existsSync(overlayPath)).toBe(false);
  });

  it("rejects oversized source metadata before reserving a job or admitting work", async () => {
    const dataDir = createDataDir();
    sourceCatalog(dataDir);
    const singleFlight: SingleFlightController = {
        tryStartSync: vi.fn(),
        reserveOwned: vi.fn(() => true),
        markSyncFinished: vi.fn(),
        getInflight: () => null,
      },
      admitLocal = vi.fn();
    const app = createTestApp();
    registerApi(app, { dataDir, singleFlight, executionReceiver: receiverFixture({ admitLocal }) });
    const response = await app.inject({
      method: "POST",
      url: "/transit/sources",
      payload: {
        region: "de",
        name: "bounded",
        url: "https://operator.example/feed.zip",
        license: { spdxIdentifier: "CC0-1.0", attribution: "ü".repeat(8192) },
        expectedSourceRevision: transitSourceRevision({
          catalogDir: join(dataDir, ".transitous-catalog"),
          overlayPath: join(dataDir, "overrides/feeds-overlay.json"),
        }),
      },
    });
    expect(response.statusCode, response.body).toBe(413);
    expect(singleFlight.tryStartSync).not.toHaveBeenCalled();
    expect(admitLocal).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, "overrides/feeds-overlay.json"))).toBe(false);
  });
  it("returns a reserved visible job before launching an accepted source mutation", async () => {
    const dataDir = createDataDir();
    sourceCatalog(dataDir);
    const events: string[] = [];
    const singleFlight: SingleFlightController = {
      tryStartSync: vi.fn(async () => {
        events.push("job-inserted");
        return { ok: true as const, jobId: "job-visible" };
      }),
      reserveOwned: vi.fn(() => true),
      markSyncFinished: vi.fn(),
      getInflight: () => ({ jobId: "job-visible", startedAt: new Date() }),
    };
    const admitLocal = vi.fn(async () => {
      events.push("durable-admitted");
      return dataReceipt({ kind: "transit-sync" });
    });
    const app = createTestApp();
    registerApi(app, { dataDir, singleFlight, executionReceiver: receiverFixture({ admitLocal }) });
    const res = await app.inject({
      method: "POST",
      url: "/transit/sources",
      payload: {
        region: "de",
        name: "operator-feed",
        expectedSourceRevision: transitSourceRevision({
          catalogDir: join(dataDir, ".transitous-catalog"),
          overlayPath: join(dataDir, "overrides/feeds-overlay.json"),
        }),
        url: "https://operator.example/feed.zip",
        license: { spdxIdentifier: "CC-BY-4.0", attribution: "Operator" },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      jobId: dataReceipt().id,
      sourceId: "operator:de:operator-feed",
      status: "started",
    });
    expect(events).toEqual(["job-inserted", "durable-admitted"]);
    expect(existsSync(join(dataDir, "overrides/feeds-overlay.json"))).toBe(false);
    expect(admitLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "transit-sync",
        sourceMutation: expect.objectContaining({
          action: "add",
          source: expect.objectContaining({ name: "operator-feed" }),
        }),
      }),
      expect.objectContaining({ sourceJobId: "job-visible" }),
    );
  });

  it.each([
    { countries: "de", label: "a non-array countries value" },
    { countries: ["-x"], label: "a leading-dash country token" },
  ])("POST /transit/sync rejects $label", async ({ countries }) => {
    const dataDir = createDataDir();
    const singleFlight: SingleFlightController = {
      tryStartSync: vi.fn(),
      reserveOwned: vi.fn(() => true),
      markSyncFinished: vi.fn(),
      getInflight: () => null,
    };
    const app = createTestApp();
    registerApi(app, {
      dataDir,
      operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
      singleFlight,
    });

    const res = await app.inject({
      method: "POST",
      url: "/transit/sync",
      payload: { countries },
    });

    expect(res.statusCode).toBe(400);
    expect(singleFlight.tryStartSync).not.toHaveBeenCalled();
  });

  it.each([{ countries: [] }, { countries: ["de"], freeDiskBytes: 10 ** 15, feedCount: 1 }])(
    "POST /transit/sync/preflight refuses an invalid selection or caller capacity %j",
    async (payload) => {
      const app = createTestApp();
      registerApi(app, {
        dataDir: createDataDir(),
        operationsPolicy: resolveOperationsProfile({ countries: ["de", "at"] }),
      });
      const response = await app.inject({
        method: "POST",
        url: "/transit/sync/preflight",
        payload,
      });
      expect(response.statusCode).toBe(400);
    },
  );

  it("observes an already admitted reviewed intent without replaying an expired preview", async () => {
    const app = createTestApp(),
      status = dataReceipt({ kind: "transit-sync", status: "running", publication: "unknown" }),
      admitLocal = vi.fn(async () => status);
    registerApi(app, {
      dataDir: createDataDir(),
      operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
      executionReceiver: receiverFixture({
        admitLocal,
        observeReviewedTransit: async () => status,
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/transit/sync",
      payload: {
        countries: ["de"],
        preflightId: "00000000-0000-4000-8000-000000000001",
        fingerprint: "a".repeat(64),
        idempotencyKey: "original-intent",
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().jobId).toBe(status.id);
    expect(admitLocal).not.toHaveBeenCalled();
  });

  it("does not disclose private acquisition diagnostics from transit preview failures", async () => {
    const ops = await import("../src/ops-client.js"),
      spy = vi
        .spyOn(ops, "runOpsOperation")
        .mockRejectedValueOnce(
          Error("private acquisition /private/operator-file synthetic-secret"),
        );
    try {
      const app = createTestApp();
      registerApi(app, {
        dataDir: createDataDir(),
        operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
      });
      const response = await app.inject({
        method: "POST",
        url: "/transit/sync/preflight",
        payload: { countries: ["de"] },
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("operator-file");
      expect(response.body).not.toContain("synthetic-secret");
    } finally {
      spy.mockRestore();
    }
  });

  it("POST /transit/sync starts an in-scope country", async () => {
    const dataDir = createDataDir();
    const singleFlight: SingleFlightController = {
      tryStartSync: vi.fn(async () => ({ ok: true as const, jobId: "job-sync" })),
      reserveOwned: vi.fn(() => true),
      markSyncFinished: vi.fn(),
      getInflight: () => ({ jobId: "job-sync", startedAt: new Date() }),
    };
    const admitLocal = vi.fn(async () => dataReceipt({ kind: "transit-sync" }));
    const app = createTestApp();
    registerApi(app, {
      dataDir,
      operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
      singleFlight,
      executionReceiver: receiverFixture({ admitLocal }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/transit/sync",
      payload: {
        countries: ["DE"],
        idempotencyKey: "legacy-test-key",
        triggeredBy: "api:synthetic-user",
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, jobId: dataReceipt().id, status: "started" });
    expect(admitLocal).toHaveBeenCalledWith(
      { kind: "transit-sync", countries: ["DE"] },
      { legacyTransitKey: "legacy-test-key", triggeredBy: "api:synthetic-user" },
    );
  });

  it.each(["../etc", "Europe/Germany"])(
    "POST /download/osm rejects an invalid region: %s",
    async (region) => {
      const dataDir = createDataDir();
      mockDownloadOsm.mockClear();
      const app = createTestApp();
      registerApi(app, {
        dataDir,
        executionReceiver: observedUnitReceiver("download-osm", () => mockDownloadOsm({ region })),
      });

      const res = await app.inject({
        method: "POST",
        url: "/download/osm",
        payload: { region },
      });

      expect(res.statusCode).toBe(400);
      expect(mockDownloadOsm).not.toHaveBeenCalled();
    },
  );

  it.each(["europe/germany/berlin", "planet"])(
    "POST /download/osm accepts a valid region: %s",
    async (region) => {
      const dataDir = createDataDir();
      mockDownloadOsm.mockClear();
      const app = createTestApp();
      registerApi(app, {
        dataDir,
        executionReceiver: observedUnitReceiver("download-osm", () => mockDownloadOsm({ region })),
      });

      const res = await app.inject({
        method: "POST",
        url: "/download/osm",
        payload: { region },
      });

      expect(res.statusCode).toBe(200);
      expect(mockDownloadOsm).toHaveBeenCalledWith(expect.objectContaining({ region }));
      expect(res.body).toContain('"event":"done"');
    },
  );

  it("POST /link rejects a plan entry with a traversing targetFilename", async () => {
    const dataDir = createDataDir();
    const app = createTestApp();
    registerApi(app, { dataDir });

    const res = await app.inject({
      method: "POST",
      url: "/link",
      payload: {
        plan: [
          {
            source: "src",
            target: "tgt",
            consumerService: "svc",
            dataType: "osm-pbf",
            targetFilename: "../evil",
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /link rejects a plan entry with a traversing dataType", async () => {
    const dataDir = createDataDir();
    const app = createTestApp();
    registerApi(app, { dataDir });

    const res = await app.inject({
      method: "POST",
      url: "/link",
      payload: {
        plan: [
          {
            source: "src",
            target: "tgt",
            consumerService: "svc",
            dataType: "../evil",
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /link rejects a body without a plan array", async () => {
    const dataDir = createDataDir();
    const app = createTestApp();
    registerApi(app, { dataDir });

    const res = await app.inject({ method: "POST", url: "/link", payload: {} });

    expect(res.statusCode).toBe(400);
  });

  it("POST /link rejects unknown top-level properties", async () => {
    const dataDir = createDataDir();
    const app = createTestApp();
    registerApi(app, { dataDir });

    const res = await app.inject({
      method: "POST",
      url: "/link",
      payload: { plan: [], rootDir: "/etc" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /link closes a legacy unsigned plan before effects", async () => {
    const dataDir = createDataDir();
    const app = createTestApp();
    registerApi(app, { dataDir });

    const res = await app.inject({ method: "POST", url: "/link", payload: { plan: [] } });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "A signed generation-hardlinks execution is required" });
  });
});
