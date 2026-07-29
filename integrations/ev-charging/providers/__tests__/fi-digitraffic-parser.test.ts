import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { FI_DIGITRAFFIC_TARIFFS_URL } from "../fi-digitraffic-client.js";
import { parseFiDigitraffic } from "../fi-digitraffic-parser.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/fi-digitraffic.json", import.meta.url)), "utf-8"),
);
const locationsBuffer = Buffer.from(JSON.stringify(fixture.locations));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

type Row = { poiId: string; lng: number; lat: number; payload: Record<string, unknown> };

async function collect(): Promise<Row[]> {
  // The seed is the locations GeoJSON; the parser fetches the tariffs feed
  // over the network via fetchAllFiTariffs (single-page cursor response here).
  const fetchMock = vi.fn(async (url: string) => {
    expect(url.startsWith(FI_DIGITRAFFIC_TARIFFS_URL)).toBe(true);
    return new Response(
      JSON.stringify({ pagination: { nextCursor: null }, tariffs: fixture.tariffs }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const rows: Row[] = [];
  for await (const row of parseFiDigitraffic(locationsBuffer, { log })) rows.push(row as Row);
  vi.unstubAllGlobals();
  return rows;
}

describe("parseFiDigitraffic", () => {
  it("yields a row per location with coordinates and connectors", async () => {
    const rows = await collect();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(6);
    const withConnectors = rows.find((r) => (r.payload.connectors as unknown[]).length > 0);
    expect(withConnectors).toBeDefined();
    expect(Number.isFinite(withConnectors?.lat)).toBe(true);
    expect(Number.isFinite(withConnectors?.lng)).toBe(true);
  });

  it("joins a station's connector tariffIds to a structured ENERGY tariff", async () => {
    const rows = await collect();
    const station = rows.find((r) => r.poiId === "FI-TEST-0001");
    expect(station).toBeDefined();
    const tariffs = station?.payload.tariffs as Array<{
      elements: Array<{ type: string; price: number; currency: string; vat?: number }>;
      scope: string;
      source: string;
      isDirectPayment?: boolean;
    }>;
    expect(tariffs.length).toBeGreaterThan(0);
    expect(tariffs.every((t) => t.scope === "evse" && t.source === "fi-digitraffic")).toBe(true);
    const energyElement = tariffs.flatMap((t) => t.elements).find((e) => e.type === "energy");
    expect(energyElement).toBeDefined();
    expect(energyElement?.price).toBe(0.55);
    expect(energyElement?.currency).toBe("EUR");
    expect(energyElement?.vat).toBe(25.5);
    expect(tariffs.some((t) => t.isDirectPayment)).toBe(true);
  });

  it("dedupes a content-identical tariff shared by a station's multiple EVSEs", async () => {
    const rows = await collect();
    const station = rows.find((r) => r.poiId === "FI-TEST-0003");
    expect(station).toBeDefined();
    // Both EVSEs reference TARIFF-DC-001, which itself splits into 2 restriction
    // groups (unrestricted ENERGY + duration-gated PARKING_TIME) — dedup keeps
    // exactly those 2, not 4.
    expect(station?.payload.tariffs).toHaveLength(2);
  });

  it("maps connector standard, power, and current type", async () => {
    const rows = await collect();
    const connectors = rows.flatMap(
      (r) =>
        r.payload.connectors as Array<{ type?: string; powerKw?: number; currentType?: string }>,
    );
    // connector() runs normalizeConnectorType, which folds "CCS (Type 2)" down
    // to the shared "CCS" label used by every other source (see
    // lt-vialietuva-parser.test.ts for the same pattern).
    const dcFast = connectors.find((c) => c.type === "CCS");
    expect(dcFast?.currentType).toBe("DC");
    expect(dcFast?.powerKw).toBe(150);

    const acType2 = connectors.find((c) => c.type === "Type 2");
    expect(acType2?.currentType).toBe("AC");
    expect(acType2?.powerKw).toBe(22);

    const schuko = connectors.find((c) => c.type === "Schuko");
    expect(schuko).toBeDefined();

    const chademo = connectors.find((c) => c.type === "CHAdeMO");
    expect(chademo).toBeDefined();
  });

  it("leaves tariffs undefined for a station with no tariffIds and drops an unresolvable tariff reference", async () => {
    const rows = await collect();
    const noTariffs = rows.find((r) => r.poiId === "FI-TEST-0004");
    expect(noTariffs?.payload.tariffs).toBeUndefined();

    const missingTariff = rows.find((r) => r.poiId === "FI-TEST-0005");
    expect(missingTariff?.payload.tariffs).toBeUndefined();
    const connectors = missingTariff?.payload.connectors as Array<{ type?: string }>;
    expect(connectors[0]?.type).toBe("Unknown");
  });
});
