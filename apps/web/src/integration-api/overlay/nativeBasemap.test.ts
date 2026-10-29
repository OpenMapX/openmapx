import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { expect, it } from "vitest";
import { InstalledNativeBasemap } from "./nativeBasemap";

const receipt = (sourceId: string) => [{ sourceId, name: sourceId }];
function harness() {
  const source = {};
  const layer = { id: "land", type: "fill", source: "data" };
  const spec = {
    version: 8,
    sources: { data: { type: "vector", tiles: ["https://a/{z}/{x}/{y}"] } },
    layers: [layer],
  } as StyleSpecification;
  const map = {
    style: {},
    getStyle: () => spec,
    getLayer: () => layer,
    getSource: () => source,
  } as unknown as MapLibreMap;
  return { map, source, layer, spec };
}
it("retains installed receipts through pending/rejected requests and binds new source objects, not IDs", () => {
  const { map, spec } = harness();
  const controller = new InstalledNativeBasemap(map);
  const candidate = {
    style: spec,
    offline: false,
    sourceContributors: { data: receipt("A") },
    styleContributors: receipt("design"),
  };
  controller.adopt(candidate);
  candidate.sourceContributors.data[0].name = "mutated";
  candidate.styleContributors[0].name = "mutated-design";
  expect(controller.layers()[0].contributors.map((x) => x.name)).toEqual(["A", "design"]);
  // Same source object is retained by a style diff; new metadata is not new content.
  controller.adopt({ ...candidate, sourceContributors: { data: receipt("B") } });
  expect(controller.layers()[0].contributors[0].sourceId).toBe("A");
  map.getSource = (() => ({})) as MapLibreMap["getSource"];
  controller.adopt({ ...candidate, sourceContributors: { data: receipt("B") } });
  expect(controller.layers()).toEqual([]); // identity changed again: cannot bind unrelated source
  const replacement = {};
  map.getSource = (() => replacement) as MapLibreMap["getSource"];
  controller.adopt({ ...candidate, sourceContributors: { data: receipt("B") } });
  expect(controller.layers()[0].contributors[0].sourceId).toBe("B");
});
it("background-only style does not manufacture data receipts", () => {
  const { map, spec } = harness();
  spec.layers = [{ id: "bg", type: "background" }];
  map.getLayer = (() => spec.layers[0]) as unknown as MapLibreMap["getLayer"];
  const controller = new InstalledNativeBasemap(map);
  controller.adopt({
    style: spec,
    offline: false,
    sourceContributors: { data: receipt("OSM") },
    styleContributors: receipt("design"),
  });
  expect(controller.layers()[0].contributors.map((x) => x.sourceId)).toEqual(["design"]);
});

it("promotes only the matching installation, handling synchronous events and no-op diffs", () => {
  const { map, spec } = harness();
  const callbacks = new Map<string, () => void>();
  map.on = ((event: string, fn: () => void) => {
    callbacks.set(event, fn);
    return map;
  }) as unknown as MapLibreMap["on"];
  let actual = spec;
  map.getStyle = () => actual;
  const controller = new InstalledNativeBasemap(map);
  const changes: boolean[] = [];
  const candidate = (id: number, offline: boolean) => ({
    style: { ...spec, metadata: { "openmapx:native-basemap-generation": id } },
    offline,
    sourceContributors: { data: receipt(String(id)) },
    styleContributors: receipt("design"),
  });
  map.setStyle = ((style: StyleSpecification) => {
    actual = style;
    callbacks.get("style.load")?.();
    return map;
  }) as MapLibreMap["setStyle"];
  controller.install(candidate(1, false), (value) => changes.push(value));
  expect(changes).toEqual([false]);
  expect(controller.layers()[0].contributors[0].sourceId).toBe("1");
  map.setStyle = (() => map) as MapLibreMap["setStyle"];
  controller.install(candidate(2, true), (value) => changes.push(value));
  callbacks.get("style.load")?.(); // old event cannot relabel the retained map
  expect(changes).toEqual([false]);
  expect(controller.layers()[0].contributors[0].sourceId).toBe("1");
  actual = candidate(2, true).style;
  callbacks.get("style.load")?.();
  expect(changes).toEqual([false, true]); // unchanged source object still owns generation 1
  expect(controller.layers()[0].contributors[0].sourceId).toBe("1");
});

it("retains installed credits through full-style replacement events until matching adoption", () => {
  const { map, spec } = harness();
  const callbacks = new Map<string, () => void>();
  map.on = ((event: string, fn: () => void) => {
    callbacks.set(event, fn);
    return map;
  }) as unknown as MapLibreMap["on"];
  const controller = new InstalledNativeBasemap(map);
  controller.adopt({
    style: spec,
    offline: false,
    sourceContributors: { data: receipt("installed-data") },
    styleContributors: receipt("installed-design"),
  });
  const received: string[][] = [];
  controller.subscribe((contributors) => received.push(contributors.map((x) => x.sourceId)));
  let actual: StyleSpecification = spec;
  map.getStyle = () => actual;
  // MapLibre's unsupported-diff fallback replaces Style before loadJSON runs.
  // The incoming style emits styledata before its matching style.load event.
  map.setStyle = (() => {
    map.style = {} as MapLibreMap["style"];
    map.getLayer = (() => undefined) as MapLibreMap["getLayer"];
    map.getSource = (() => undefined) as MapLibreMap["getSource"];
    callbacks.get("styledata")?.();
    return map;
  }) as MapLibreMap["setStyle"];
  const candidate = {
    style: { ...spec, metadata: { "openmapx:native-basemap-generation": 2 } },
    offline: true,
    sourceContributors: { data: receipt("replacement-data") },
    styleContributors: receipt("replacement-design"),
  };
  controller.install(candidate, () => {});
  expect(received.at(-1)).toEqual(["installed-data", "installed-design"]);
  const late: string[][] = [];
  controller.subscribe((contributors) => late.push(contributors.map((x) => x.sourceId)));
  expect(late.at(-1)).toEqual(["installed-data", "installed-design"]);
  callbacks.get("style.load")?.(); // stale load is not the pending generation
  callbacks.get("styledata")?.(); // failed/rejected replacement never promotes
  expect(received.at(-1)).toEqual(["installed-data", "installed-design"]);
  actual = candidate.style;
  const source = {};
  map.getSource = (() => source) as MapLibreMap["getSource"];
  map.getLayer = (() => spec.layers[0]) as unknown as MapLibreMap["getLayer"];
  callbacks.get("styledata")?.(); // real engine ordering before style.load
  expect(received.at(-1)).toEqual(["installed-data", "installed-design"]);
  callbacks.get("style.load")?.();
  expect(received.at(-1)).toEqual(["replacement-data", "replacement-design"]);
  expect(late.at(-1)).toEqual(["replacement-data", "replacement-design"]);
});
