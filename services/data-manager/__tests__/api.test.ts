import { transitSourceRevision } from "../src/transit-sources.js";

vi.mock("../src/jobs/execution/local.js", () => ({
  runLocalDataExecution: async (_input: unknown, run: () => Promise<unknown>) => run(),
  startLocalDataExecution: async (_input: unknown, run: () => Promise<unknown>) => ({
    status: {},
    completion: run(),
  }),
}));

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import type { SafeDownloadOptions } from "@openmapx/core/utils/safe-download";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerApi } from "../src/api.js";
import { TransitScopeRejected } from "../src/jobs/execution/api.js";
import { DataConfigurationMaintenanceBusy } from "../src/jobs/execution/store.js";
import { resolveOperationsProfile } from "../src/jobs/transitous/operations-profile.js";
import { OperatorFeedRelayStore } from "../src/jobs/transitous/operator-feed-relay.js";
import { dataReceipt, receiverFixture } from "./helpers/execution-receiver.js";

vi.mock("../src/jobs/download-osm.js", () => ({
  downloadOsm: vi.fn(),
}));

const mockInspectOvertureRecovery = vi.hoisted(() =>
  vi.fn(async (_sql: unknown, _dataDir: string, region: string) => {
    const action = { allowed: false, reason: "fixture" };
    return {
      region,
      busy: false,
      osmAvailable: false,
      downloadedRelease: null,
      installedRelease: null,
      actions: {
        "overture-pull": action,
        "overture-ingest": action,
        "overture-extract": action,
        "overture-conflate": action,
        "overture-restart": action,
      },
    };
  }),
);

