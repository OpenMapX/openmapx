import { fakeHttpClient, httpStatus } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { loadKartverketStations } from "../catalog.js";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<tide><stationinfo>
  <location name="Bergen" code="BGO" latitude="60.398046" longitude="5.320487" type="PERM"/>
  <location name="Broken" code="BRK" latitude="north" longitude="5.3" type="PERM"/>
  <location name="Temporary" code="TMP" latitude="60.1" longitude="5.1" type="TEMP"/>
</stationinfo></tide>`;

describe("loadKartverketStations", () => {
  it("reads the permanent stations of the XML list", async () => {
    const http = fakeHttpClient(() => ({ status: 200, headers: {}, body: XML }));

    expect(await loadKartverketStations(http)).toEqual([
      { code: "BGO", name: "Bergen", lat: 60.398046, lng: 5.320487 },
    ]);
    expect(http.calls[0]?.method).toBe("getText");
    expect(http.calls[0]?.options).toMatchObject({ contentTypes: ["text/xml", "application/xml"] });
  });

  it("rejects a failed list", async () => {
    await expect(loadKartverketStations(fakeHttpClient(() => httpStatus(503)))).rejects.toThrow(
      "HTTP 503",
    );
  });
});
