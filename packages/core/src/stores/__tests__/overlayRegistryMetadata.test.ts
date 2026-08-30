import { describe, expect, it } from "vitest";
import { createOverlayStore } from "../createOverlayStore";
import { getOverlayEntry, initOverlayRegistry, integrationIdToOverlayId } from "../overlayRegistry";

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

  it("preserves the air-quality overlay identity across the frontend ownership move", () => {
    expect(integrationIdToOverlayId("air-quality")).toBe("air-quality");
    expect(integrationIdToOverlayId("overlay-air-quality")).toBe("air-quality");
  });

  it("rejects two enabled frontend owners for one overlay identity", () => {
    expect(() =>
      initOverlayRegistry([
        {
          id: "air-quality",
          name: "Canonical air quality",
          enabled: true,
          domains: ["air-quality"],
          frontend: { overlay: {} },
        },
        {
          id: "overlay-air-quality",
          name: "Legacy OpenAQ",
          enabled: true,
          domains: ["air-quality"],
          frontend: { mapLayer: true },
        },
      ]),
    ).toThrow(/multiple enabled frontend owners.*air-quality/i);
  });
});
