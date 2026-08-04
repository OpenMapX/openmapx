import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerApi } from "../src/api.js";
import { resolveOperationsProfile } from "../src/jobs/transitous/operations-profile.js";
import type { SingleFlightController } from "../src/jobs/transitous/single-flight.js";

const mockDownloadOsm = vi.hoisted(() =>
  vi.fn(async ({ region }: { region: string }) => ({
    path: `/data/osm/${region.replace(/\//g, "-")}.osm.pbf`,
    url: `https://download.example/${region}`,
    sizeBytes: 1,
  })),
);

vi.mock("../src/jobs/download-osm.js", () => ({ downloadOsm: mockDownloadOsm }));

describe("data-manager API", () => {
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
    const app = Fastify();
    registerApi(app, { dataDir: "/tmp/openmapx-dm-test-empty" });
    const res = await app.inject({ method: "GET", url: "/datasets" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ datasets: [] });
    await app.close();
  });

  it("GET /status returns service status", async () => {
    const app = Fastify();
    registerApi(app, { dataDir: "/tmp/openmapx-dm-test-status" });
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    await app.close();
  });

  it("POST /datasets/reload reloads state from disk", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-test-reload-"));
    const app = Fastify();
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

    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns 409 without changing the overlay when single-flight is occupied", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-source-conflict-"));
    sourceCatalog(dataDir);
    const overlayPath = join(dataDir, "overrides", "feeds-overlay.json");
    const singleFlight: SingleFlightController = {
      tryStartSync: vi.fn(async () => ({
        ok: false as const,
        reason: "in-flight" as const,
        existingJobId: "running-job",
      })),
      markSyncFinished: vi.fn(),
      getInflight: () => ({ jobId: "running-job", startedAt: new Date() }),
    };
    const app = Fastify();
    registerApi(app, { dataDir, singleFlight, launchTransitSync: vi.fn() });
    const res = await app.inject({
      method: "POST",
      url: "/transit/sources",
      payload: {
        region: "de",
        name: "operator-feed",
        url: "https://operator.example/feed.zip",
        license: { spdxIdentifier: "CC-BY-4.0", attribution: "Operator" },
      },
    });
    expect(res.statusCode).toBe(409);
    expect(existsSync(overlayPath)).toBe(false);
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns a reserved visible job before launching an accepted source mutation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-source-accepted-"));
    sourceCatalog(dataDir);
    const events: string[] = [];
    const singleFlight: SingleFlightController = {
      tryStartSync: vi.fn(async () => {
        events.push("job-inserted");
        return { ok: true as const, jobId: "job-visible" };
      }),
      markSyncFinished: vi.fn(),
      getInflight: () => ({ jobId: "job-visible", startedAt: new Date() }),
    };
    const launchTransitSync = vi.fn(() => events.push("pipeline-launched"));
    const app = Fastify();
    registerApi(app, { dataDir, singleFlight, launchTransitSync });
    const res = await app.inject({
      method: "POST",
      url: "/transit/sources",
      payload: {
        region: "de",
        name: "operator-feed",
        url: "https://operator.example/feed.zip",
        license: { spdxIdentifier: "CC-BY-4.0", attribution: "Operator" },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      jobId: "job-visible",
      sourceId: "operator:de:operator-feed",
      status: "started",
    });
    expect(events).toEqual(["job-inserted", "pipeline-launched"]);
    const overlay = JSON.parse(
      readFileSync(join(dataDir, "overrides", "feeds-overlay.json"), "utf-8"),
    ) as { version: number };
    expect(overlay.version).toBe(3);
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([
    { countries: "de", label: "a non-array countries value" },
    { countries: ["-x"], label: "a leading-dash country token" },
  ])("POST /transit/sync rejects $label", async ({ countries }) => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-transit-sync-invalid-"));
    const singleFlight: SingleFlightController = {
      tryStartSync: vi.fn(),
      markSyncFinished: vi.fn(),
      getInflight: () => null,
    };
    const app = Fastify();
    registerApi(app, {
      dataDir,
      operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
      singleFlight,
      launchTransitSync: vi.fn(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/transit/sync",
      payload: { countries },
    });

    expect(res.statusCode).toBe(400);
    expect(singleFlight.tryStartSync).not.toHaveBeenCalled();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("POST /transit/sync starts an in-scope country", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-transit-sync-valid-"));
    const singleFlight: SingleFlightController = {
      tryStartSync: vi.fn(async () => ({ ok: true as const, jobId: "job-sync" })),
      markSyncFinished: vi.fn(),
      getInflight: () => ({ jobId: "job-sync", startedAt: new Date() }),
    };
    const launchTransitSync = vi.fn();
    const app = Fastify();
    registerApi(app, {
      dataDir,
      operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
      singleFlight,
      launchTransitSync,
    });

    const res = await app.inject({
      method: "POST",
      url: "/transit/sync",
      payload: { countries: ["DE"] },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, jobId: "job-sync", status: "started" });
    expect(launchTransitSync).toHaveBeenCalledWith({
      jobId: "job-sync",
      countries: ["DE"],
      trigger: "api",
    });
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each(["../etc", "Europe/Germany"])(
    "POST /download/osm rejects an invalid region: %s",
    async (region) => {
      const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-download-invalid-"));
      mockDownloadOsm.mockClear();
      const app = Fastify();
      registerApi(app, { dataDir });

      const res = await app.inject({
        method: "POST",
        url: "/download/osm",
        payload: { region },
      });

      expect(res.statusCode).toBe(500);
      expect(mockDownloadOsm).not.toHaveBeenCalled();
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  );

  it.each(["europe/germany/berlin", "planet"])(
    "POST /download/osm accepts a valid region: %s",
    async (region) => {
      const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-download-valid-"));
      mockDownloadOsm.mockClear();
      const app = Fastify();
      registerApi(app, { dataDir });

      const res = await app.inject({
        method: "POST",
        url: "/download/osm",
        payload: { region },
      });

      expect(res.statusCode).toBe(200);
      expect(mockDownloadOsm).toHaveBeenCalledWith(expect.objectContaining({ region, dataDir }));
      expect(res.body).toContain('"event":"done"');
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  );

  it("POST /link rejects a plan entry with a traversing targetFilename", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-link-"));
    const app = Fastify();
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
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("POST /link rejects a plan entry with a traversing dataType", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-link-"));
    const app = Fastify();
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
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("POST /link rejects a body without a plan array", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-link-"));
    const app = Fastify();
    registerApi(app, { dataDir });

    const res = await app.inject({ method: "POST", url: "/link", payload: {} });

    expect(res.statusCode).toBe(400);
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("POST /link rejects unknown top-level properties", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-link-"));
    const app = Fastify();
    registerApi(app, { dataDir });

    const res = await app.inject({
      method: "POST",
      url: "/link",
      payload: { plan: [], rootDir: "/etc" },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("POST /link accepts a well-formed empty plan", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-link-"));
    const app = Fastify();
    registerApi(app, { dataDir });

    const res = await app.inject({ method: "POST", url: "/link", payload: { plan: [] } });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
