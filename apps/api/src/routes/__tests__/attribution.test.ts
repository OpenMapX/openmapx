import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttributionIndex, setAttributionIndex } from "../../services/attribution/index.js";
import type { ManifestDataSource, MotisLicenseEntry } from "../../services/attribution/types.js";

const LICENSE_FIXTURE: MotisLicenseEntry[] = [
  {
    country_code: "DE",
    spdx_license_identifier: "CC0-1.0",
    license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
    source: "https://example.com/delfi.zip",
    filename: "de_DELFI.gtfs.zip",
    human_name: "DELFI Germany",
    publisher: { name: "DELFI e.V.", url: "https://delfi.de/" },
  },
];

const MANIFEST_FIXTURE: ManifestDataSource[] = [
  {
    sourceId: "openchargemap",
    name: "Open Charge Map",
    url: "https://openchargemap.org/",
    license: "CC-BY-SA-4.0",
    licenseUrl: "https://openchargemap.org/site/about",
    providerCountry: "gb",
    providerPrivacyUrl: "https://openchargemap.org/site/privacy",
  },
];

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let app: FastifyInstance;
let tmpDir: string;
let licenseFile: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "attribution-route-"));
  licenseFile = join(tmpDir, "license.json");
  writeFileSync(licenseFile, JSON.stringify(LICENSE_FIXTURE), "utf-8");
  const idx = await AttributionIndex.init({
    log: noopLog,
    motisLicenseFile: licenseFile,
    integrationManifests: MANIFEST_FIXTURE,
    enableMtimePoller: false,
  });
  setAttributionIndex(idx);

  const { attributionRoute } = await import("../attribution.js");
  app = Fastify({ logger: false });
  await app.register(attributionRoute, { prefix: "/api" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  setAttributionIndex(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/attribution/:sourceId", () => {
  it("returns the resolved attribution for an existing manifest sourceId", async () => {
    const res = await app.inject({ method: "GET", url: "/api/attribution/openchargemap" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sourceId).toBe("openchargemap");
    expect(body.name).toBe("Open Charge Map");
    expect(body.source).toBe("integration-manifest");
    expect(res.headers["cache-control"]).toBe("public, max-age=86400, must-revalidate");
  });

  it("returns the resolved attribution for an existing MOTIS sourceId", async () => {
    const res = await app.inject({ method: "GET", url: "/api/attribution/de_DELFI" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sourceId).toBe("de_DELFI");
    expect(body.source).toBe("motis-license");
  });

  it("returns 404 for an unknown sourceId", async () => {
    const res = await app.inject({ method: "GET", url: "/api/attribution/totally-unknown" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});

describe("GET /api/attribution", () => {
  it("returns an array with pagination metadata", async () => {
    const res = await app.inject({ method: "GET", url: "/api/attribution" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.total).toBe(2);
    expect(body.limit).toBe(200);
    expect(body.offset).toBe(0);
  });

  it("respects limit and offset", async () => {
    const first = await app.inject({ method: "GET", url: "/api/attribution?limit=1&offset=0" });
    const second = await app.inject({ method: "GET", url: "/api/attribution?limit=1&offset=1" });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstBody = first.json();
    const secondBody = second.json();
    expect(firstBody.items).toHaveLength(1);
    expect(secondBody.items).toHaveLength(1);
    expect(firstBody.items[0].sourceId).not.toBe(secondBody.items[0].sourceId);
    expect(firstBody.total).toBe(2);
  });
});

describe("GET /api/attribution/motis-file/:filename", () => {
  it("returns the attribution row for an indexed MOTIS feed file", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/attribution/motis-file/de_DELFI.gtfs.zip",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sourceId).toBe("de_DELFI");
    expect(body.source).toBe("motis-license");
  });

  it("returns 404 for an unknown filename", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/attribution/motis-file/not-a-real-file.gtfs.zip",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/attribution/health", () => {
  it("returns index counts", async () => {
    const res = await app.inject({ method: "GET", url: "/api/attribution/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toBe(2);
    expect(body.motisFeeds).toBe(1);
    expect(body.manifestSources).toBe(1);
    expect(typeof body.loadedAt).toBe("string");
  });
});
