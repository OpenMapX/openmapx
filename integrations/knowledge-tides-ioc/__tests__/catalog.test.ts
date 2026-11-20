import { fakeHttpClient, httpStatus } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { loadIocStations } from "../catalog.js";

describe("loadIocStations", () => {
  it("keeps active gauges with coordinates once per code", async () => {
    const http = fakeHttpClient(() => [
      { Code: "abc", Location: " Active ", country: "GBR", Lat: 51.5, Lon: -0.1, status: 1 },
      { Code: "abc", Location: "Repeat", Lat: 1, Lon: 1, status: 1 },
      { Code: "old", Location: "Inactive", Lat: 1, Lon: 1, status: 0 },
      { Code: "nan", Location: "Bad", Lat: Number.NaN, Lon: 2, status: 1 },
      { Code: "", Location: "No code", Lat: 1, Lon: 1, status: 1 },
      { Code: "noname", Lat: 2, Lon: 3, status: 1 },
    ]);

    expect(await loadIocStations(http)).toEqual([
      { code: "abc", name: "Active", lat: 51.5, lng: -0.1, country: "GBR" },
      { code: "noname", name: "noname", lat: 2, lng: 3 },
    ]);
    expect(http.calls[0]?.url).toBe(
      "https://www.ioc-sealevelmonitoring.org/service.php?query=stationlist&format=json",
    );
  });

  it("rejects a failed or malformed list", async () => {
    await expect(loadIocStations(fakeHttpClient(() => httpStatus(503)))).rejects.toThrow();
    await expect(loadIocStations(fakeHttpClient(() => ({ error: "x" })))).rejects.toThrow();
  });
});
