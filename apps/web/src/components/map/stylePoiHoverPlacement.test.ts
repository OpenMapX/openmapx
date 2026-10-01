import { describe, expect, it } from "vitest";
import { HOVER_CARD_WIDTH, hoverCardPlacement } from "./stylePoiHoverPlacement";

const NO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };
const MAP = { width: 1400, height: 900 };

describe("hoverCardPlacement", () => {
  it("centres the card under a POI in the upper half", () => {
    expect(
      hoverCardPlacement({ point: { x: 700, y: 200 }, mapSize: MAP, insets: NO_INSETS }),
    ).toEqual({ left: 700 - HOVER_CARD_WIDTH / 2, top: 214, side: "below" });
  });

  it("opens above a POI in the lower half, anchored by its bottom edge", () => {
    expect(
      hoverCardPlacement({ point: { x: 700, y: 600 }, mapSize: MAP, insets: NO_INSETS }),
    ).toEqual({ left: 550, bottom: 900 - 600 + 14, side: "above" });
  });

  it("keeps the card clear of a side panel and the far edge", () => {
    const insets = { ...NO_INSETS, left: 400 };
    expect(hoverCardPlacement({ point: { x: 420, y: 200 }, mapSize: MAP, insets }).left).toBe(408);
    expect(hoverCardPlacement({ point: { x: 1390, y: 200 }, mapSize: MAP, insets }).left).toBe(
      1400 - 8 - HOVER_CARD_WIDTH,
    );
  });

  it("splits above and below at the middle of the free area, not the whole map", () => {
    const insets = { ...NO_INSETS, top: 300 };
    expect(hoverCardPlacement({ point: { x: 700, y: 500 }, mapSize: MAP, insets }).side).toBe(
      "below",
    );
  });
});
