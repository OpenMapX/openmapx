import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TRAFFIC_TEXT_COLOR } from "@/integration-api/runtime/theme";

describe("TRAFFIC_TEXT_COLOR", () => {
  it("exposes a CSS variable per displayable band", () => {
    expect(TRAFFIC_TEXT_COLOR).toEqual({
      light: "var(--omx-traffic-light)",
      moderate: "var(--omx-traffic-moderate)",
      heavy: "var(--omx-traffic-heavy)",
      severe: "var(--omx-traffic-severe)",
    });
  });

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
    const m = css.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`));
    if (!m) throw new Error(`no ${selector} block in globals.css`);
    return m[1];
  };

  const varsIn = (block: string) =>
    Object.fromEntries(
      [...block.matchAll(/--omx-traffic-([a-z]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]),
    );

  const relLum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  const contrast = (a: string, b: string) => {
    const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  const BANDS = ["light", "moderate", "heavy", "severe"];

  it("clears 4.5:1 on the light surface", () => {
    const vars = varsIn(blockOf(":root"));
    for (const band of BANDS) {
      expect(vars[band]).toBeDefined();
      expect(contrast(vars[band], "#ffffff") >= 4.5).toBe(true);
    }
  });

  it("clears 4.5:1 on the dark overlay surface", () => {
    const darkBlock = blockOf("\\.dark");
    const vars = varsIn(darkBlock);
    const darkBg = darkBlock.match(/--omx-overlay-bg:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(darkBg).toBe("#2D2D2D");
    for (const band of BANDS) {
      expect(vars[band]).toBeDefined();
      expect(contrast(vars[band], darkBg as string) >= 4.5).toBe(true);
    }
  });
});
