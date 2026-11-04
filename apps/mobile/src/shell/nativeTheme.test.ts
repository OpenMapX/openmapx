import { THEME_COLORS } from "@openmapx/core/theme";
import { DARK_PALETTE, LIGHT_PALETTE, paletteFor } from "./nativeTheme";

describe("native palette", () => {
  it("draws the native screens in the web UI's colours", () => {
    expect(LIGHT_PALETTE).toMatchObject({
      background: THEME_COLORS.light.surface,
      title: THEME_COLORS.light.text,
      body: THEME_COLORS.light.textSecondary,
      accent: THEME_COLORS.light.primary,
      onAccent: THEME_COLORS.light.onPrimary,
      secondaryLabel: THEME_COLORS.light.primary,
    });
    expect(DARK_PALETTE).toMatchObject({
      background: THEME_COLORS.dark.background,
      accent: THEME_COLORS.dark.primary,
      onAccent: THEME_COLORS.dark.onPrimary,
    });
  });

  it("outlines secondary buttons in the primary colour at half opacity", () => {
    expect(LIGHT_PALETTE.outline).toBe("rgba(32, 126, 35, 0.5)");
  });

  it("picks the palette for the system appearance", () => {
    expect(paletteFor("dark")).toBe(DARK_PALETTE);
    expect(paletteFor("light")).toBe(LIGHT_PALETTE);
    expect(paletteFor(null)).toBe(LIGHT_PALETTE);
  });
});
