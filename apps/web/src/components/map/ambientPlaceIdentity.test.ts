import type { MapGeoJSONFeature, Map as MapLibreMap } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import {
  ambientBasemapKey,
  clearAmbientIdentities,
  getAmbientIdentity,
  setAmbientIdentities,
} from "./ambientPlaceIdentity";
import { stylePoiPlace } from "./MapStylePoiClickHandler";

const feature = {
  id: 42,
  source: "basemap",
  sourceLayer: "poi",
  geometry: { type: "Point", coordinates: [6.08, 50.77] },
  properties: { name: "Klinik" },
} as unknown as MapGeoJSONFeature;
const canonical = {
  id: "osm:node/9007199254740993",
  gersId: "gers-a",
  name: "Klinik",
  coordinates: [6.08, 50.77] as [number, number],
  category: "hospital",
};
describe("ambient basemap canonical identity", () => {
  it("scopes mappings to a map and removes them on teardown", () => {
    const a = {} as MapLibreMap;
    const b = {} as MapLibreMap;
    setAmbientIdentities(a, new globalThis.Map([[ambientBasemapKey(feature), canonical]]));
    expect(getAmbientIdentity(a, feature)).toEqual(canonical);
    expect(getAmbientIdentity(b, feature)).toBeUndefined();
    clearAmbientIdentities(a);
    expect(getAmbientIdentity(a, feature)).toBeUndefined();
  });
  it("uses the same canonical id and GERS in a basemap tap as tile/category selection", () => {
    const selected = stylePoiPlace({
      featureId: "42",
      name: "Klinik",
      coordinates: [6.08, 50.77],
      canonicalPlace: canonical,
    });
    expect(selected).toMatchObject({
      id: canonical.id,
      primaryScheme: "osm",
      ids: { osm: "node/9007199254740993", overture: "gers-a", gers: "gers-a" },
    });
  });
});
