import { describe, expect, it } from "vitest";
import { createOverlayStore } from "../createOverlayStore";
import { getOverlayEntry, initOverlayRegistry } from "../overlayRegistry";

describe("initOverlayRegistry metadata refresh", () => {
  it("removes an integration overlay when refreshed metadata no longer includes it", () => {
    const id = "metadata-refresh-test";
    createOverlayStore({ overlayId: id, extra: {} });
    initOverlayRegistry([
      {
        id: `overlay-${id}`,
        name: "Refresh test",
        enabled: true,
        domains: ["map-overlay"],
        frontend: { overlay: {} },
      },
    ]);
    expect(getOverlayEntry(id)?.serviceId).toBe(`overlay-${id}`);

    initOverlayRegistry([]);

    expect(getOverlayEntry(id)).toBeUndefined();
  });
});
