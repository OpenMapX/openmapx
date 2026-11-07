import { THEME_COLORS } from "@openmapx/core/theme";
import { DARK_PALETTE, LIGHT_PALETTE, paletteFor } from "./nativeTheme";

describe("native palette", () => {
  it.each(["light", "dark"] as const)(
    "projects the shared %s theme into native screen and button colors",
    (scheme) => {
      const colors = THEME_COLORS[scheme];
      const palette = paletteFor(scheme);
      expect(palette).toMatchObject({
        scheme,
        background: scheme === "light" ? colors.surface : colors.background,
        title: colors.text,
        body: colors.textSecondary,
        accent: colors.primary,
        onAccent: colors.onPrimary,
        secondaryLabel: colors.primary,
      });
      const channels = colors.primary
        .slice(1)
        .match(/.{2}/g)!
        .map((channel) => Number.parseInt(channel, 16));
      expect(palette.outline).toBe(`rgba(${channels.join(", ")}, 0.5)`);
    },
  );
  it("picks the palette for the system appearance", () => {
    expect(paletteFor("dark")).toBe(DARK_PALETTE);
    expect(paletteFor("light")).toBe(LIGHT_PALETTE);
    expect(paletteFor(null)).toBe(LIGHT_PALETTE);
  });
});
