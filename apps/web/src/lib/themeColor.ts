/**
 * The browser chrome colour (Android's status bar, the installed app's title
 * bar) for each colour scheme. The root layout declares one `theme-color` per
 * system scheme; `ThemeColorSync` keeps them on the scheme the user picked in
 * settings when that is not the system one.
 */
export const THEME_COLOR = {
  light: "#207E23",
  dark: "#1c1c1c",
} as const;

type ThemeScheme = keyof typeof THEME_COLOR;

/**
 * Points every `theme-color` meta tag at `scheme`, or, with `null`, back at
 * the scheme its `media` query names.
 */
export function applyThemeColor(scheme: ThemeScheme | null, root: ParentNode = document): void {
  for (const meta of root.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own: ThemeScheme = meta.media.includes("dark") ? "dark" : "light";
    meta.content = THEME_COLOR[scheme ?? own];
  }
}
