import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parsePlEipa } from "../pl-eipa-parser.js";

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

const stationPage = fixture("pl-eipa-station.json");
const dictionaryPage = fixture("pl-eipa-dictionary.json");
const operatorPage = fixture("pl-eipa-operator.json");
const poolPage = fixture("pl-eipa-pool.json");
const pointPage = fixture("pl-eipa-point.json");
const dynamicPage = fixture("pl-eipa-dynamic.json");

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

async function collect() {
  // station.json IS the seed handed to the parser directly; the other five
  // reader files are fetched over the network the same way OCPDB fetches its
  // secondary tariffs/associations feeds.
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/dictionary.json")) return new Response(dictionaryPage);
    if (url.includes("/operator.json")) return new Response(operatorPage);
    if (url.includes("/pool.json")) return new Response(poolPage);
    if (url.includes("/point.json")) return new Response(pointPage);
    if (url.includes("/dynamic.json")) return new Response(dynamicPage);
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const rows: Array<{ poiId: string; lng: number; lat: number; payload: Record<string, unknown> }> =
    [];
  for await (const row of parsePlEipa(stationPage, { log })) rows.push(row);
  vi.unstubAllGlobals();
  return rows;
}

describe("parsePlEipa", () => {
  it("yields only electric stations, filtering out gas/hydrogen types", async () => {
    const rows = await collect();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.poiId).sort()).toEqual(["22", "46"]);
  });

  it("falls back to the pool's coordinates when the station omits its own", async () => {
    const rows = await collect();
    const withoutOwnCoords = rows.find((r) => r.poiId === "46");
    expect(withoutOwnCoords?.lat).toBeCloseTo(51.171);
    expect(withoutOwnCoords?.lng).toBeCloseTo(16.605);
  });

  it("joins pool name/address and resolves the operator via pool.operator_id", async () => {
    const rows = await collect();
    const station22 = rows.find((r) => r.poiId === "22");
    expect(station22?.payload.name).toBe("Centrum Handlowe ABC");
    expect((station22?.payload.operator as { name?: string })?.name).toBe(
      "Operator stacji ładowania Sp. z o.o.",
    );
    expect((station22?.payload.address as { town?: string })?.town).toBe("Poznań");
  });

  it("prefers a pool-level operator_name override over the operator.json lookup", async () => {
    const rows = await collect();
    const station46 = rows.find((r) => r.poiId === "46");
    expect((station46?.payload.operator as { name?: string })?.name).toBe(
      "Orlen Charge & Drive Sp. z o.o.",
    );
  });

  it("maps point.json connectors through dictionary.json's connector_interface names", async () => {
    const rows = await collect();
    const station22 = rows.find((r) => r.poiId === "22");
    const types = (station22?.payload.connectors as Array<{ type?: string }>).map((c) => c.type);
    // interfaces [5,6] -> both "Type 2" variants collapse into one label;
    // interfaces [1,2,4,7,8] takes the first (DOMESTIC-A -> "Schuko").
    expect(types).toContain("Type 2");
    expect(types).toContain("Schuko");
  });

  it("joins dynamic.json prices into a PLN tariff with energy + time components", async () => {
    const rows = await collect();
    const station22 = rows.find((r) => r.poiId === "22");
    const tariffs = station22?.payload.tariffs as Array<{
      elements: Array<{ type: string; price: number; currency: string }>;
      altText?: string;
    }>;
    expect(tariffs).toHaveLength(1);
    const [tariff] = tariffs;
    expect(tariff.elements.every((el) => el.currency === "PLN")).toBe(true);
    const energy = tariff.elements.find((el) => el.type === "energy");
    const time = tariff.elements.find((el) => el.type === "time");
    expect(energy?.price).toBe(2.54);
    expect(time?.price).toBe(1.63);
    expect(tariff.altText).toContain("Promocja");
  });

  it("marks a station operational only when a point reports availability === 1", async () => {
    const rows = await collect();
    const station22 = rows.find((r) => r.poiId === "22");
    const station46 = rows.find((r) => r.poiId === "46");
    expect(station22?.payload.status).toBe("operational");
    expect(station46?.payload.status).toBe("not-operational");
  });

  it("marks the unavailable point's connector status as unavailable", async () => {
    const rows = await collect();
    const station46 = rows.find((r) => r.poiId === "46");
    const connectors = station46?.payload.connectors as Array<{ status?: string }>;
    expect(connectors.every((c) => c.status === "unavailable")).toBe(true);
  });
});
