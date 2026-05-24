import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSwissOicp } from "../switzerland-parser.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "switzerland-sample.json"));

describe("parseSwissOicp", () => {
  it("yields one row per valid EVSEDataRecord and skips rows missing id or coordinates", async () => {
    const rows = await parseSwissOicp(FIXTURE);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.poiId)).toEqual([
      encodeURIComponent("CH-GRN-S001"),
      encodeURIComponent("CH-GRN-S002"),
    ]);
  });

  it("emits bare encoded poiId without the swiss-sfoe: prefix", async () => {
    const rows = await parseSwissOicp(FIXTURE);
    for (const row of rows) {
      expect(row.poiId.startsWith("swiss-sfoe:")).toBe(false);
    }
  });

  it("parses Google geo coordinates as [lng, lat] and duplicates into payload.coordinates", async () => {
    const rows = await parseSwissOicp(FIXTURE);
    const zurich = rows[0];
    expect(zurich.lat).toBeCloseTo(47.378177);
    expect(zurich.lng).toBeCloseTo(8.540192);
    expect(zurich.payload.coordinates).toEqual([zurich.lng, zurich.lat]);
  });

  it("prefers English ChargingStationName when present", async () => {
    const rows = await parseSwissOicp(FIXTURE);
    expect(rows[0].payload.name).toBe("Zurich HB Station");
  });

  it("populates operator from group metadata", async () => {
    const rows = await parseSwissOicp(FIXTURE);
    expect(rows[0].payload.operator).toEqual({ name: "Green Motion AG" });
  });

  it("encodes EvseID into payload.encodedEvseId so the mapper can rebuild sourceItemIds", async () => {
    const rows = await parseSwissOicp(FIXTURE);
    expect(rows[0].payload.encodedEvseId).toBe(encodeURIComponent("CH*GRN*E001"));
  });

  it("computes connector powerKw from facility max power", async () => {
    const rows = await parseSwissOicp(FIXTURE);
    const connectors = rows[0].payload.connectors as Array<Record<string, unknown>>;
    expect(connectors).toHaveLength(2);
    expect(connectors.every((c) => c.powerKw === 150)).toBe(true);
  });

  it("falls back to Voltage*Amperage/1000 when explicit power is missing", async () => {
    const rows = await parseSwissOicp(FIXTURE);
    const bern = rows[1];
    const connectors = bern.payload.connectors as Array<Record<string, unknown>>;
    expect(connectors[0].powerKw).toBeCloseTo(12.8);
  });

  it("emits 24/7 only when IsOpen24Hours is true", async () => {
    const rows = await parseSwissOicp(FIXTURE);
    expect(rows[0].payload.openingHours).toBe("24/7");
    expect(rows[1].payload.openingHours).toBeUndefined();
  });

  it("preserves AuthenticationModes as paymentMethods", async () => {
    const rows = await parseSwissOicp(FIXTURE);
    expect(rows[0].payload.paymentMethods).toEqual(["Direct payment", "Charging card"]);
  });
});
