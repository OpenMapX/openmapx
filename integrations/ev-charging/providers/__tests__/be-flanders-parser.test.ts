import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseBeFlanders } from "../be-flanders-parser.js";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/be-flanders.json", import.meta.url)),
);

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

async function collect() {
  // Only 10 features (well under the 5,000 page size), so the parser should
  // never need a second page — but stub fetch to return an empty page anyway
  // so pagination terminates cleanly even if that assumption ever changes.
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ type: "FeatureCollection", features: [] })),
  );
  vi.stubGlobal("fetch", fetchMock);
  const rows: Array<{ poiId: string; lng: number; lat: number; payload: Record<string, unknown> }> =
    [];
  for await (const row of parseBeFlanders(fixture, { log })) rows.push(row);
  vi.unstubAllGlobals();
  return { rows, fetchMock };
}

describe("parseBeFlanders", () => {
  it("groups connector rows sharing a location-id prefix (before '__') into one station", async () => {
    const { rows, fetchMock } = await collect();
    // 10 fixture rows span 2 physical stations: Roderveldlaan 2 (2 rows sharing a
    // synthetic id with no "__" separator) and Roderveldlaan 3 (8 real rows all
    // sharing the prefix "469e655a-…" before "__"). Grouping on the prefix
    // collapses the 8 connector rows into one station → 2 stations total.
    expect(rows).toHaveLength(2);

    const rv2 = rows.find((r) => r.payload.name === "50 five – Roderveldlaan 2");
    const rv2Types = (rv2?.payload.connectors as Array<{ type?: string }>).map((c) => c.type);
    expect(new Set(rv2Types)).toEqual(new Set(["Type 2", "Type 1"]));

    const rv3 = rows.find((r) => r.payload.name === "50 five – Roderveldlaan 3");
    expect(rv3).toBeDefined();
    // 8 rows → 9 connector entries (one row is a compound "CCS; Tesla" DC charger).
    expect((rv3?.payload.connectors as unknown[]).length).toBe(9);

    // Pagination never needed since the fixture page is well under PAGE_SIZE.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads coordinates as [lng, lat] from the geometry", async () => {
    const { rows } = await collect();
    const row = rows.find((r) => r.lat === 51.19133104);
    expect(row).toBeDefined();
    expect(row?.lng).toBeCloseTo(4.437802);
    expect(row?.payload.coordinates).toEqual([4.437802, 51.19133104]);
  });

  it("splits a compound connector string on '; ' into separate DC connectors", async () => {
    const { rows } = await collect();
    // The "IEC_62196_T2_COMBO; TESLA_S" row splits into a CCS + a Tesla
    // connector, both DC. That row is now merged into the Roderveldlaan 3
    // station alongside its other (Type 2) connectors, so assert those two
    // specific connectors are present rather than the station's whole set.
    const station = rows.find((r) =>
      (r.payload.connectors as Array<{ type?: string }>).some((c) => c.type === "CCS"),
    );
    expect(station).toBeDefined();
    const conns = station?.payload.connectors as Array<{ type?: string; currentType?: string }>;
    const ccs = conns.find((c) => c.type === "CCS");
    const tesla = conns.find((c) => c.type === "Tesla");
    expect(ccs?.currentType).toBe("DC");
    expect(tesla?.currentType).toBe("DC");
  });

  it("maps station-level fields (name, address, operator, status, sourceUrl)", async () => {
    const { rows } = await collect();
    const merged = rows.find((r) => r.payload.name === "50 five – Roderveldlaan 2");
    expect(merged).toBeDefined();
    expect(merged?.payload.address).toEqual({
      line1: "Roderveldlaan 2",
      town: "Antwerpen",
      postcode: "2000",
      state: "PROVINCIE ANTWERPEN",
      country: "Belgium",
    });
    expect(merged?.payload.operator).toEqual({ name: "50 five" });
    expect(merged?.payload.status).toBe("unknown");
    expect(merged?.payload.sourceUrl).toBe("https://www.vlaanderen.be/datavindplaats");
  });
});