vi.mock("../src/jobs/overture/recovery.js", async (original) => ({
  ...(await original<typeof import("../src/jobs/overture/recovery.js")>()),
  inspectOvertureRecovery: mockInspectOvertureRecovery,
}));

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

  it("continues an observer through running unknown publication without canceling its worker", async () => {
    const status = dataReceipt({
        kind: "transit-maintenance",
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
        admitMaintenance: async () => status,
        inspect,
        requestCancel: cancel,
      }),
    });
    const response = await app.inject({ method: "POST", url: "/transit/restart-motis" });
    expect(response.statusCode).toBe(200);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(response.json()).toEqual({ ok: true, status: "restart-initiated" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("refuses a MOTIS restart in the error envelope when no durable receiver is wired", async () => {
    const app = createTestApp();
    registerApi(app, { dataDir: createDataDir() });
    const response = await app.inject({ method: "POST", url: "/transit/restart-motis" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Durable data receiver is unavailable",
      code: "ops-agent-unavailable",
    });
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

  it("returns 409 without changing the overlay while another data job holds admission", async () => {
    const dataDir = createDataDir();
    sourceCatalog(dataDir);
    const overlayPath = join(dataDir, "overrides", "feeds-overlay.json");
    const admitLocal = vi.fn(async () => {
      throw new DataConfigurationMaintenanceBusy();
    });
    const app = createTestApp();
    registerApi(app, { dataDir, executionReceiver: receiverFixture({ admitLocal }) });
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
    expect(res.json()).toEqual({
      error: "Another data job is running. Try again when it finishes.",
      code: "in-flight",
      existingJobId: null,
    });
    expect(existsSync(overlayPath)).toBe(false);
  });

  it("rejects oversized source metadata before admitting work", async () => {
    const dataDir = createDataDir();
    sourceCatalog(dataDir);
    const admitLocal = vi.fn();
    const app = createTestApp();
    registerApi(app, { dataDir, executionReceiver: receiverFixture({ admitLocal }) });
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
    expect(admitLocal).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, "overrides/feeds-overlay.json"))).toBe(false);
  });
  it("answers with the admitted sync's job and leaves the overlay to its worker", async () => {
    const dataDir = createDataDir();
    sourceCatalog(dataDir);
    const admitLocal = vi.fn(async () => dataReceipt({ kind: "transit-sync" }));
    const app = createTestApp();
    registerApi(app, { dataDir, executionReceiver: receiverFixture({ admitLocal }) });
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
    expect(existsSync(join(dataDir, "overrides/feeds-overlay.json"))).toBe(false);
    expect(admitLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "transit-sync",
        sourceMutation: expect.objectContaining({
          action: "add",
          source: expect.objectContaining({ name: "operator-feed" }),
        }),
      }),
      { triggeredBy: "api" },
    );
  });

  it.each([
    { countries: "de", label: "a non-array countries value" },
    { countries: ["-x"], label: "a leading-dash country token" },
  ])("POST /transit/sync rejects $label", async ({ countries }) => {
    const dataDir = createDataDir();
    const admitLocal = vi.fn();
    const app = createTestApp();
    registerApi(app, {
      dataDir,
      operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
      executionReceiver: receiverFixture({ admitLocal }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/transit/sync",
      payload: { countries },
    });

    expect(res.statusCode).toBe(400);
    expect(admitLocal).not.toHaveBeenCalled();
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

  it("POST /transit/sync names an out-of-scope refusal in the error envelope", async () => {
    const app = createTestApp();
    registerApi(app, {
      dataDir: createDataDir(),
      operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
      executionReceiver: receiverFixture({
        admitLocal: async () => {
          throw new TransitScopeRejected();
        },
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/transit/sync",
      payload: { countries: ["fr"] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: "Countries outside configured operations profile",
      code: "outside-operations-profile",
    });
  });

  it("POST /transit/sync starts an in-scope country", async () => {
    const dataDir = createDataDir();
    const admitLocal = vi.fn(async () => dataReceipt({ kind: "transit-sync" }));
    const app = createTestApp();
    registerApi(app, {
      dataDir,
      operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
      executionReceiver: receiverFixture({ admitLocal }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/transit/sync",
      payload: {
        countries: ["DE"],
        idempotencyKey: "transit-test-key",
        triggeredBy: "api:synthetic-user",
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, jobId: dataReceipt().id, status: "started" });
    expect(admitLocal).toHaveBeenCalledWith(
      { kind: "transit-sync", countries: ["DE"] },
      { idempotencyKey: "transit-test-key", triggeredBy: "api:synthetic-user" },
    );
  });

  it.each(["../etc", "Europe/Germany"])(
    "GET /overture/recovery rejects an invalid region: %s",
    async (region) => {
      mockInspectOvertureRecovery.mockClear();
      const app = createTestApp();
      registerApi(app, { dataDir: createDataDir() });

      const res = await app.inject({
        method: "GET",
        url: "/overture/recovery",
        query: { region },
      });

      expect(res.statusCode).toBe(400);
      expect(mockInspectOvertureRecovery).not.toHaveBeenCalled();
    },
  );

  it.each(["europe/germany/berlin", "planet"])(
    "GET /overture/recovery accepts a valid region: %s",
    async (region) => {
      mockInspectOvertureRecovery.mockClear();
      const app = createTestApp();
      const dataDir = createDataDir();
      registerApi(app, { dataDir });

      const res = await app.inject({
        method: "GET",
        url: "/overture/recovery",
        query: { region },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ region });
      expect(mockInspectOvertureRecovery).toHaveBeenCalledWith(expect.anything(), dataDir, region);
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

  it("POST /link refuses an unnamed plan and links nothing without the durable receiver", async () => {
    const dataDir = createDataDir();
    mkdirSync(join(dataDir, "osm"), { recursive: true });
    writeFileSync(join(dataDir, "osm", "planet.osm.pbf"), "PBF");
    const app = createTestApp();
    registerApi(app, { dataDir });
    const plan = [
      {
        source: "data/osm",
        target: "data/valhalla/osm-pbf",
        consumerService: "valhalla",
        dataType: "osm-pbf",
      },
    ];
    const deadline = Date.now() + 60_000;
    const named = {
      operationKey: createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
      requestedDeadlineAt: deadline,
      revisionId: `cfg1_${"a".repeat(43)}`,
      plan,
      prune: true,
    };

    for (const unnamed of [{ plan }, { ...named, operationKey: undefined }]) {
      const res = await app.inject({ method: "POST", url: "/link", payload: unnamed });
      expect(res.statusCode).toBe(400);
    }
    // The plan is only ever applied as a durable data execution.
    const res = await app.inject({ method: "POST", url: "/link", payload: named });
    expect(res.statusCode, res.body).toBe(503);
    expect(existsSync(join(dataDir, "valhalla"))).toBe(false);
  });
});
