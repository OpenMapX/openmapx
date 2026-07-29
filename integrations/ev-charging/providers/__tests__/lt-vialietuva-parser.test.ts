import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseLtVialietuva } from "../lt-vialietuva-parser.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/lt-vialietuva.json", import.meta.url)), "utf-8"),
) as { locations: unknown[]; tariffs: unknown[] };

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

async function collect() {
  // parseLtVialietuva ignores the seed buffer and pages both feeds itself, so
  // the seed content passed in below is irrelevant — only the fetch stub
  // matters. Both endpoints respond with one page (wrapped in `data`, per the
  // OCPI convention this client also accepts) whose `x-total-count` equals
  // the page size, so pagination terminates after page 1.
  const fetchMock = vi.fn(async (url: string) => {
    const isTariffs = url.includes("/tariffs");
    const items = isTariffs ? fixture.tariffs : fixture.locations;
    return new Response(JSON.stringify({ data: items }), {
      status: 200,
      headers: { "x-total-count": String(items.length) },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const rows: Array<{ poiId: string; lng: number; lat: number; payload: Record<string, unknown> }> =
    [];
  for await (const row of parseLtVialietuva(Buffer.from(""), { log })) rows.push(row);
  vi.unstubAllGlobals();
  return { rows, fetchMock };
}

describe("parseLtVialietuva", () => {
  it("sends a User-Agent header on every request (Cloudflare requires one)", async () => {
    const { fetchMock } = await collect();
    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>)["User-Agent"]).toBe("OpenMapX/1.0");
    }
  });

  it("yields a row per location with coordinates parsed from string lat/lng", async () => {
    const { rows } = await collect();
    expect(rows).toHaveLength(3);
    const kaunas = rows.find((r) => r.payload.name === "Jovarų g. 2, Kaunas");
    expect(kaunas).toBeDefined();
    expect(kaunas?.lat).toBeCloseTo(54.91003, 4);
    expect(kaunas?.lng).toBeCloseTo(23.84187, 4);
  });

  it("maps connector standards (normalized to the shared Type 2 / CCS / CHAdeMO labels)", async () => {
    const { rows } = await collect();
    const types = rows.flatMap((r) =>
      (r.payload.connectors as Array<{ type?: string }>).map((c) => c.type),
    );
    // connector() runs normalizeConnectorType, which folds "CCS (Type 2)"
    // down to the shared "CCS" label used by every other source (matches
    // dedup.ts merging) — see nl-dotnl-parser.test.ts for the same pattern.
    expect(types).toContain("Type 2");
    expect(types).toContain("CCS");
    expect(types).toContain("CHAdeMO");
  });

  it("attaches the joined ENERGY tariff price to the station whose connector references it", async () => {
    const { rows } = await collect();
    const kaunas = rows.find((r) => r.payload.name === "Jovarų g. 2, Kaunas");
    expect(kaunas?.payload.tariffs).toBeDefined();
    const tariffs = kaunas?.payload.tariffs as Array<{
      elements: Array<{ type: string; price: number; currency: string; vat?: number }>;
      scope: string;
      source: string;
    }>;
    expect(tariffs).toHaveLength(1);
    expect(tariffs[0].scope).toBe("evse");
    expect(tariffs[0].source).toBe("lt-vialietuva");
    const energy = tariffs[0].elements.find((e) => e.type === "energy");
    expect(energy?.price).toBeCloseTo(0.39, 4);
    expect(energy?.currency).toBe("EUR");
    const flat = tariffs[0].elements.find((e) => e.type === "flat");
    expect(flat?.price).toBeCloseTo(0.3, 4);
  });

  it("parses the string-encoded VAT into a number", async () => {
    const { rows } = await collect();
    const zarasai = rows.find((r) => r.payload.name === "PLTZARDBU1_EDLT-106");
    const tariffs = zarasai?.payload.tariffs as Array<{
      elements: Array<{ vat?: number }>;
      altText?: string;
    }>;
    expect(tariffs[0].elements[0].vat).toBe(21);
    expect(tariffs[0].altText).toBe("0.44 EUR/kWh");
  });

  it("dedupes a station's tariffs when several connectors share the same tariff id", async () => {
    const { rows } = await collect();
    // Zarasai has 2 EVSEs (CHAdeMO + CCS) both referencing the same tariff id
    // — the resolved tariffs array must carry exactly one copy, not two.
    const zarasai = rows.find((r) => r.payload.name === "PLTZARDBU1_EDLT-106");
    expect(zarasai?.payload.tariffs).toHaveLength(1);
    expect((zarasai?.payload.connectors as unknown[]).length).toBe(2);
  });
});
