// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { applyThemeColor, THEME_COLOR } from "./themeColor";

function meta(media: string): HTMLMetaElement {
  const element = document.createElement("meta");
  element.name = "theme-color";
  element.media = media;
  document.head.append(element);
  return element;
}

let light: HTMLMetaElement;
let dark: HTMLMetaElement;

beforeEach(() => {
  document.head.innerHTML = "";
  light = meta("(prefers-color-scheme: light)");
  dark = meta("(prefers-color-scheme: dark)");
  applyThemeColor(null);
});

describe("applyThemeColor", () => {
  it("follows each tag's own scheme when the app follows the system", () => {
    expect(light.content).toBe(THEME_COLOR.light);
    expect(dark.content).toBe(THEME_COLOR.dark);
  });

  it("puts the bar on the dark colour whatever the system says when Dark is chosen", () => {
    applyThemeColor("dark");
    expect(light.content).toBe(THEME_COLOR.dark);
    expect(dark.content).toBe(THEME_COLOR.dark);
  });

  it("returns to the system's colours when System is chosen again", () => {
    applyThemeColor("light");
    applyThemeColor(null);
    expect(light.content).toBe(THEME_COLOR.light);
    expect(dark.content).toBe(THEME_COLOR.dark);
  });
});
