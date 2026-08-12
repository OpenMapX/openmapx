import { describe, expect, it } from "vitest";
import manifest from "./manifest.json";
import de from "./strings/de.json";
import en from "./strings/en.json";

type DataSource = (typeof manifest.dataSources)[number];

function source(sourceId: string): DataSource | undefined {
  return manifest.dataSources.find((candidate) => candidate.sourceId === sourceId);
}

describe("wildfire source disclosures", () => {
  it("declares all four sources in the shipped order with server-only exposure", () => {
    expect(manifest.dataSources.map((candidate) => candidate.sourceId)).toEqual([
      "firms",
      "nifc-wfigs",
      "effis",
      "noaa-hms",
    ]);
    for (const declared of manifest.dataSources) {
      expect(declared.endUserExposure).toBe("server-only");
      expect(declared.providerPrivacyUrl).toBeTruthy();
    }
  });

  it("declares the implemented server-side perimeter, burned-area, and smoke sources", () => {
    expect(source("nifc-wfigs")).toMatchObject({
      name: "NIFC WFIGS Current Interagency Fire Perimeters",
      url: "https://www.arcgis.com/home/item.html?id=d1c32af3212341869b3c810f1a215824",
      apiHosts: ["services3.arcgis.com"],
      license: "U.S. Government data — NIFC disclaimer",
      licenseUrl: "https://www.arcgis.com/home/item.html?id=d1c32af3212341869b3c810f1a215824",
      endUserExposure: "server-only",
      personalData: false,
      cookies: false,
      dpaAvailable: false,
      attribution:
        "National Interagency Fire Center (NIFC) / WFIGS and contributing agencies — dynamic data, not legal documents. NIFC gives no warranty, expressed or implied, as to accuracy, reliability, or completeness.",
    });
    expect(source("effis")).toMatchObject({
      name: "EFFIS / Copernicus Emergency Management Service",
      url: "https://forest-fire.emergency.copernicus.eu/applications/data-and-services",
      apiHosts: ["maps.effis.emergency.copernicus.eu"],
      license: "CC-BY-4.0",
      endUserExposure: "server-only",
      personalData: false,
      cookies: false,
      dpaAvailable: false,
      attribution:
        "EFFIS / Copernicus Emergency Management Service, © European Union, modified by OpenMapX.",
    });
    expect(source("noaa-hms")).toMatchObject({
      name: "NOAA Hazard Mapping System (HMS) Smoke Detection",
      url: "https://www.ospo.noaa.gov/products/land/hms.html",
      apiHosts: ["services2.arcgis.com"],
      license: "CC0-1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      endUserExposure: "server-only",
      personalData: false,
      cookies: false,
      dpaAvailable: false,
    });
  });

  it.each([
    [
      "nifc-wfigs",
      "not legal documents",
      "no browser IP, identity, or exact device location is forwarded",
      "zoom-derived simplification offset",
    ],
    [
      "effis",
      "not an authoritative fire perimeter",
      "no browser IP, identity, or exact device location is forwarded",
      undefined,
    ],
    [
      "noaa-hms",
      "observed smoke plume",
      "no browser IP, identity, or exact device location is forwarded",
      undefined,
    ],
  ])("discloses %s source limits in English and German", (sourceId, enLimit, enPrivacy, offset) => {
    const enEntry = en.dataSources[sourceId as keyof typeof en.dataSources];
    const deEntry = de.dataSources[sourceId as keyof typeof de.dataSources];

    expect(enEntry.purpose).toMatch(new RegExp(enLimit, "i"));
    expect(enEntry.dataSent).toContain(enPrivacy);
    if (offset) expect(enEntry.dataSent).toContain(offset);
    expect(deEntry.purpose).toBeTruthy();
    expect(deEntry.dataSent).toContain(
      "keine Browser-IP, Identität oder exakte Gerätestandortdaten",
    );
    if (offset) expect(deEntry.dataSent).toContain("zoomabhängiger Vereinfachungsversatz");
    expect(deEntry.dataReceived).toBeTruthy();
  });

  it("localizes every declared source disclosure", () => {
    for (const declared of manifest.dataSources) {
      const sourceId = declared.sourceId as keyof typeof en.dataSources;
      expect(en.dataSources[sourceId]?.purpose).toBeTruthy();
      expect(en.dataSources[sourceId]?.dataSent).toBeTruthy();
      expect(en.dataSources[sourceId]?.dataReceived).toBeTruthy();
      expect(de.dataSources[sourceId]?.purpose).toBeTruthy();
      expect(de.dataSources[sourceId]?.dataSent).toBeTruthy();
      expect(de.dataSources[sourceId]?.dataReceived).toBeTruthy();
    }
  });
});
