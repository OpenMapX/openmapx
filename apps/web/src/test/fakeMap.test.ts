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
