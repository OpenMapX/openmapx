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
  it("groups rows sharing a uniek_identificatienummer into one station, merging connectors", async () => {
    const { rows, fetchMock } = await collect();
    // 10 fixture rows: 2 share "shared-cluster-1" → merge into 1 station, so
    // 9 distinct stations total.
    expect(rows).toHaveLength(9);

    const merged = rows.find(
      (r) => (r.payload.connectors as Array<{ type?: string }>).length === 2,
    );
    expect(merged).toBeDefined();
    const types = (merged?.payload.connectors as Array<{ type?: string }>).map((c) => c.type);
    expect(new Set(types)).toEqual(new Set(["Type 2", "Type 1"]));

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

  it("splits a compound connector string on '; ' into separate connectors", async () => {
    const { rows } = await collect();
    const compound = rows.find((r) =>
      (r.payload.connectors as Array<{ type?: string }>).some((c) => c.type === "CCS"),
    );
    expect(compound).toBeDefined();
    const types = (compound?.payload.connectors as Array<{ type?: string }>).map((c) => c.type);
    expect(new Set(types)).toEqual(new Set(["CCS", "Tesla"]));
    expect(
      (compound?.payload.connectors as Array<{ currentType?: string }>).every(
        (c) => c.currentType === "DC",
      ),
    ).toBe(true);
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
