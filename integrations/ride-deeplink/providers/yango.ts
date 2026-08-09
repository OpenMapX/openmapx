import type { DeepLinkProvider } from "../types.js";

/**
 * Yango's fare/ETA API needs a client id and API key issued by email, which
 * this credential-free integration does not carry. Until a keyed Yango
 * provider exists, the handoff is the landing page with no trip data.
 */
export const yangoProvider: DeepLinkProvider = {
  id: "yango",
  name: "Yango",
  homepage: "https://yango.com/",
  brandColor: "#FFCC00",
  sourceId: "yango",
  carriesCoordinates: false,
  build() {
    return { webUrl: "https://yango.com/", carriesCoordinates: false };
  },
};
