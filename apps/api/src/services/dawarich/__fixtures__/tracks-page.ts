import type { DawarichTrackFeatureCollection } from "../contracts";

export const tracksPageFixture: DawarichTrackFeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [12.4, 45.7],
          [12.5, 45.8],
        ],
      },
      properties: { id: "track-fixture-1" },
    },
  ],
};
