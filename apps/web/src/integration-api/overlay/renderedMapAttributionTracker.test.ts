import * as presentations from "@openmapx/core/attribution";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAttributionLabelStore } from "@/lib/attributionLabels";
import { createFakeMap, type FakeMap } from "@/test";
import { flowFeatureContributorKey, flowFeatureContributors } from "./flowContributors";
import { renderedMapAttributionTracker } from "./renderedMapAttributionTracker";

let fake: FakeMap;
const receipt: Attribution = {
  sourceId: "traffic",
  name: "Road measurements",
  attributionText: "Required measurement notice",
  licensing: {
    version: 1,
    bindings: [
      {
        scope: "data",
        subject: "Measurements",
        license: { kind: "spdx", expression: "CC-BY-4.0" },
      },
    ],
  },
};
function feature(raw: unknown, extra: Record<string, unknown> = {}): MapGeoJSONFeature {
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [6, 50],
        [7, 51],
      ],
    },
    properties: { _mapAttributions: raw, ...extra },
  } as unknown as MapGeoJSONFeature;
}
function refresh() {
  fake.emit("render");
  vi.advanceTimersByTime(250);
}
beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap();
  fake.map.addLayer({ id: "flow", type: "line", source: "traffic" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("rendered credit work scales with distinct receipts", () => {
  it("builds a shared receipt once across 63,500 segments, owners and unchanged refreshes", () => {
    const build = vi.spyOn(presentations, "buildAttributionPresentation");
    const raw = JSON.stringify([receipt]);
    fake.setRenderedFeatures(
      "flow",
      Array.from({ length: 63_500 }, () => feature(raw)),
    );
    const published: presentations.AttributionPresentation[][] = [];
    const tracker = renderedMapAttributionTracker(fake.map);
    const stop = ["area", "route"].map((owner) =>
      tracker.subscribe(owner, {
        kind: "geometry",
        layerIds: ["flow"],
        publish: (entries) => published.push(entries),
      }),
    );
    refresh();
    refresh();
    expect(published.at(-1)).toHaveLength(1);
    expect(published.at(-1)?.[0]?.fullHtml).toContain("Required measurement notice");
    expect(build).toHaveBeenCalledTimes(1);
    for (const unsubscribe of stop) unsubscribe();
  });

  it("never lends cached notices or policies to a changed receipt from the same source", () => {
    let result: presentations.AttributionPresentation[] = [];
    const stop = renderedMapAttributionTracker(fake.map).subscribe("area", {
      kind: "geometry",
      layerIds: ["flow"],
      publish: (entries) => {
        result = entries;
      },
    });
    for (const change of [
      { attributionText: "First required notice", retrievedAt: "2026-10-15" },
      {
        attributionText: "Second required notice",
        retrievedAt: "2026-10-16",
        publisher: { name: "Upstream publisher", url: "https://publisher.example" },
      },
    ]) {
      fake.setRenderedFeatures("flow", [feature(JSON.stringify([{ ...receipt, ...change }]))]);
      refresh();
      expect(result[0]?.detail).toMatchObject(change);
      expect(result[0]?.fullHtml).toContain(change.attributionText);
    }
    stop();
  });

  it("resolves repeated FLOW projection inputs once while retaining distinct display fields", () => {
    const build = vi.spyOn(presentations, "buildAttributionPresentation");
    const fields = JSON.stringify({
      geometry: [],
      ratio: [receipt],
      los: [{ sourceId: "los", name: "Declared LOS" }],
      confidence: [],
    });
    fake.setRenderedFeatures(
      "flow",
      Array.from({ length: 63_500 }, (_, i) =>
        feature(undefined, {
          segment_id: i,
          field_contributors: fields,
          speed_ratio: i % 2 ? 0.4 : null,
          los: "queuing",
        }),
      ),
    );
    let resolved = 0;
    let result: presentations.AttributionPresentation[] = [];
    const stop = renderedMapAttributionTracker(fake.map).subscribe("flow", {
      kind: "geometry",
      layerIds: ["flow"],
      featureContributorKey: (hit) => flowFeatureContributorKey(hit.properties, "color"),
      resolveFeatureContributors: (hit) => {
        resolved++;
        return flowFeatureContributors(hit.properties, "color");
      },
      publish: (entries) => {
        result = entries;
      },
    });
    refresh();
    expect(result.map((entry) => entry.detail?.sourceId).sort()).toEqual(["los", "traffic"]);
    expect(resolved).toBe(2);
    expect(build).toHaveBeenCalledTimes(2);
    stop();
  });
  it("scopes resolver keys to their owner, layer and current options", () => {
    fake.map.addLayer({ id: "other", type: "line", source: "traffic" });
    fake.setRenderedFeatures("flow", [feature(undefined)]);
    fake.setRenderedFeatures("other", [feature(undefined)]);
    const tracker = renderedMapAttributionTracker(fake.map);
    let first: presentations.AttributionPresentation[] = [];
    let second: presentations.AttributionPresentation[] = [];
    const options = {
      kind: "geometry" as const,
      layerIds: ["flow", "other"],
      featureContributorKey: () => "equal",
      resolveFeatureContributors: (hit: MapGeoJSONFeature) => [
        { sourceId: hit.layer.id, name: hit.layer.id },
      ],
      publish: (entries: presentations.AttributionPresentation[]) => {
        first = entries;
      },
    };
    const stop = tracker.subscribe("first", options);
    const stopSecond = tracker.subscribe("second", {
      ...options,
      resolveFeatureContributors: () => [{ sourceId: "second", name: "Second owner" }],
      publish: (entries) => {
        second = entries;
      },
    });
    refresh();
    expect(first.map((entry) => entry.detail?.sourceId).sort()).toEqual(["flow", "other"]);
    expect(second.map((entry) => entry.detail?.sourceId)).toEqual(["second"]);
    tracker.update("first", {
      ...options,
      resolveFeatureContributors: () => [{ sourceId: "updated", name: "New snapshot" }],
    });
    refresh();
    expect(first.map((entry) => entry.detail?.sourceId)).toEqual(["updated"]);
    stop();
    stopSecond();
  });

  it("checks paint before collapsing projection keys and never replaces invalid or empty captures with a fallback", () => {
    const tracker = renderedMapAttributionTracker(fake.map);
    let result: presentations.AttributionPresentation[] = [];
    const hidden = feature(undefined);
    hidden.layer = {
      id: "flow",
      type: "line",
      paint: { "line-opacity": 0 },
    } as MapGeoJSONFeature["layer"];
    fake.setRenderedFeatures("flow", [hidden, feature(undefined)]);
    const stop = tracker.subscribe("paint", {
      kind: "geometry",
      layerIds: ["flow"],
      featureContributorKey: () => "same",
      resolveFeatureContributors: () => [receipt],
      publish: (entries) => {
        result = entries;
      },
    });
    refresh();
    expect(result[0]?.fullHtml).toContain("Required measurement notice");
    tracker.update("paint", {
      kind: "geometry",
      layerIds: ["flow"],
      featureContributorKey: () => "undefined",
      resolveFeatureContributors: () => undefined,
      layerContributors: { flow: [{ sourceId: "fallback", name: "Uniform fallback" }] },
      publish: (entries) => {
        result = entries;
      },
    });
    fake.setRenderedFeatures("flow", [
      feature("invalid"),
      feature("[]"),
      feature(null),
      feature(JSON.stringify([receipt])),
    ]);
    refresh();
    expect(result).toHaveLength(1);
    expect(result[0]?.fullHtml).toContain("Required measurement notice");
    fake.setRenderedFeatures("flow", [feature(undefined)]);
    refresh();
    expect(result[0]?.fullHtml).toContain("Uniform fallback");
    stop();
  });

  it("retains separately supplied obligations from the same source and updates placement policies", () => {
    let result: presentations.AttributionPresentation[] = [];
    const tracker = renderedMapAttributionTracker(fake.map);
    const stop = tracker.subscribe("policies", {
      kind: "geometry",
      layerIds: ["flow"],
      publish: (entries) => {
        result = entries;
      },
    });
    const binding = receipt.licensing?.bindings[0];
    if (!binding) throw new Error("Missing fixture licence binding");
    const alwaysVisible: Attribution = {
      ...receipt,
      licensing: {
        version: 1,
        bindings: [
          {
            ...binding,
            attribution: {
              placement: "visible",
              surfaces: ["map"],
              basis: "provider-terms",
              reviewedAt: "2026-10-16",
              evidenceUrls: ["https://publisher.example/policy"],
              reason: "Required provider branding",
              compactText: "Visible provider notice",
            },
          },
        ],
      },
    };
    fake.setRenderedFeatures("flow", [
      feature(
        JSON.stringify([receipt, { ...receipt, attributionText: "Separate upstream obligation" }]),
      ),
    ]);
    refresh();
    expect(result).toHaveLength(2);
    expect(result.some((entry) => entry.fullHtml.includes("Separate upstream obligation"))).toBe(
      true,
    );
    expect(result.every((entry) => entry.visibleHtml === "")).toBe(true);
    fake.setRenderedFeatures("flow", [feature(JSON.stringify([alwaysVisible]))]);
    refresh();
    expect(result).toHaveLength(1);
    expect(result[0]?.visibleHtml).toBe("Visible provider notice");
    stop();
  });
});

describe("rendered credits in the viewer's language", () => {
  it("re-projects a modified source's credit when the viewer's wording changes", () => {
    const changed = JSON.stringify([{ ...receipt, modified: true }]);
    fake.setRenderedFeatures("flow", [feature(changed)]);
    let result: presentations.AttributionPresentation[] = [];
    const stop = renderedMapAttributionTracker(fake.map).subscribe("area", {
      kind: "geometry",
      layerIds: ["flow"],
      publish: (entries) => {
        result = entries;
      },
    });
    refresh();
    expect(result[0]?.fullHtml).toContain("data modified");
    useAttributionLabelStore.setState({ labels: { modified: "Daten verändert" } });
    refresh();
    expect(result[0]?.fullHtml).toContain("Daten verändert");
    expect(result[0]?.fullHtml).not.toContain("data modified");
    stop();
    useAttributionLabelStore.setState({ labels: { modified: "data modified" } });
  });
});
