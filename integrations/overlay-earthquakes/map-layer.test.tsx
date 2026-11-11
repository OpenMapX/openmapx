import { describe, expect, it, vi } from "vitest";
import de from "../../packages/i18n/locales/de.json";
import en from "../../packages/i18n/locales/en.json";

vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({}) }));
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));
vi.mock("maplibre-gl", () => ({ Popup: class {} }));

const { buildEarthquakePopupHtml } = await import("./map-layer");

const translatorFor =
  (messages: typeof en) =>
  (key: string): string =>
    (messages.earthquakes as Record<string, string>)[key] ?? key;

const FEATURE_PROPERTIES = {
  mag: 7.1,
  depth: 12,
  ageMs: 3_600_000,
  time: Date.parse("2026-10-09T05:00:00Z"),
  place: "Pacific Ocean",
  tsunami: 1,
  url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
};

describe("buildEarthquakePopupHtml", () => {
  it("labels the tsunami flag as an oceanic region, not a warning", () => {
    const html = buildEarthquakePopupHtml(FEATURE_PROPERTIES, translatorFor(en), "en");
    expect(html).toContain("Oceanic region — tsunami possible");
    expect(html).not.toContain("advisory");
  });

  it("links the event page without naming the publisher", () => {
    const html = buildEarthquakePopupHtml(FEATURE_PROPERTIES, translatorFor(en), "en");
    expect(html).toContain("Event page");
    expect(html).toContain('href="https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd"');
    expect(html).not.toContain("View on USGS");
  });

  it("has the German labels", () => {
    const html = buildEarthquakePopupHtml(FEATURE_PROPERTIES, translatorFor(de), "de");
    expect(html).toContain("Ozeanregion — Tsunami möglich");
    expect(html).toContain("Ereignisseite");
  });

  it("shows no tsunami line and no link when the event has neither", () => {
    const html = buildEarthquakePopupHtml(
      { ...FEATURE_PROPERTIES, tsunami: 0, url: "" },
      translatorFor(en),
      "en",
    );
    expect(html).not.toContain("tsunami possible");
    expect(html).not.toContain("Event page");
  });

  it("words the event's age in the viewer's language", () => {
    const threeHoursAgo = Date.now() - 3 * 3_600_000;
    const properties = { ...FEATURE_PROPERTIES, time: threeHoursAgo, ageMs: 3 * 3_600_000 };
    const german = buildEarthquakePopupHtml(properties, translatorFor(de), "de");
    expect(german).toContain("vor 3 Stunden");
    expect(german).not.toMatch(/\bago\b|\d+[smhd] ago/);
    expect(buildEarthquakePopupHtml(properties, translatorFor(en), "en")).toContain("3 hours ago");
  });
});
