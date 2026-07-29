import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  searchAtEcontrolCharging,
  setAtEcontrolApiKey,
  setAtEcontrolRefererDomain,
} from "../at-econtrol.js";

// SYNTHETIC fixture — not a documented sample from E-Control. E-Control's own
// Swagger docs (api.e-control.at/charge/1.0/swagger-ui.html) require a
// registered API key to view, so the station/point field shapes here are
// built from the MIT-licensed, reverse-engineered Home Assistant integration
// https://github.com/rolandzeiner/ladestellen-austria (src/types.ts,
// coordinator.py) rather than from official E-Control documentation.
const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/at-econtrol.json", import.meta.url)),
  "utf-8",
);

const VIENNA_BBOX = { south: 48.15, west: 16.3, north: 48.25, east: 16.45 };

afterEach(() => {
  setAtEcontrolApiKey(undefined);
  setAtEcontrolRefererDomain(undefined);
  vi.unstubAllGlobals();
});

describe("searchAtEcontrolCharging", () => {
  it("returns [] without any credentials configured, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchAtEcontrolCharging(VIENNA_BBOX);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] with only the API key set (referer domain missing), without calling fetch", async () => {
    setAtEcontrolApiKey("test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchAtEcontrolCharging(VIENNA_BBOX);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] with only the referer domain set (API key missing), without calling fetch", async () => {
    setAtEcontrolRefererDomain("example.com");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchAtEcontrolCharging(VIENNA_BBOX);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] for a bbox outside Austria, without calling fetch", async () => {
    setAtEcontrolApiKey("test-key");
    setAtEcontrolRefererDomain("example.com");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchAtEcontrolCharging({ south: 48, west: 2, north: 49, east: 3 });

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries /search at the bbox center with Apikey + Referer headers, maps stations, and filters by bbox", async () => {
    setAtEcontrolApiKey("test-key");
    setAtEcontrolRefererDomain("example.com");
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.e-control.at/charge/1.0/search?latitude=48.2&longitude=16.375");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Apikey).toBe("test-key");
      expect(headers.Referer).toBe("https://example.com");
      return Promise.resolve(new Response(fixture));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchAtEcontrolCharging(VIENNA_BBOX);

    // The Graz station (real coordinates, but outside the Vienna search bbox)
    // is excluded even though /search itself has no bbox parameter.
    expect(result).toHaveLength(1);
    const station = result[0];
    expect(station.id).toBe("at-econtrol:E5487EA07");
    expect(station.sources).toEqual(["at-econtrol"]);
    expect(station.coordinates).toEqual([16.3684, 48.2131]);
    expect(station.name).toBe("Rudolfsplatz Wien");
    expect(station.address).toMatchObject({
      line1: "Rudolfsplatz 13a",
      town: "Wien",
      postcode: "1010",
      country: "Austria",
    });
    expect(station.operator).toMatchObject({
      name: "Wien Energie GmbH",
      url: "https://www.wienenergie.at",
    });
    expect(station.status).toBe("operational");
    expect(station.isLive).toBe(true);
    expect(station.openingHours).toBe("24/7");
    expect(station.access).toBe("Barrier-free parking available");
    expect(station.paymentMethods).toEqual(
      expect.arrayContaining(["APP", "RFID_READER", "CREDIT_CARD"]),
    );
    expect(station.notes).toEqual(
      expect.arrayContaining([
        "Green energy",
        "Austrian Ecolabel certified",
        "Parking places: 2",
        "Public charging station in central Vienna",
      ]),
    );

    expect(station.connectors).toEqual([
      expect.objectContaining({ type: "Type 2", currentType: "AC", powerKw: 22, quantity: 1 }),
      expect.objectContaining({ type: "CCS", currentType: "DC", powerKw: 50, quantity: 1 }),
    ]);

    // Type 2 point: energy-only tariff. CCS point: energy+time+flat tariff,
    // plus a separate blocking-fee tariff restricted to sessions past 30 min.
    expect(station.tariffs).toHaveLength(3);
    expect(station.tariffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "evse",
          source: "at-econtrol",
          elements: [{ type: "energy", price: 0.45, currency: "EUR" }],
        }),
        expect.objectContaining({
          scope: "evse",
          source: "at-econtrol",
          elements: [
            { type: "energy", price: 0.55, currency: "EUR" },
            { type: "time", price: 0.05, currency: "EUR" },
            { type: "flat", price: 0.5, currency: "EUR" },
          ],
        }),
        expect.objectContaining({
          scope: "evse",
          source: "at-econtrol",
          elements: [{ type: "time", price: 0.1, currency: "EUR" }],
          restrictions: { minDurationMinutes: 30 },
        }),
      ]),
    );
  });

  it("emits no tariff for a free-of-charge connector, and maps OTHER/DOMESTIC_F to Schuko", async () => {
    setAtEcontrolApiKey("test-key");
    setAtEcontrolRefererDomain("example.com");
    const fetchMock = vi.fn().mockResolvedValue(new Response(fixture));
    vi.stubGlobal("fetch", fetchMock);

    // Graz is outside VIENNA_BBOX but inside Austria coverage, so query a
    // bbox that actually contains it to exercise the free-of-charge station.
    const grazBbox = { south: 47.0, west: 15.3, north: 47.15, east: 15.5 };
    const result = await searchAtEcontrolCharging(grazBbox);

    expect(result).toHaveLength(1);
    const station = result[0];
    expect(station.id).toBe("at-econtrol:E9912GRZ");
    expect(station.tariffs).toBeUndefined();
    expect(station.connectors).toEqual([
      expect.objectContaining({ type: "Schuko", currentType: "AC", powerKw: 11, quantity: 1 }),
    ]);
    expect(station.notes).toBeUndefined();
  });
});
