import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChSfoeOicp } from "../ch-sfoe-parser.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "switzerland-sample.json"));

describe("parseChSfoeOicp", () => {
  it("yields one row per valid EVSEDataRecord and skips rows missing id or coordinates", async () => {
    const rows = await parseChSfoeOicp(FIXTURE);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.poiId)).toEqual([
      encodeURIComponent("CH-GRN-S001"),
      encodeURIComponent("CH-GRN-S002"),
    ]);
  });

  it("emits bare encoded poiId without the ch-sfoe: prefix", async () => {
    const rows = await parseChSfoeOicp(FIXTURE);
    for (const row of rows) {
      expect(row.poiId.startsWith("ch-sfoe:")).toBe(false);
    }
  });

  it("parses Google geo coordinates as [lng, lat] and duplicates into payload.coordinates", async () => {
    const rows = await parseChSfoeOicp(FIXTURE);
    const zurich = rows[0];
    expect(zurich.lat).toBeCloseTo(47.378177);
    expect(zurich.lng).toBeCloseTo(8.540192);
    expect(zurich.payload.coordinates).toEqual([zurich.lng, zurich.lat]);
  });

  it("prefers English ChargingStationName when present", async () => {
    const rows = await parseChSfoeOicp(FIXTURE);
    expect(rows[0].payload.name).toBe("Zurich HB Station");
  });

  it("handles a single-object ChargingStationNames (OICP serialises 1-element lists as a bare object)", () => {
    const feed = {
      EVSEData: [
        {
          OperatorName: "Test Operator",
          EVSEDataRecord: [
            {
              ChargingStationId: "CH-TST-S001",
              GeoCoordinates: { Google: "47.4 8.5" },
              ChargingStationNames: { value: "Solo Station", lang: "en" },
            },
          ],
        },
      ],
    };
    const rows = parseChSfoeOicp(Buffer.from(JSON.stringify(feed)));
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.name).toBe("Solo Station");
  });

  it("drops records whose coordinates fall outside Switzerland (sentinel/foreign placeholders)", () => {
    const feed = {
      EVSEData: [
        {
          OperatorName: "Test Operator",
          EVSEDataRecord: [
            // Real Swiss station — kept.
            {
              ChargingStationId: "CH-OK-S001",
              GeoCoordinates: { Google: "47.4 8.5" },
              Plugs: ["Type 2"],
            },
            // Mid-Atlantic sentinel placeholder — dropped.
            {
              ChargingStationId: "CH-BAD-SENTINEL",
              GeoCoordinates: { Google: "50.0 -15.0" },
              Plugs: ["Type 2"],
            },
            // Null island — dropped.
            {
              ChargingStationId: "CH-BAD-NULLISLAND",
              GeoCoordinates: { Google: "0.0 0.0" },
              Plugs: ["Type 2"],
            },
            // Real coordinates but abroad (Malta) — dropped, wrong country for a Swiss source.
            {
              ChargingStationId: "CH-BAD-MALTA",
              GeoCoordinates: { Google: "35.872135 14.395714" },
              Plugs: ["Type 2"],
            },
          ],
        },
      ],
    };
    const rows = parseChSfoeOicp(Buffer.from(JSON.stringify(feed)));
    expect(rows.map((r) => r.poiId)).toEqual([encodeURIComponent("CH-OK-S001")]);
  });

  it("collapses multiple EVSE records of one station into a single row with merged connectors", () => {
    const feed = {
      EVSEData: [
        {
          OperatorName: "Test Operator",
          EVSEDataRecord: [
            {
              ChargingStationId: "CH-DUP-S001",
              EvseID: "CH-DUP-E1",
              GeoCoordinates: { Google: "47.4 8.5" },
              Plugs: ["Type 2"],
              ChargingFacilities: [{ power: 22 }],
            },
            {
              ChargingStationId: "CH-DUP-S001",
              EvseID: "CH-DUP-E2",
              GeoCoordinates: { Google: "47.4 8.5" },
              Plugs: ["CCS"],
              ChargingFacilities: [{ power: 50 }],
            },
          ],
        },
      ],
    };
    const rows = parseChSfoeOicp(Buffer.from(JSON.stringify(feed)));
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.connectors as unknown[]).toHaveLength(2);
  });

  it("populates operator from group metadata", async () => {
    const rows = await parseChSfoeOicp(FIXTURE);
    expect(rows[0].payload.operator).toEqual({ name: "Green Motion AG" });
  });

  it("stores the encoded EvseID under payload.extraItemIds so the shared mapper appends it to sourceItemIds", async () => {
    const rows = await parseChSfoeOicp(FIXTURE);
    expect(rows[0].payload.extraItemIds).toEqual([encodeURIComponent("CH*GRN*E001")]);
  });

  it("computes connector powerKw from facility max power", async () => {
    const rows = await parseChSfoeOicp(FIXTURE);
    const connectors = rows[0].payload.connectors as Array<Record<string, unknown>>;
    expect(connectors).toHaveLength(2);
    expect(connectors.every((c) => c.powerKw === 150)).toBe(true);
  });

  it("falls back to Voltage*Amperage/1000 when explicit power is missing", async () => {
    const rows = await parseChSfoeOicp(FIXTURE);
    const bern = rows[1];
    const connectors = bern.payload.connectors as Array<Record<string, unknown>>;
    expect(connectors[0].powerKw).toBeCloseTo(12.8);
  });

  it("emits 24/7 only when IsOpen24Hours is true", async () => {
    const rows = await parseChSfoeOicp(FIXTURE);
    expect(rows[0].payload.openingHours).toBe("24/7");
    expect(rows[1].payload.openingHours).toBeUndefined();
  });

  it("preserves AuthenticationModes as paymentMethods", async () => {
    const rows = await parseChSfoeOicp(FIXTURE);
    expect(rows[0].payload.paymentMethods).toEqual(["Direct payment", "Charging card"]);
  });
});
