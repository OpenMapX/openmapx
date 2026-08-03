import { describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";
import { createGeoJsonSourceDataBridge } from "./layerStyleUtils";

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

function point(lng: number) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Point" as const, coordinates: [lng, 50] },
      },
    ],
  };
}

describe("createGeoJsonSourceDataBridge", () => {
  it("retains data until the source exists, then reapplies it after recreation", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const bridge = createGeoJsonSourceDataBridge();
    const data = point(8);

    bridge.publish([{ sourceId: "source", data }]);
    expect(bridge.apply(fake.map)).toEqual({
      status: "waiting",
      missingSourceIds: ["source"],
    });

    fake.map.addSource("source", { type: "geojson", data: EMPTY_FC });
    expect(bridge.apply(fake.map)).toEqual({ status: "applied" });
    expect(fake.state.sources.get("source")?.data).toEqual(data);

    fake.map.removeSource("source");
    fake.map.addSource("source", { type: "geojson", data: EMPTY_FC });
    expect(bridge.apply(fake.map)).toEqual({ status: "applied" });
    expect(fake.state.sources.get("source")?.data).toEqual(data);
  });

  it("does not partially apply a multi-source update while a source is missing", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const bridge = createGeoJsonSourceDataBridge();
    const lines = point(8);
    const markers = point(9);

    bridge.publish([
      { sourceId: "lines", data: lines },
      { sourceId: "markers", data: markers },
    ]);
    fake.map.addSource("lines", { type: "geojson", data: EMPTY_FC });

    expect(bridge.apply(fake.map)).toEqual({
      status: "waiting",
      missingSourceIds: ["markers"],
    });
    expect(fake.state.sources.get("lines")?.data).toEqual(EMPTY_FC);

    fake.map.addSource("markers", { type: "geojson", data: EMPTY_FC });
    expect(bridge.apply(fake.map)).toEqual({ status: "applied" });
    expect(fake.state.sources.get("lines")?.data).toEqual(lines);
    expect(fake.state.sources.get("markers")?.data).toEqual(markers);
  });

  it("retains only the newest payload published while the source is absent", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const bridge = createGeoJsonSourceDataBridge();

    bridge.publish([{ sourceId: "source", data: point(1) }]);
    bridge.publish([{ sourceId: "source", data: point(2) }]);
    fake.map.addSource("source", { type: "geojson", data: EMPTY_FC });

    expect(bridge.apply(fake.map)).toEqual({ status: "applied" });
    expect(fake.state.sources.get("source")?.data).toEqual(point(2));
  });

  it("uses updateData only for an already-applied source object", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const bridge = createGeoJsonSourceDataBridge();
    const first = point(1);
    const second = point(2);
    const diff = { add: second.features };

    fake.map.addSource("source", { type: "geojson", data: EMPTY_FC });
    const source = fake.state.sources.get("source");
    if (!source) throw new Error("test source was not created");
    source.updateData = vi.fn();
    bridge.publish([{ sourceId: "source", data: first }]);
    bridge.apply(fake.map);

    bridge.publish([{ sourceId: "source", data: second, update: diff }]);
    expect(bridge.apply(fake.map)).toEqual({ status: "applied" });
    expect(source.updateData).toHaveBeenCalledWith(diff);
  });

  it("falls back to full data when a source is recreated before an incremental update", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const bridge = createGeoJsonSourceDataBridge();
    const first = point(1);
    const second = point(2);

    fake.map.addSource("source", { type: "geojson", data: EMPTY_FC });
    bridge.publish([{ sourceId: "source", data: first }]);
    bridge.apply(fake.map);
    bridge.publish([{ sourceId: "source", data: second, update: { add: second.features } }]);

    fake.map.removeSource("source");
    fake.map.addSource("source", { type: "geojson", data: EMPTY_FC });
    const recreated = fake.state.sources.get("source");
    if (!recreated) throw new Error("test source was not recreated");
    recreated.updateData = vi.fn();

    expect(bridge.apply(fake.map)).toEqual({ status: "applied" });
    expect(recreated.updateData).not.toHaveBeenCalled();
    expect(recreated.data).toEqual(second);
  });

  it("falls back to full data when an incremental revision was skipped", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const bridge = createGeoJsonSourceDataBridge();
    const first = point(1);
    const second = point(2);
    const third = point(3);

    fake.map.addSource("source", { type: "geojson", data: EMPTY_FC });
    bridge.publish([{ sourceId: "source", data: first }]);
    bridge.apply(fake.map);

    bridge.publish([{ sourceId: "source", data: second, update: { add: second.features } }]);
    bridge.publish([{ sourceId: "source", data: third, update: { add: third.features } }]);
    const source = fake.state.sources.get("source");
    if (!source) throw new Error("test source was not created");
    source.updateData = vi.fn();

    bridge.apply(fake.map);

    expect(source.updateData).not.toHaveBeenCalled();
    expect(source.data).toEqual(third);
  });

  it("reports an incompatible source separately from a missing source", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const bridge = createGeoJsonSourceDataBridge();
    bridge.publish([
      { sourceId: "missing", data: point(1) },
      { sourceId: "vector", data: point(2) },
    ]);
    fake.map.addSource("vector", { type: "vector", tiles: [] });

    expect(bridge.apply(fake.map)).toEqual({
      status: "incompatible",
      incompatibleSources: [{ sourceId: "vector", sourceType: "vector" }],
      missingSourceIds: ["missing"],
    });
    expect(fake.state.sources.get("vector")?.data).toBeUndefined();
  });
});
