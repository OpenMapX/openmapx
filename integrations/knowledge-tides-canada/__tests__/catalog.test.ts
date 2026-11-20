import { fakeHttpClient, httpStatus } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { loadIwlsStations } from "../catalog.js";

describe("loadIwlsStations", () => {
  it("reads every station with its time series codes, without a max that IWLS refuses", async () => {
    const http = fakeHttpClient(() => [
      {
        id: "5cebf1de3d0f4a073c4bbd1e",
        code: "00490",
        officialName: "Halifax ",
        latitude: 44.666,
        longitude: -63.583,
        timeSeries: [{ code: "wlp" }, { code: "wlp-hilo" }, { code: 7 }],
      },
      { id: "no-coords", code: "1", officialName: "X", latitude: null, longitude: 1 },
      { code: "no-id", officialName: "Y", latitude: 1, longitude: 1 },
    ]);

    expect(await loadIwlsStations(http)).toEqual([
      {
        id: "5cebf1de3d0f4a073c4bbd1e",
        code: "00490",
        name: "Halifax",
        lat: 44.666,
        lng: -63.583,
        timeSeries: ["wlp", "wlp-hilo"],
      },
    ]);
    expect(http.calls[0]?.url).toBe(
      "https://api-iwls.dfo-mpo.gc.ca/api/v1/stations?time-series-code=wlp",
    );
  });

  it("rejects a failed list", async () => {
    await expect(loadIwlsStations(fakeHttpClient(() => httpStatus(500)))).rejects.toThrow();
  });
});
