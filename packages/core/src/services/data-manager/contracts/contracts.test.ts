import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import z from "zod/v4";
import { rightsEvidenceSchema } from "../../../coverage/schemas";
import {
  ambientPlacesStatusSchema,
  dataManagerOperations,
  datasetMetadataSchema,
  offlinePackagePreparationSchema,
  overtureConflateEventSchema,
  searchIndexEventSchema,
} from "./index";

describe("data-manager wire contracts", () => {
  it("owns all 49 explicit operations with two named glyph HEAD/GET contracts", () => {
    expect(Object.keys(dataManagerOperations)).toHaveLength(49);
    expect(dataManagerOperations.getOfflineGlyph.path).toBe(
      "/offline/packages/glyphs/:version/:fontstack/:range.pbf",
    );
    expect(dataManagerOperations.headOfflineGlyph.method).toBe("HEAD");
  });
  it("matches the exact reviewed explicit operation inventory", () => {
    const inventory = JSON.parse(
      readFileSync(new URL("./__fixtures__/reviewed-surface.json", import.meta.url), "utf8"),
    ) as { operations: Array<{ method: string; path: string }> };
    const expected = inventory.operations
      .map(
        ({ method, path }) =>
          `${method} ${path.replace("/:version/*", "/:version/:fontstack/:range.pbf")}`,
      )
      .sort();
    const actual = Object.values(dataManagerOperations)
      .map(({ method, path }) => `${method} ${path}`)
      .sort();
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });
  it("retains dataset checksum and rejects manufactured reload success", () => {
    const value = {
      type: "osm-pbf",
      id: "de",
      sizeBytes: 5,
      downloadedAt: "2026-10-19T00:00:00.000Z",
      path: "/data/de.pbf",
      md5: "checksum",
    };
    expect(datasetMetadataSchema.parse(value)).toEqual(value);
    expect(dataManagerOperations.reloadDatasets.responses[200].schema.safeParse({}).success).toBe(
      false,
    );
  });
  it("rejects dataset inventory entries without a filesystem path", () => {
    expect(
      datasetMetadataSchema.safeParse({
        type: "osm-pbf",
        id: "de",
        sizeBytes: 5,
        downloadedAt: "2026-10-19T00:00:00.000Z",
        path: "",
      }).success,
    ).toBe(false);
  });
  it("keeps readiness failures separate from successful readiness", () => {
    const body = {
      ok: false,
      status: "starting",
      phase: "offline-storage",
      uptime: 1,
      dataDir: "/data",
    };
    expect(dataManagerOperations.getStatus.responses[503].schema.parse(body)).toEqual(body);
    expect(dataManagerOperations.getStatus.responses[200].schema.safeParse(body).success).toBe(
      false,
    );
  });
  it("requires build provenance and keeps unsuccessful conflation outcomes", () => {
    expect(
      searchIndexEventSchema.safeParse({
        event: "done",
        ok: true,
        region: "de",
        epoch: "x",
        placeCount: 1,
        termCount: 2,
      }).success,
    ).toBe(false);
    expect(
      overtureConflateEventSchema.parse({
        event: "done",
        ok: false,
        status: "waiting_for_osm",
        linked: 0,
        pbfPath: "/data/a",
        message: "missing",
      }),
    ).toMatchObject({ ok: false });
    expect(
      overtureConflateEventSchema.safeParse({
        event: "done",
        ok: true,
        status: "waiting_for_osm",
        linked: 0,
        pbfPath: "/data/a",
      }).success,
    ).toBe(false);
  });
  it("retains durable ambient cursor provenance", () => {
    const checkpoint = {
      phase: "osm",
      processed: 1,
      batches: 2,
      placeCount: 3,
      osmType: "node",
      osmId: "1",
      gers: "",
      osmProcessed: 4,
      overtureProcessed: 5,
      osmCount: 6,
      overtureCount: 7,
      legacyAttribution: true,
    };
    const body = {
      active: null,
      previous: null,
      building: true,
      lastError: null,
      progress: checkpoint,
      candidate: {
        generation: "00000000-0000-0000-0000-000000000000",
        status: "running",
        checkpoint,
        error: null,
        startedAt: "2026-10-19T00:00:00.000Z",
        updatedAt: "2026-10-19T00:00:00.000Z",
      },
    };
    expect(ambientPlacesStatusSchema.parse(body).candidate?.checkpoint).toEqual(checkpoint);
  });
  it("models pinned catalog rows independently from desired source state", () => {
    const body = {
      sources: [
        {
          id: "de:x",
          region: "de",
          name: "x",
          format: "gtfs",
          license: { attribution: "operator", nested: { terms: true } },
        },
      ],
    };
    expect(dataManagerOperations.getTransitCatalog.responses[200].schema.parse(body)).toEqual(body);
  });
  it("retains the reservation conflict before the job ID exists", () => {
    const body = { ok: false, reason: "in-flight", existingJobId: null };
    expect(dataManagerOperations.syncTransit.responses[409].schema.parse(body)).toEqual(body);
  });
  it("keeps an invalid offline request in its failed job without inventing a valid request", () => {
    const request = {
      bbox: { west: 0, south: 0, east: 1, north: 1 },
      minZoom: -1,
      maxZoom: 3,
      provider: "openmapx",
    };
    const body = {
      jobId: "failed-job",
      status: "failed",
      errorCode: "invalid-request",
      errorMessage: "minZoom must be non-negative",
      request: {
        request,
        effective: { bbox: request.bbox, minZoom: -1, maxZoom: 3 },
        requestKey: "invalid-x",
        source: {
          datasetId: "openmapx",
          datasetVersion: "x",
          sourceMaxZoom: 14,
          sourceBounds: request.bbox,
          tileSchema: "openmaptiles",
          glyphsVersion: "x",
          packageAlgorithmVersion: "x",
          attribution: ["OSM"],
        },
      },
    };
    expect(offlinePackagePreparationSchema.parse(body)).toEqual(body);
  });
  it("rejects ready offline jobs missing the published manifest", () => {
    const request = {
      bbox: { west: 0, south: 0, east: 1, north: 1 },
      minZoom: 1,
      maxZoom: 3,
      provider: "openmapx",
    };
    const body = {
      jobId: "job",
      status: "ready-to-download",
      packageId: `omp2-${"a".repeat(64)}`,
      request: {
        request,
        effective: { bbox: request.bbox, minZoom: 1, maxZoom: 3 },
        requestKey: "x",
        source: {
          datasetId: "openmapx",
          datasetVersion: "x",
          sourceMaxZoom: 14,
          sourceBounds: request.bbox,
          tileSchema: "openmaptiles",
          glyphsVersion: "x",
          packageAlgorithmVersion: "x",
          attribution: ["OSM"],
        },
      },
    };
    expect(offlinePackagePreparationSchema.safeParse(body).success).toBe(false);
  });
  it("requires source identity when offline capability reports availability", () => {
    expect(
      dataManagerOperations.getOfflinePackageCapability.responses[200].schema.safeParse({
        available: true,
        provider: "openmapx",
      }).success,
    ).toBe(false);
    expect(
      dataManagerOperations.getOfflinePackageCapability.responses[200].schema.parse({
        available: false,
        provider: "openmapx",
        reason: "source-unavailable",
      }),
    ).toMatchObject({ available: false });
  });
  it("retains HTTP response header contracts for ranges and quotas", () => {
    expect(
      dataManagerOperations.getOfflinePackageArchive.responses[206].headers.safeParse({
        "accept-ranges": "bytes",
        "content-type": "application/vnd.pmtiles",
        "content-length": "3",
        "cache-control": "public, max-age=31536000, immutable",
        etag: `sha256-${"a".repeat(64)}`,
      }).success,
    ).toBe(false);
    expect(
      dataManagerOperations.prepareOfflinePackage.responses[429].headers?.parse({
        "retry-after": "30",
        connection: "keep-alive",
      }),
    ).toEqual({ "retry-after": "30" });
    expect(
      dataManagerOperations.getOfflinePackageArchive.responses[503].headers?.parse({
        "retry-after": "10",
      }),
    ).toEqual({ "retry-after": "10" });
  });
  it("keeps portable licensing structured and preserves semantic checks", () => {
    const body = {
      key: "k",
      qualifiedDatasetKey: "d",
      owner: { kind: "service", id: "data-manager" },
      sourceId: "s",
      commercialUse: "yes",
      redistribution: { sourceData: "yes", derivedData: "yes" },
      usageConditions: [],
      lineageKnown: true,
      licensing: {
        version: 1,
        bindings: [
          { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC0-1.0" } },
        ],
      },
    };
    expect(rightsEvidenceSchema.parse(body)).toEqual(body);
    expect(
      rightsEvidenceSchema.safeParse({
        ...body,
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "Data",
              license: { kind: "spdx", expression: "not-a-real-license" },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
  it("exports every operation schema to JSON Schema without erasing structure", () => {
    for (const operation of Object.values(dataManagerOperations)) {
      for (const schema of Object.values("request" in operation ? operation.request : {}))
        z.toJSONSchema(schema, { io: "output" });
      for (const response of Object.values(operation.responses)) {
        if ("schema" in response)
          expect(z.toJSONSchema(response.schema, { io: "output" })).toHaveProperty("$schema");
        if ("headers" in response && response.headers)
          z.toJSONSchema(response.headers, { io: "output" });
      }
    }
  });
});
