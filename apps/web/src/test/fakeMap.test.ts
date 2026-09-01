import { describe, expect, it } from "vitest";
import { createFakeMap } from "./fakeMap";

describe("fake map setStyle", () => {
  it("drops every source and layer the app added, and restores the base style", () => {
    const fake = createFakeMap({
      styleLoaded: true,
      baseLayers: [{ id: "place-labels", type: "symbol" }],
    });
    fake.map.addSource("app-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    fake.map.addLayer({ id: "app-layer", type: "line", source: "app-src" } as never);

    fake.map.setStyle({} as never);

    expect(fake.state.sources.has("app-src")).toBe(false);
    expect(fake.state.layers.has("app-layer")).toBe(false);
    expect([...fake.state.layers.keys()]).toEqual(["place-labels"]);
  });

  it("fires style.load synchronously inside setStyle, before styledata", () => {
    const fake = createFakeMap({ styleLoaded: true });
    const seen: string[] = [];
    fake.map.on("style.load", () => seen.push("style.load"));
    fake.map.on("styledata", () => seen.push("styledata"));

    let returned = false;
    fake.map.on("style.load", () => seen.push(returned ? "after-return" : "inside-setStyle"));
    fake.map.setStyle({} as never);
    returned = true;

    expect(seen).toEqual(["style.load", "inside-setStyle", "styledata"]);
  });

  it("lets a style.load listener re-add sources and layers", () => {
    const fake = createFakeMap({ styleLoaded: true });
    fake.map.on("style.load", () => {
      fake.map.addSource("app-src", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    });

    fake.map.setStyle({} as never);

    expect(fake.state.sources.has("app-src")).toBe(true);
  });
});

describe("fake map operation counters", () => {
  it("counts setData per source id and not for unrelated sources", () => {
    const fake = createFakeMap({ styleLoaded: true });
    fake.map.addSource("a", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    fake.map.addSource("b", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

    (fake.state.sources.get("a")?.setData as (d: unknown) => void)({
      type: "FeatureCollection",
      features: [],
    });
    (fake.state.sources.get("a")?.setData as (d: unknown) => void)({
      type: "FeatureCollection",
      features: [],
    });

    expect(fake.state.counts.setData.get("a")).toBe(2);
    expect(fake.state.counts.setData.get("b")).toBeUndefined();
  });

  it("counts setPaintProperty per layer id and per layer+property name", () => {
    const fake = createFakeMap({ styleLoaded: true });
    fake.map.addLayer({ id: "line", type: "line", source: "src" } as never);

    fake.map.setPaintProperty("line", "line-gradient", ["get", "a"]);
    fake.map.setPaintProperty("line", "line-gradient", ["get", "b"]);
    fake.map.setPaintProperty("line", "line-color", "#000");

    expect(fake.state.counts.setPaintProperty.get("line")).toBe(3);
    expect(fake.state.counts.setPaintPropertyByName.get("line:line-gradient")).toBe(2);
    expect(fake.state.counts.setPaintPropertyByName.get("line:line-color")).toBe(1);
  });

  it("does not mutate the caller's own layer spec object when setPaintProperty is called", () => {
    // Real MapLibre never retains or mutates the spec object passed to
    // `addLayer` — it builds its own internal `StyleLayer` state from it.
    // A caller that memoizes its layer descriptor (as several map-layer
    // components do, to avoid rebuilding it every render) relies on that
    // object staying exactly as it was created. If the fake aliased it
    // instead of copying, `setPaintProperty` would silently rewrite the
    // memoized descriptor in place, and a later render would see a "changed"
    // spec that was never actually changed by the caller.
    const fake = createFakeMap({ styleLoaded: true });
    const paint = { "line-color": "#000", "line-width": 4 };
    const spec = { id: "line", type: "line", source: "src", paint } as never;

    fake.map.addLayer(spec);
    fake.map.setPaintProperty("line", "line-gradient", ["get", "a"]);

    expect(paint).toEqual({ "line-color": "#000", "line-width": 4 });
    expect(fake.state.paint.get("line")).toEqual({
      "line-color": "#000",
      "line-width": 4,
      "line-gradient": ["get", "a"],
    });
  });

  it("does not count setPaintProperty on an unrelated layer", () => {
    const fake = createFakeMap({ styleLoaded: true });
    fake.map.addLayer({ id: "line-a", type: "line", source: "src" } as never);
    fake.map.addLayer({ id: "line-b", type: "line", source: "src" } as never);

    fake.map.setPaintProperty("line-a", "line-gradient", ["get", "a"]);

    expect(fake.state.counts.setPaintProperty.get("line-b")).toBeUndefined();
  });

  it("counts setFilter per layer id", () => {
    const fake = createFakeMap({ styleLoaded: true });
    fake.map.addLayer({ id: "line", type: "line", source: "src" } as never);

    fake.map.setFilter("line", ["==", "a", 1]);
    fake.map.setFilter("line", ["==", "a", 2]);

    expect(fake.state.counts.setFilter.get("line")).toBe(2);
  });

  it("counts addLayer and removeLayer per layer id", () => {
    const fake = createFakeMap({ styleLoaded: true });
    fake.map.addLayer({ id: "line", type: "line", source: "src" } as never);
    fake.map.removeLayer("line");
    fake.map.addLayer({ id: "line", type: "line", source: "src" } as never);

    expect(fake.state.counts.addLayer.get("line")).toBe(2);
    expect(fake.state.counts.removeLayer.get("line")).toBe(1);
  });

  it("counts addLayer/setData/setPaintProperty/setFilter through addSource replacement (style swap)", () => {
    const fake = createFakeMap({ styleLoaded: true });
    fake.map.addSource("src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    fake.map.addLayer({
      id: "line",
      type: "line",
      source: "src",
      paint: { "line-gradient": ["get", "a"] },
      filter: ["==", "a", 1],
    } as never);

    fake.map.setStyle({} as never);
    fake.map.addSource("src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    fake.map.addLayer({
      id: "line",
      type: "line",
      source: "src",
      paint: { "line-gradient": ["get", "a"] },
      filter: ["==", "a", 1],
    } as never);
    (fake.state.sources.get("src")?.setData as (d: unknown) => void)({
      type: "FeatureCollection",
      features: [],
    });
    fake.map.setPaintProperty("line", "line-gradient", ["get", "b"]);
    fake.map.setFilter("line", ["==", "a", 2]);

    // Counters are cumulative across the rebuild, proving the layer was
    // re-added exactly once (not silently dropped) while also surviving
    // the style change themselves (not reset to zero by setStyle).
    expect(fake.state.counts.addLayer.get("line")).toBe(2);
    expect(fake.state.counts.setData.get("src")).toBe(1);
    expect(fake.state.counts.setPaintProperty.get("line")).toBe(1);
    expect(fake.state.counts.setFilter.get("line")).toBe(1);
  });

  it("survives setStyle without being reset, so a before/after snapshot can isolate a fresh window", () => {
    const fake = createFakeMap({ styleLoaded: true });
    fake.map.addLayer({ id: "line", type: "line", source: "src" } as never);
    fake.map.setPaintProperty("line", "line-gradient", ["get", "a"]);

    const before = fake.state.counts.setPaintProperty.get("line") ?? 0;
    fake.map.setStyle({} as never);
    fake.map.addLayer({ id: "line", type: "line", source: "src" } as never);
    fake.map.setPaintProperty("line", "line-gradient", ["get", "b"]);
    const after = fake.state.counts.setPaintProperty.get("line") ?? 0;

    expect(after - before).toBe(1);
  });
});

describe("fake map interaction controls", () => {
  it("records generic and delegated listener lifecycle calls with their exact handler identity", () => {
    const fake = createFakeMap();
    const generic = () => {};
    const delegated = () => {};

    fake.map.on("styledata", generic);
    fake.map.on("click", "hotspots", delegated);
    fake.map.off("click", "hotspots", delegated);
    fake.map.off("styledata", generic);

    expect(fake.state.listenerCalls).toEqual([
      { method: "on", event: "styledata", layerId: undefined, handler: generic },
      { method: "on", event: "click", layerId: "hotspots", handler: delegated },
      { method: "off", event: "click", layerId: "hotspots", handler: delegated },
      { method: "off", event: "styledata", layerId: undefined, handler: generic },
    ]);
  });

  it("exposes a focusable canvas for keyboard interaction tests", () => {
    const fake = createFakeMap();
    document.body.appendChild(fake.state.canvas);
    fake.state.canvas.focus();
    expect(document.activeElement).toBe(fake.state.canvas);
    fake.state.canvas.remove();
  });

  it("returns rendered hits only from requested layers", () => {
    const fake = createFakeMap();
    const poi = { id: "poi" } as never;
    const overlay = { id: "overlay" } as never;
    fake.setRenderedFeatures("poi-label", [poi]);
    fake.setRenderedFeatures("overlay-layer", [overlay]);
    expect(
      fake.map.queryRenderedFeatures({ x: 0, y: 0 } as never, { layers: ["poi-label"] }),
    ).toEqual([poi]);
  });
});

describe("camera recording", () => {
  it("records flyTo, fitBounds, setPadding and reports padding back", () => {
    const fake = createFakeMap({ containerWidth: 1000, containerHeight: 500 });
    expect(fake.map.getContainer().clientWidth).toBe(1000);
    expect(fake.map.getPadding()).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    fake.map.setPadding({ top: 1, bottom: 2, left: 3, right: 4 }, { programmatic: true });
    expect(fake.map.getPadding()).toEqual({ top: 1, bottom: 2, left: 3, right: 4 });
    fake.map.flyTo({ center: [8, 50], zoom: 12 }, { programmatic: true });
    fake.map.fitBounds(
      [
        [0, 0],
        [1, 1],
      ],
      { padding: 10 },
    );
    expect(fake.state.cameraTransitions.map((t) => t.method)).toEqual([
      "setPadding",
      "flyTo",
      "fitBounds",
    ]);
    expect(fake.state.center).toEqual({ lng: 8, lat: 50 });
  });

  it("answers cameraForBounds with the bounds midpoint and records the call", () => {
    const fake = createFakeMap({ zoom: 9 });
    const camera = fake.map.cameraForBounds(
      [
        [0, 0],
        [2, 4],
      ],
      { padding: 5 },
    );
    expect(camera).toEqual({ center: { lng: 1, lat: 2 }, zoom: 9, bearing: 0 });
    expect(fake.state.cameraForBoundsCalls).toEqual([
      {
        bounds: [
          [0, 0],
          [2, 4],
        ],
        options: { padding: 5 },
      },
    ]);
  });

  it("projects through the supplied projection and exposes isMoving", () => {
    const fake = createFakeMap({ project: ([lng, lat]) => ({ x: lng * 10, y: -lat * 10 }) });
    expect(fake.map.project([1, 2])).toEqual({ x: 10, y: -20 });
    expect(fake.map.isMoving()).toBe(false);
    fake.state.moving = true;
    expect(fake.map.isMoving()).toBe(true);
  });
});
