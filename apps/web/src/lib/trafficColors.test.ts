import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TRAFFIC_TEXT_COLOR } from "@/integration-api/runtime/theme";

describe("TRAFFIC_TEXT_COLOR", () => {
  it("has no freeFlow entry, which would imply a verified-clear route", () => {
    expect(Object.hasOwn(TRAFFIC_TEXT_COLOR, "freeFlow")).toBe(false);
  });
});

// Reads the real stylesheet rather than a duplicated table: the point is that
// nobody can "tidy" these back to the traffic overlay's map hexes, which are
// unreadable as text (#ffd500 is 1.42:1 on white).
describe("traffic text tones meet WCAG AA", () => {
  const css = readFileSync(resolve(process.cwd(), "apps/web/src/app/globals.css"), "utf8");

  const blockOf = (selector: string) => {
    const body = css.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
    if (body === undefined) throw new Error(`no ${selector} block in globals.css`);
    return body;
  };

  /** The traffic tone for `band` in a block; a missing one fails the test. */
  const toneIn = (block: string, band: string) => {
    const tone = block.match(new RegExp(`--omx-traffic-${band}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    if (tone === undefined) throw new Error(`no --omx-traffic-${band} tone`);
    return tone;
  };

  const relLum = (hex: string) => {
    const channel = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(channel(1)) + 0.7152 * f(channel(3)) + 0.0722 * f(channel(5));
  };

  const contrast = (a: string, b: string) => {
    const [la, lb] = [relLum(a), relLum(b)];
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const BANDS = ["light", "moderate", "heavy", "severe"];

  it("clears 4.5:1 on the light surface", () => {
    const block = blockOf(":root");
    for (const band of BANDS) {
      expect(contrast(toneIn(block, band), "#ffffff") >= 4.5).toBe(true);
    }
  });

  it("clears 4.5:1 on the dark overlay surface", () => {
    const darkBlock = blockOf("\\.dark");
    const darkBg = darkBlock.match(/--omx-overlay-bg:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(darkBg).toBe("#2D2D2D");
    if (darkBg === undefined) throw new Error("no --omx-overlay-bg in the dark block");
    for (const band of BANDS) {
      expect(contrast(toneIn(darkBlock, band), darkBg) >= 4.5).toBe(true);
    }
  });
});
