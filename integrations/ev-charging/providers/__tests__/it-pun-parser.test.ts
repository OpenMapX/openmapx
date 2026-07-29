import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoiRow } from "@openmapx/poi-source-registry";
import { describe, expect, it, vi } from "vitest";
import { parseItPun } from "../it-pun-parser.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/it-pun.geojson", import.meta.url)));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

// Every test run stubs `fetch` to serve the fixture as page 1, then an empty
// page — the parser pages internally via `resultOffset` until a page returns
// fewer rows than `resultRecordCount`.
async function collect(seed: Buffer = fixture): Promise<PoiRow[]> {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ type: "FeatureCollection", features: [] })),
  );
  vi.stubGlobal("fetch", fetchMock);
  const rows: PoiRow[] = [];
  for await (const row of parseItPun(seed, { log })) rows.push(row);
  vi.unstubAllGlobals();
  return rows;
}

function byPoiId(rows: PoiRow[], poiId: string): PoiRow | undefined {
  return rows.find((r) => r.poiId === poiId);
}

describe("parseItPun", () => {
  it("groups EVSE-level features sharing an ID_location into one station row", async () => {
    const rows = await collect();
    // 9 fixture features across 6 distinct ID_location values.
    expect(rows).toHaveLength(6);
    const grouped = byPoiId(rows, "611006f5-d1ce-4d5a-9ce1-f79d2b9e1215");
    expect(grouped).toBeDefined();
    const connectors = grouped?.payload.connectors as Array<{ type?: string }>;
    // Two features, one connector each, merged onto the one station row.
    expect(connectors).toHaveLength(2);
  });

  it("uses coordinates from the first feature and keeps [lng, lat] order", async () => {
    const rows = await collect();
    const grouped = byPoiId(rows, "611006f5-d1ce-4d5a-9ce1-f79d2b9e1215");
    expect(grouped?.lng).toBeCloseTo(12.4998830000001);
    expect(grouped?.lat).toBeCloseTo(41.8577020000001);
    expect(grouped?.payload.coordinates).toEqual([12.4998830000001, 41.8577020000001]);
  });

  it("maps name, address, and openingHours from the grouped location", async () => {
    const rows = await collect();
    const grouped = byPoiId(rows, "611006f5-d1ce-4d5a-9ce1-f79d2b9e1215");
    expect(grouped?.payload.name).toBe("22XP22T3QQ1AN00638");
    expect(grouped?.payload.address).toEqual({
      line1: "Via Marco e Marcelliano 45",
      town: "Roma",
      postcode: "00147",
      state: "Roma",
      country: "Italy",
    });
    expect(grouped?.payload.openingHours).toBe("Aperto 24/7");
  });

  it("converts Potenza_erogabile from watts to kW", async () => {
    const rows = await collect();
    const single = byPoiId(rows, "91751718-f5d1-4e5f-8c84-aba3043f8efb");
    const connectors = single?.payload.connectors as Array<{ powerKw?: number; type?: string }>;
    expect(connectors).toHaveLength(1);
    expect(connectors[0].powerKw).toBe(99);
    expect(connectors[0].type).toBe("CCS");
  });

  it("splits a comma-joined Standard_del_connettore into multiple connectors", async () => {
    const rows = await collect();
    const multi = byPoiId(rows, "test-multi-standard-0001");
    const connectors = multi?.payload.connectors as Array<{ type?: string; quantity?: number }>;
    expect(connectors).toHaveLength(2);
    expect(connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "Type 2", quantity: 2 }),
        expect.objectContaining({ type: "CCS", quantity: 2 }),
      ]),
    );
  });

  it("rolls status up to operational when any connector is AVAILABLE/CHARGING", async () => {
    const rows = await collect();
    const mixed = byPoiId(rows, "2b609453-a869-4235-b644-f8b59604faee");
    expect(mixed?.payload.status).toBe("operational");
    const testMixed = byPoiId(rows, "test-mixed-status-0001");
    expect(testMixed?.payload.status).toBe("operational");
  });

  it("rolls status up to not-operational only when every EVSE is OUTOFORDER/INOPERATIVE", async () => {
    const rows = await collect();
    const down = byPoiId(rows, "cdeaa6bb-28f1-423d-9646-99ef3dbf3ea1");
    expect(down?.payload.status).toBe("not-operational");
  });

  it("maps an unrecognised connector standard to Unknown", async () => {
    const rows = await collect();
    const row = byPoiId(rows, "2b609453-a869-4235-b644-f8b59604faee");
    const connectors = row?.payload.connectors as Array<{ type?: string }>;
    expect(connectors).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "Unknown" })]),
    );
  });

  it("has no operator field and carries the PUN source URL", async () => {
    const rows = await collect();
    const row = byPoiId(rows, "611006f5-d1ce-4d5a-9ce1-f79d2b9e1215");
    expect(row?.payload.operator).toBeUndefined();
    expect(row?.payload.sourceUrl).toBe("https://www.piattaformaunicanazionale.it/idr");
  });

  it("pages internally via resultOffset when the seed page is full", async () => {
    const fullPage = JSON.stringify({
      type: "FeatureCollection",
      features: Array.from({ length: 2000 }, (_, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [12.5 + i * 0.0001, 41.9] },
        properties: {
          ID_location: `page1-${i}`,
          Nome_location: `Station ${i}`,
          Stato: "AVAILABLE",
          Standard_del_connettore: "IEC_62196_T2",
          Numero_Connettori: 1,
          Potenza_erogabile: "22000",
          Tipologia_di_alimentazione: "AC_3_PHASE",
        },
      })),
    });
    const secondPage = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [13.1, 42.1] },
          properties: {
            ID_location: "page2-only",
            Nome_location: "Second page station",
            Stato: "AVAILABLE",
            Standard_del_connettore: "IEC_62196_T2",
            Numero_Connettori: 1,
            Potenza_erogabile: "11000",
            Tipologia_di_alimentazione: "AC_3_PHASE",
          },
        },
      ],
    };
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify(secondPage));
    });
    vi.stubGlobal("fetch", fetchMock);
    const rows: PoiRow[] = [];
    for await (const row of parseItPun(Buffer.from(fullPage), { log })) rows.push(row);
    vi.unstubAllGlobals();

    expect(calls).toBe(1);
    expect(rows).toHaveLength(2001);
    expect(byPoiId(rows, "page2-only")).toBeDefined();
  });

  it("returns an empty array for malformed JSON", async () => {
    const rows = await collect(Buffer.from("not json"));
    expect(rows).toEqual([]);
  });
});
