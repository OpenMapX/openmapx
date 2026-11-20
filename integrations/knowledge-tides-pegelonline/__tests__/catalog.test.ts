import { fakeHttpClient, httpStatus } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { loadPegelonlineStations } from "../catalog.js";

describe("loadPegelonlineStations", () => {
  it("reads coastal gauges and collapses whitespace in their names", async () => {
    const http = fakeHttpClient(() => [
      { uuid: "uuid-1", shortname: "CUXHAVEN  STEUBENHOEFT", latitude: 53.87, longitude: 8.72 },
      { uuid: "uuid-2", shortname: "NO COORDS" },
    ]);

    expect(await loadPegelonlineStations(http)).toEqual([
      { uuid: "uuid-1", name: "CUXHAVEN STEUBENHOEFT", lat: 53.87, lng: 8.72 },
    ]);
    expect(http.calls[0]?.url).toContain("waters=NORDSEE,OSTSEE");
  });

  it("rejects a failed list", async () => {
    await expect(loadPegelonlineStations(fakeHttpClient(() => httpStatus(502)))).rejects.toThrow();
  });
});
