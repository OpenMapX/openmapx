import type { DeepLinkProvider } from "../types.js";

/**
 * Bolt publishes no consumer deep-link format and its support documentation
 * states it offers no public API, so the handoff is the plain landing page.
 * Nothing about the user's trip is placed in the URL.
 */
export const boltProvider: DeepLinkProvider = {
  id: "bolt",
  name: "Bolt",
  homepage: "https://bolt.eu/",
  brandColor: "#34D186",
  sourceId: "bolt",
  carriesCoordinates: false,
  build() {
    return { webUrl: "https://bolt.eu/", carriesCoordinates: false };
  },
};
