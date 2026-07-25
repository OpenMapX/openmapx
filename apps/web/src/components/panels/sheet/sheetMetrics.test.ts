import { describe, expect, it } from "vitest";
import { peekContentHeight, visibleSheetHeight } from "./sheetMetrics";

// The host scrolls a track whose extra scrollable length equals the sheet's
// max height: at scrollTop 0 nothing shows, at max scroll the sheet fills the
// host. clientHeight 800, scrollHeight 1600 => maxScroll 800.
const geo = (scrollTop: number) => ({ scrollTop, scrollHeight: 1600, clientHeight: 800 });

describe("visibleSheetHeight", () => {
  it("is zero when the sheet is scrolled fully away", () => {
    expect(visibleSheetHeight(geo(0))).toBe(0);
  });

  it("is the full host height at maximum scroll", () => {
    expect(visibleSheetHeight(geo(800))).toBe(800);
  });

  it("tracks intermediate positions linearly", () => {
    expect(visibleSheetHeight(geo(200))).toBe(200);
    expect(visibleSheetHeight(geo(624))).toBe(624);
  });

  it("clamps rubber-band overscroll on both ends", () => {
    expect(visibleSheetHeight(geo(-40))).toBe(0);
    expect(visibleSheetHeight(geo(900))).toBe(800);
  });

  it("is zero rather than negative for a degenerate unlaid-out host", () => {
    expect(visibleSheetHeight({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(0);
  });

  // Real readings from a Pixel 6 Pro and from iOS Safari, both at full
  // expansion. The scroll track is not exactly twice the host height there, so
  // the two bounds differ — and scrollTop can sit a pixel past the track's end.
  // The fixture above cannot tell the two clamps apart; these can.
  it("never reports more than the host height when the track overshoots it", () => {
    expect(visibleSheetHeight({ scrollTop: 726, scrollHeight: 1448, clientHeight: 723 })).toBe(723);
    expect(visibleSheetHeight({ scrollTop: 674, scrollHeight: 1345, clientHeight: 671 })).toBe(671);
  });
});

describe("peekContentHeight", () => {
  // Real numbers off a place card: the marked subtree measures 162px while the
  // sheet is open, of which a 26px meta block disappears at peek, under a 20px
  // sticky header band. Aiming at 182 would land and then drop to 156.
  it("discounts the parts the panel drops at peek", () => {
    expect(peekContentHeight(162, [26], 20)).toBe(156);
  });

  // The point of the discount: the same target either way, so collapsing has
  // nothing left to correct once it arrives.
  it("is the same whether or not those parts are currently rendered", () => {
    expect(peekContentHeight(162, [26], 20)).toBe(peekContentHeight(136, [], 20));
  });

  it("sums several discounted regions", () => {
    expect(peekContentHeight(200, [10, 15, 5], 0)).toBe(170);
  });

  it("never returns a negative height", () => {
    expect(peekContentHeight(40, [80], 0)).toBe(0);
  });
});
