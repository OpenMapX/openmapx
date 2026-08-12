import { describe, expect, it } from "vitest";
import {
  acresToHectares,
  buildEffisPopupModel,
  buildNifcPopupModel,
  buildNoaaSmokePopupModel,
  EFFIS_BURNED_AREA_STYLE,
  formatWildfireDate,
  NIFC_PERIMETER_STYLE,
  NOAA_SMOKE_OPACITY,
} from "./presentation.js";

describe("wildfire presentation", () => {
  it("converts acres to hectares", () => {
    expect(acresToHectares(100)).toBeCloseTo(40.4686, 4);
  });

  it("formats valid dates in the requested locale and omits invalid dates", () => {
    expect(formatWildfireDate("2026-01-02T15:04:00.000Z", "en-GB")).toBe("2 Jan 2026, 15:04");
    expect(formatWildfireDate("not-a-date", "en-GB")).toBeNull();
  });

  it("builds a safe NIFC popup and converts its reported area", () => {
    expect(
      buildNifcPopupModel(
        {
          id: "nifc:1",
          kind: "reported-perimeter",
          provider: "nifc",
          coverage: "United States",
          name: '<img src=x onerror="alert(1)"> Pine Fire',
          areaAcres: 100,
          containmentPercent: 25,
          updatedAt: "2026-01-02T15:04:00.000Z",
          region: "US-CA & NV",
          cause: "Lightning",
        },
        "en-GB",
      ),
    ).toEqual({
      title: {
        kind: "escaped",
        value: "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; Pine Fire",
      },
      fields: [
        { key: "reportedArea", value: "100 acres (40.5 ha)" },
        { key: "containment", value: "25%" },
        { key: "updated", value: "2 Jan 2026, 15:04" },
        { key: "region", value: "US-CA &amp; NV" },
        { key: "cause", value: "Lightning" },
      ],
      caveatKeys: [],
    });
  });

  it("omits missing and non-finite NIFC numbers", () => {
    const model = buildNifcPopupModel(
      {
        id: "nifc:2",
        kind: "reported-perimeter",
        provider: "nifc",
        coverage: "United States",
        name: "Unnamed",
        areaAcres: Number.NaN,
        containmentPercent: Number.POSITIVE_INFINITY,
      },
      "en-US",
    );

    expect(model.fields).toEqual([]);
  });

  it("builds an EFFIS popup from normalized burned-area fields", () => {
    expect(
      buildEffisPopupModel(
        {
          id: "effis:1",
          kind: "satellite-burned-area",
          provider: "effis",
          areaHectares: 1234.56,
          detectedAt: "2026-01-02T15:04:00.000Z",
          countryCode: "PT",
          region: "Norte",
          locality: "Vila <Nova>",
          sourceClass: "MODIS & VIIRS",
        },
        "en-GB",
      ),
    ).toEqual({
      title: { kind: "message", key: "satelliteDerivedBurnedArea" },
      fields: [
        { key: "area", value: "1,234.6 ha" },
        { key: "detected", value: "2 Jan 2026, 15:04" },
        { key: "region", value: "Norte" },
        { key: "locality", value: "Vila &lt;Nova&gt;" },
        { key: "country", value: "PT" },
        { key: "sourceClass", value: "MODIS &amp; VIIRS" },
      ],
      caveatKeys: ["effisBurnedAreaCaveat"],
    });
  });

  it("builds a NOAA popup from normalized smoke fields", () => {
    expect(
      buildNoaaSmokePopupModel(
        {
          id: "noaa-hms:1",
          kind: "observed-smoke",
          provider: "noaa-hms",
          density: "heavy",
          satellite: "GOES-18 <West>",
          startedAt: "2026-01-02T15:04:00.000Z",
          endedAt: "2026-01-02T17:04:00.000Z",
        },
        "en-GB",
      ),
    ).toEqual({
      title: { kind: "message", key: "observedSmoke" },
      fields: [
        { key: "density", value: "Heavy" },
        { key: "satellite", value: "GOES-18 &lt;West&gt;" },
        { key: "started", value: "2 Jan 2026, 15:04" },
        { key: "ended", value: "2 Jan 2026, 17:04" },
      ],
      caveatKeys: ["noaaObservedSmokeCaveat"],
    });
  });

  it("maps NOAA smoke density to the specified restrained opacity", () => {
    expect(NOAA_SMOKE_OPACITY).toEqual({ light: 0.08, medium: 0.15, heavy: 0.24 });
  });

  it("keeps operational NIFC and satellite-derived EFFIS polygons visually distinct", () => {
    expect(NIFC_PERIMETER_STYLE).toEqual({
      fillColor: "#dc5a36",
      fillOpacity: 0.18,
      lineColor: "#b91c1c",
      lineWidth: 1.5,
    });
    expect(EFFIS_BURNED_AREA_STYLE).toEqual({
      fillColor: "#8b6f47",
      fillOpacity: 0.2,
      lineColor: "#5f4630",
      lineWidth: 1,
      lineDasharray: [3, 2],
    });
  });
});
