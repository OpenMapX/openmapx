import { DEFAULT_CONFLATION_THRESHOLDS } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import {
  computeLinks,
  type OsmPoiPoint,
  type OverturePlacePoint,
} from "../../src/jobs/overture/conflate.js";

const RELEASE = "2026-06-17.0";

function makePlace(
  overrides: Partial<OverturePlacePoint> & Pick<OverturePlacePoint, "gersId" | "lat" | "lng">,
): OverturePlacePoint {
  return {
    name: "Test Place",
    h3_r8: null,
    confidence: 0.9,
    ...overrides,
  };
}

function makeOsm(
  overrides: Partial<OsmPoiPoint> & Pick<OsmPoiPoint, "osm_id" | "lat" | "lng">,
): OsmPoiPoint {
  return {
    osm_type: "node",
    name: "Test Place",
    h3_r8: null,
    ...overrides,
  };
}

const BASE_LAT = 52.5;
const BASE_LNG = 13.4;

function offsetLatLng(lat: number, lng: number, metersNorth: number, metersEast: number) {
  const dLat = metersNorth / 111320;
  const dLng = metersEast / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

describe("computeLinks", () => {
  it("exact match (≤25m, same name): yields LinkRecord with method 'spatial-name'", async () => {
    const osmPoi = makeOsm({ osm_id: 1, lat: BASE_LAT, lng: BASE_LNG, name: "Café Berlin" });
    const place = makePlace({
      gersId: "gers-1",
      lat: BASE_LAT + 0.0001,
      lng: BASE_LNG + 0.0001,
      name: "Café Berlin",
    });

    const links = await computeLinks([place], [osmPoi], {
      thresholds: DEFAULT_CONFLATION_THRESHOLDS,
      release: RELEASE,
    });

    expect(links).toHaveLength(1);
    expect(links[0].method).toBe("spatial-name");
    expect(links[0].gers_id).toBe("gers-1");
    expect(links[0].osm_id).toBe(1);
    expect(links[0].release).toBe(RELEASE);
  });

  it("in-window pair (50m, name dice < 0.8): mock embedFn returns high cosine → method 'embedding'", async () => {
    const offset = offsetLatLng(BASE_LAT, BASE_LNG, 50, 0);
    const osmPoi = makeOsm({ osm_id: 2, lat: BASE_LAT, lng: BASE_LNG, name: "Espresso Bar" });
    const place = makePlace({
      gersId: "gers-2",
      lat: offset.lat,
      lng: offset.lng,
      name: "Coffee Shop Downtown",
    });

    const vec1 = [1, 0, 0];
    const vec2 = [0.99, 0.01, 0];
    const embedFn = vi.fn(async (texts: string[]) => texts.map((_, i) => (i === 0 ? vec1 : vec2)));

    const links = await computeLinks([place], [osmPoi], {
      thresholds: DEFAULT_CONFLATION_THRESHOLDS,
      embedFn,
      cosineFloor: 0.87,
      release: RELEASE,
    });

    const embeddingLinks = links.filter((l) => l.method === "embedding");
    expect(embeddingLinks.length).toBeGreaterThan(0);
    expect(embeddingLinks[0].gers_id).toBe("gers-2");
  });

  it("out-of-window pair (distance > softWindowM): no link, embedFn not called", async () => {
    const farOffset = offsetLatLng(BASE_LAT, BASE_LNG, 200, 0);
    const osmPoi = makeOsm({ osm_id: 3, lat: BASE_LAT, lng: BASE_LNG, name: "Bakery" });
    const place = makePlace({
      gersId: "gers-3",
      lat: farOffset.lat,
      lng: farOffset.lng,
      name: "Bakery",
    });

    const embedFn = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));

    const links = await computeLinks([place], [osmPoi], {
      thresholds: DEFAULT_CONFLATION_THRESHOLDS,
      embedFn,
      release: RELEASE,
    });

    expect(links).toHaveLength(0);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it("embedFn omitted: only spatial-name links returned, no embedding links", async () => {
    const osmPoi = makeOsm({ osm_id: 4, lat: BASE_LAT, lng: BASE_LNG, name: "Museum" });
    const nearOffset = offsetLatLng(BASE_LAT, BASE_LNG, 50, 0);
    const place = makePlace({
      gersId: "gers-4",
      lat: nearOffset.lat,
      lng: nearOffset.lng,
      name: "Different Name Museum",
    });

    const links = await computeLinks([place], [osmPoi], {
      thresholds: DEFAULT_CONFLATION_THRESHOLDS,
      release: RELEASE,
    });

    const embeddingLinks = links.filter((l) => l.method === "embedding");
    expect(embeddingLinks).toHaveLength(0);
  });

  it("two Overture places both within range of same OSM poi: only best-confidence one in result", async () => {
    const osmPoi = makeOsm({ osm_id: 5, lat: BASE_LAT, lng: BASE_LNG, name: "Bookstore" });

    const offset1 = offsetLatLng(BASE_LAT, BASE_LNG, 10, 0);
    const place1 = makePlace({
      gersId: "gers-5a",
      lat: offset1.lat,
      lng: offset1.lng,
      name: "Bookstore",
      confidence: 0.95,
    });

    const offset2 = offsetLatLng(BASE_LAT, BASE_LNG, 20, 0);
    const place2 = makePlace({
      gersId: "gers-5b",
      lat: offset2.lat,
      lng: offset2.lng,
      name: "Bookstore",
      confidence: 0.7,
    });

    const links = await computeLinks([place1, place2], [osmPoi], {
      thresholds: DEFAULT_CONFLATION_THRESHOLDS,
      release: RELEASE,
    });

    const osmLinks = links.filter((l) => l.osm_type === "node" && l.osm_id === 5);
    expect(osmLinks).toHaveLength(1);
  });
});
