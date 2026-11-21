import type { DawarichTrackFeatureCollection } from "../contracts";

export const trackFeatureFixture: DawarichTrackFeatureCollection["features"][number] = {
  type: "Feature",
  geometry: {
    type: "LineString",
    coordinates: [
      [12.4, 45.7],
      [12.5, 45.8],
    ],
  },
  properties: { id: "track-fixture-1" },
};

export const tracksPageFixture: DawarichTrackFeatureCollection = {
  type: "FeatureCollection",
  features: [trackFeatureFixture],
};
