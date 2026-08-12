import { describe, expect, it } from "vitest";
import manifest from "./manifest.json";
import de from "./strings/de.json";
import en from "./strings/en.json";

type DataSource = (typeof manifest.dataSources)[number];

function source(sourceId: string): DataSource | undefined {
  return manifest.dataSources.find((candidate) => candidate.sourceId === sourceId);
}

describe("wildfire source disclosures", () => {
  it("declares the two implemented server-side perimeter and burned-area sources", () => {
    expect(source("nifc")).toMatchObject({
      name: "NIFC WFIGS Current Interagency Fire Perimeters",
      apiHosts: ["services3.arcgis.com"],
      endUserExposure: "server-only",
      personalData: false,
      cookies: false,
      dpaAvailable: false,
      attribution:
        "National Interagency Fire Center (NIFC) / WFIGS — dynamic data, not legal documents. NIFC gives no warranty, expressed or implied, as to accuracy, reliability, or completeness.",
    });
    expect(source("effis")).toMatchObject({
      name: "EFFIS / Copernicus Emergency Management Service",
      apiHosts: ["maps.effis.emergency.copernicus.eu"],
      license: "CC BY 4.0",
      endUserExposure: "server-only",
      personalData: false,
      cookies: false,
      dpaAvailable: false,
      attribution:
        "EFFIS / Copernicus Emergency Management Service, © European Union, modified by OpenMapX.",
    });
  });

  it.each([
    [
      "nifc",
      "not legal documents",
      "no browser IP, identity, or exact device location is forwarded",
    ],
    [
      "effis",
      "not an authoritative fire perimeter",
      "no browser IP, identity, or exact device location is forwarded",
    ],
  ])("discloses %s source limits in English and German", (sourceId, enLimit, enPrivacy) => {
    const enEntry = en.dataSources[sourceId as keyof typeof en.dataSources];
    const deEntry = de.dataSources[sourceId as keyof typeof de.dataSources];

    expect(enEntry.purpose).toContain(enLimit);
    expect(enEntry.dataSent).toContain(enPrivacy);
    expect(deEntry.purpose).toBeTruthy();
    expect(deEntry.dataSent).toContain(
      "keine Browser-IP, Identität oder exakte Gerätestandortdaten",
    );
    expect(deEntry.dataReceived).toBeTruthy();
  });
});
