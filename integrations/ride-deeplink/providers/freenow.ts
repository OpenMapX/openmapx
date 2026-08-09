import type { DeepLinkProvider } from "../types.js";

/**
 * FREENOW (Lyft-owned since July 2025) exposes a web booker but no documented
 * parameterised deep link, so the handoff carries no trip data.
 */
export const freenowProvider: DeepLinkProvider = {
  id: "freenow",
  name: "FREENOW",
  homepage: "https://www.free-now.com/",
  brandColor: "#FF0000",
  sourceId: "freenow",
  carriesCoordinates: false,
  build() {
    return { webUrl: "https://www.free-now.com/", carriesCoordinates: false };
  },
};
