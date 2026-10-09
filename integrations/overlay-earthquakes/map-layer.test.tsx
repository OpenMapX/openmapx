import { describe, expect, it, vi } from "vitest";
import de from "../../packages/i18n/locales/de.json";
import en from "../../packages/i18n/locales/en.json";

vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({}) }));
vi.mock("@/integration-api/overlay/useIntegrationAttribution", () => ({
  useSourceAttributions: vi.fn(),
}));
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
    const html = buildEarthquakePopupHtml(FEATURE_PROPERTIES, translatorFor(en));
    expect(html).toContain("Oceanic region — tsunami possible");
    expect(html).not.toContain("advisory");
  });

  it("links the event page without naming the publisher", () => {
    const html = buildEarthquakePopupHtml(FEATURE_PROPERTIES, translatorFor(en));
    expect(html).toContain("Event page");
    expect(html).toContain('href="https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd"');
    expect(html).not.toContain("View on USGS");
  });

  it("has the German labels", () => {
    const html = buildEarthquakePopupHtml(FEATURE_PROPERTIES, translatorFor(de));
    expect(html).toContain("Ozeanregion — Tsunami möglich");
    expect(html).toContain("Ereignisseite");
  });

  it("shows no tsunami line and no link when the event has neither", () => {
    const html = buildEarthquakePopupHtml(
      { ...FEATURE_PROPERTIES, tsunami: 0, url: "" },
      translatorFor(en),
    );
    expect(html).not.toContain("tsunami possible");
    expect(html).not.toContain("Event page");
  });
});
