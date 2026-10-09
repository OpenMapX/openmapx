import { describe, expect, it, vi } from "vitest";

vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({}) }));
vi.mock("@/integration-api/overlay/useIntegrationAttribution", () => ({
  useSourceAttributions: vi.fn(),
}));
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));
vi.mock("maplibre-gl", () => ({ Popup: class {} }));

const { buildAlertPopupHtml } = await import("./map-layer");

const LABELS = {
  issued: "Issued",
  issuer: "Issued by",
  severityText: "Severe",
  moreInfo: "More information",
};
const SOURCE = { name: "MeteoAlarm", url: "https://www.meteoalarm.org/" };
const LONG_TEXT = "Heavy rain. ".repeat(80).trim();

const PROPERTIES = {
  title: "Orange rain warning",
  severity: "Severe",
  event: "Rain",
  areaDesc: "Valencia",
  onset: "2026-10-09T08:00:00Z",
  expires: "2026-10-09T20:00:00Z",
  sent: "2026-10-09T06:00:00Z",
  senderName: "AEMET <Spain>",
  description: LONG_TEXT,
  instruction: "Avoid <underpasses>.",
  notices: JSON.stringify(["Provided as issued by the national services."]),
  // MeteoAlarm's CAP `web` is the national service's page, not MeteoAlarm's.
  sourceUrl: "https://www.aemet.es/en/eltiempo/prediccion/avisos",
};

describe("buildAlertPopupHtml", () => {
  it("shows the issuer, the issue time, the notice and the source name", () => {
    const html = buildAlertPopupHtml(PROPERTIES, LABELS, SOURCE);
    expect(html).toContain("Issued by: AEMET &lt;Spain&gt;");
    expect(html).toContain("Issued: ");
    expect(html).toContain("Provided as issued by the national services.");
    expect(html).toContain(">MeteoAlarm</a>");
  });

  it("links the source name to the data source's own site, the alert's page separately", () => {
    const html = buildAlertPopupHtml(PROPERTIES, LABELS, SOURCE);
    expect(html).toMatch(/<a href="https:\/\/www\.meteoalarm\.org\/"[^>]*>MeteoAlarm<\/a>/);
    expect(html).toMatch(
      /<a href="https:\/\/www\.aemet\.es\/en\/eltiempo\/prediccion\/avisos"[^>]*>More information<\/a>/,
    );
  });

  it("names the source without a link when it has no site, and drops a page that is no web URL", () => {
    const html = buildAlertPopupHtml({ ...PROPERTIES, sourceUrl: "javascript:alert(1)" }, LABELS, {
      name: "MeteoAlarm",
      url: null,
    });
    expect(html).not.toContain("<a ");
    expect(html).toContain("MeteoAlarm");
  });

  it("shows the whole description and instruction in a scrollable block", () => {
    const html = buildAlertPopupHtml(PROPERTIES, LABELS, SOURCE);
    expect(html).toContain(LONG_TEXT);
    expect(html).not.toContain("...");
    expect(html).toContain("Avoid &lt;underpasses&gt;.");
    expect(html).toContain("overflow-y:auto");
  });

  it("omits the issue line and the notices when the alert has none", () => {
    const html = buildAlertPopupHtml(
      { ...PROPERTIES, sent: "", senderName: null, notices: "[]" },
      LABELS,
      SOURCE,
    );
    expect(html).not.toContain("Issued");
    expect(html).not.toContain("color:#777");
  });
});
