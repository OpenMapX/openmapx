import { planIsochroneLattice, type TravelTimeField } from "@openmapx/mobility-core/isoline";
import { TRANSIT_WALK_PROFILE } from "@openmapx/mobility-core/transit-reachability";
import { describe, expect, it } from "vitest";
import {
  buildIsochroneFeatureCollection,
  samplingFromField,
  transitIsochroneFieldCacheKey,
  withSingleFlight,
} from "../isochrone.js";

const REQUEST = {
  origin: { lng: 13.4, lat: 52.5 },
  queryTime: "2026-09-01T08:00:00.000Z",
  direction: "depart-at" as const,
  thresholdsMinutes: [15, 30],
  walkProfileId: TRANSIT_WALK_PROFILE.id,
  bbox: [13.3, 52.45, 13.5, 52.55] as [number, number, number, number],
};

const LATTICE = planIsochroneLattice({ bbox: REQUEST.bbox, maxSamples: 400, minSpacingMetres: 10 });

function radialField(): TravelTimeField {
  const centreColumn = (LATTICE.nx - 1) / 2;
  const centreRow = (LATTICE.ny - 1) / 2;
  const values: (number | null)[] = [];
  for (let row = 0; row < LATTICE.ny; row += 1) {
    for (let column = 0; column < LATTICE.nx; column += 1) {
      values.push(Math.hypot(column - centreColumn, row - centreRow) * 120);
    }
  }
  return { lattice: LATTICE, values, batchCount: 4, unreachableCount: 0 };
}

function unreachableField(): TravelTimeField {
  const values = new Array(LATTICE.nx * LATTICE.ny).fill(null);
  return { lattice: LATTICE, values, batchCount: 1, unreachableCount: values.length };
}

const META = {
  source: "self-hosted-motis" as const,
  datasetEpoch: "epoch-1",
  attribution: [],
};

describe("transitIsochroneFieldCacheKey", () => {
  it("excludes thresholds so re-contouring is free", () => {
    const a = transitIsochroneFieldCacheKey(REQUEST, "epoch-1");
    const b = transitIsochroneFieldCacheKey({ ...REQUEST, thresholdsMinutes: [45] }, "epoch-1");
    expect(a).toBe(b);
  });

  it("includes the dataset epoch", () => {
    expect(transitIsochroneFieldCacheKey(REQUEST, "epoch-1")).not.toBe(
      transitIsochroneFieldCacheKey(REQUEST, "epoch-2"),
    );
  });

  it("includes the bbox, origin, departure minute, and modes", () => {
    const base = transitIsochroneFieldCacheKey(REQUEST, "e");
    expect(
      transitIsochroneFieldCacheKey({ ...REQUEST, bbox: [13.3, 52.45, 13.5, 52.6] }, "e"),
    ).not.toBe(base);
    expect(
      transitIsochroneFieldCacheKey({ ...REQUEST, origin: { lng: 13.5, lat: 52.5 } }, "e"),
    ).not.toBe(base);
    expect(
      transitIsochroneFieldCacheKey({ ...REQUEST, queryTime: "2026-09-01T09:00:00.000Z" }, "e"),
    ).not.toBe(base);
    expect(transitIsochroneFieldCacheKey({ ...REQUEST, transitModes: ["BUS"] }, "e")).not.toBe(
      base,
    );
  });
});

describe("buildIsochroneFeatureCollection", () => {
  it("emits one nested feature per threshold, largest first", () => {
    const collection = buildIsochroneFeatureCollection(radialField(), REQUEST, META);
    expect(collection.features).toHaveLength(2);
    expect(collection.features[0].properties?.travelTimeMinutes).toBe(30);
    expect(collection.features[1].properties?.travelTimeMinutes).toBe(15);
  });

  it("carries render properties so the existing fill layer needs no change", () => {
    const collection = buildIsochroneFeatureCollection(radialField(), REQUEST, META);
    for (const feature of collection.features) {
      expect(typeof feature.properties?.color).toBe("string");
      expect(typeof feature.properties?.opacity).toBe("number");
    }
  });

  it("carries self-describing provenance for the downloaded file", () => {
    const collection = buildIsochroneFeatureCollection(radialField(), REQUEST, META);
    const meta = (collection as unknown as { openmapx: Record<string, unknown> }).openmapx;
    expect(meta.accuracy).toBe("sampled");
    expect(meta.method).toBe("motis-one-to-many-grid");
    expect(meta.datasetEpoch).toBe("epoch-1");
    expect((meta.sampling as { resolutionMetres: number }).resolutionMetres).toBeGreaterThan(0);
  });

  it("never calls the export exact", () => {
    const collection = buildIsochroneFeatureCollection(radialField(), REQUEST, META);
    const meta = (collection as unknown as { openmapx: { accuracyNote: string } }).openmapx;
    expect(meta.accuracyNote).toMatch(/not an exact isochrone/i);
    expect(meta.accuracyNote).toMatch(/sampled/i);
  });

  it("omits a threshold that produced no geometry rather than emitting a null feature", () => {
    const collection = buildIsochroneFeatureCollection(unreachableField(), REQUEST, META);
    expect(collection.features).toHaveLength(0);
  });

  it("reports the clip so a consumer cannot mistake a cut edge for a travel-time boundary", () => {
    const sampling = samplingFromField(radialField());
    expect(sampling.clippedToBbox).toBe(LATTICE.clipped);
    expect(sampling.sampleCount).toBe(LATTICE.nx * LATTICE.ny);
  });
});

describe("withSingleFlight", () => {
  it("rejects a concurrent call for the same key", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withSingleFlight("k", async () => {
      await blocked;
      return "first";
    });
    await expect(withSingleFlight("k", async () => "second")).rejects.toThrow(/in progress/i);
    release();
    await expect(first).resolves.toBe("first");
  });

  it("releases the slot after the call settles, including on failure", async () => {
    await expect(
      withSingleFlight("k2", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withSingleFlight("k2", async () => "ok")).resolves.toBe("ok");
  });
});
