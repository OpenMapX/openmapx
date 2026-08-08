import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseDeOcpdb } from "../de-ocpdb-parser.js";

const locationsPage = readFileSync(
  fileURLToPath(new URL("./fixtures/de-ocpdb-locations.json", import.meta.url)),
);
const tariffsPage = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/de-ocpdb-tariffs.json", import.meta.url)),
    "utf-8",
  ),
);
const associationsPage = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/de-ocpdb-associations.json", import.meta.url)),
    "utf-8",
  ),
);
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

async function collect() {
  // The seed IS the full locations page (next_offset null); the parser fetches
  // the tariffs and tariff-associations feeds over the network.
  const fetchMock = vi.fn(async (url: string) =>
    url.includes("/tariff-associations")
      ? new Response(JSON.stringify(associationsPage))
      : url.includes("/tariffs")
        ? new Response(JSON.stringify(tariffsPage))
        : new Response(JSON.stringify({ items: [], next_offset: null })),
  );
  vi.stubGlobal("fetch", fetchMock);
  const rows: Array<{ poiId: string; lng: number; lat: number; payload: Record<string, unknown> }> =
    [];
  for await (const row of parseDeOcpdb(locationsPage, { log })) rows.push(row);
  vi.unstubAllGlobals();
  return rows;
}

describe("parseDeOcpdb", () => {
  it("yields a row per location with coordinates and connectors", async () => {
    const rows = await collect();
    expect(rows.length).toBeGreaterThan(0);
    const withConnectors = rows.find((r) => (r.payload.connectors as unknown[]).length > 0);
    expect(withConnectors).toBeDefined();
    expect(Number.isFinite(withConnectors?.lat)).toBe(true);
  });

  it("attaches tariffs to the station whose evse uid appears in a tariff association", async () => {
    const rows = await collect();
    const priced = rows.filter(
      (r) => Array.isArray(r.payload.tariffs) && (r.payload.tariffs as unknown[]).length > 0,
    );
    expect(priced.length).toBeGreaterThan(0);
    const tariff = (priced[0].payload.tariffs as Array<{ elements: Array<{ price: number }> }>)[0];
    expect(tariff.elements[0].price).toBeGreaterThan(0);
  });

  it("dedupes content-identical tariffs across a multi-EVSE station (energy + blocking fee only once each)", async () => {
    const rows = await collect();
    // The fixture's EnBW station has 4 EVSEs, each carrying an identical
    // energy + duration-gated time tariff — after dedupe exactly 2 remain.
    const priced = rows
      .map((r) => r.payload.tariffs as unknown[] | undefined)
      .filter((t): t is unknown[] => Array.isArray(t) && t.length > 0);
    const many = priced.find((t) => t.length >= 2);
    expect(many).toBeDefined();
    expect(many).toHaveLength(2);
    const dims = (many as Array<{ elements: Array<{ type: string }> }>).map(
      (t) => t.elements[0].type,
    );
    expect(new Set(dims)).toEqual(new Set(["energy", "time"]));
  });

  it("records which connectors a tariff prices when a station's EVSEs are priced apart", async () => {
    // Two 60 kW CCS EVSEs on one tariff, one 11 kW Type 2 EVSE on another —
    // the shape behind the two indistinguishable "Energy" rows this fixes.
    const evse = (uid: string, standard: string, powerType: string, watts: number) => ({
      uid,
      status: "AVAILABLE",
      connectors: [{ id: `${uid}-1`, standard, power_type: powerType, max_electric_power: watts }],
    });
    const locations = Buffer.from(
      JSON.stringify({
        items: [
          {
            id: "424242",
            name: "Lidl",
            coordinates: { latitude: 50.78, longitude: 6.11 },
            evses: [
              evse("e-ccs-1", "IEC_62196_T2_COMBO", "DC", 60000),
              evse("e-ccs-2", "IEC_62196_T2_COMBO", "DC", 60000),
              evse("e-ac", "IEC_62196_T2", "AC_3_PHASE", 11000),
            ],
          },
        ],
        next_offset: null,
      }),
    );
    const tariffs = {
      items: [
        {
          id: "t-dc",
          currency: "EUR",
          elements: [{ price_components: [{ type: "ENERGY", price: 0.46 }] }],
        },
        {
          id: "t-ac",
          currency: "EUR",
          elements: [{ price_components: [{ type: "ENERGY", price: 0.4 }] }],
        },
      ],
      next_offset: null,
    };
    const associations = {
      items: [
        { tariff_id: "t-dc", evses: [{ evse_uid: "e-ccs-1" }, { evse_uid: "e-ccs-2" }] },
        { tariff_id: "t-ac", evses: [{ evse_uid: "e-ac" }] },
      ],
      next_offset: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/tariff-associations")
          ? new Response(JSON.stringify(associations))
          : new Response(JSON.stringify(tariffs)),
      ),
    );
    const rows = [];
    for await (const row of parseDeOcpdb(locations, { log })) rows.push(row);
    vi.unstubAllGlobals();

    expect(rows).toHaveLength(1);
    expect(rows[0].payload.tariffs).toEqual([
      expect.objectContaining({
        elements: [expect.objectContaining({ price: 0.46 })],
        appliesTo: [{ type: "CCS", powerKw: 60, currentType: "DC", quantity: 2 }],
      }),
      expect.objectContaining({
        elements: [expect.objectContaining({ price: 0.4 })],
        appliesTo: [{ type: "Type 2", powerKw: 11, currentType: "AC", quantity: 1 }],
      }),
    ]);
  });

  it("maps DOMESTIC_F to Schuko so it merges with the de-bnetza duplicate", async () => {
    const rows = await collect();
    const types = rows.flatMap((r) =>
      (r.payload.connectors as Array<{ type?: string }>).map((c) => c.type),
    );
    expect(types).toContain("Schuko");
    expect(types).not.toContain("DOMESTIC_F");
  });
});
