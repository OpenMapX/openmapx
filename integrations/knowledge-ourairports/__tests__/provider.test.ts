import type { Logger } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOurAirportsSource } from "../provider.js";

vi.mock("../data.js", () => ({
  lookupAirport: vi.fn(),
  lookupNearestAerodrome: vi.fn(),
}));

const { lookupAirport, lookupNearestAerodrome } = (await import("../data.js")) as unknown as {
  lookupAirport: ReturnType<typeof vi.fn>;
  lookupNearestAerodrome: ReturnType<typeof vi.fn>;
};

const log: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const sampleAirport = {
  id: 1,
  ident: "EDDF",
  type: "large_airport" as const,
  iata: "FRA",
  icao: "EDDF",
  scheduledService: true,
  runways: [{ ident: "07L/25R", lengthFt: 13123, surface: "ASP", closed: false, lighted: true }],
};

const FRA_COORDS: [number, number] = [8.5705, 50.0379];

describe("ourairports knowledge source", () => {
  beforeEach(() => {
    lookupAirport.mockReset();
    lookupNearestAerodrome.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("matches aerodrome by IATA code", async () => {
    lookupAirport.mockResolvedValue(sampleAirport);
    const source = createOurAirportsSource(log);

    const result = await source.lookup({
      aeroway: "aerodrome",
      iata: "FRA",
      icao: "EDDF",
      name: "Frankfurt Airport",
    });

    expect(result?.airport?.iata).toBe("FRA");
    expect(lookupNearestAerodrome).not.toHaveBeenCalled();
  });

  it("rejects a restaurant inside the airport (no aeroway tag)", async () => {
    const source = createOurAirportsSource(log);

    const result = await source.lookup(
      { amenity: "restaurant", name: "Frankfurt Airport Cafe" },
      undefined,
      { coordinates: FRA_COORDS },
    );

    expect(result).toBeNull();
    expect(lookupAirport).not.toHaveBeenCalled();
    expect(lookupNearestAerodrome).not.toHaveBeenCalled();
  });

  it("rejects a duty-free shop inside the airport (no aeroway tag)", async () => {
    const source = createOurAirportsSource(log);

    const result = await source.lookup({ shop: "duty_free", name: "Duty Free Shop" }, undefined, {
      coordinates: FRA_COORDS,
    });

    expect(result).toBeNull();
    expect(lookupAirport).not.toHaveBeenCalled();
    expect(lookupNearestAerodrome).not.toHaveBeenCalled();
  });

  it("matches a terminal that carries an IATA tag via code lookup", async () => {
    lookupAirport.mockResolvedValue(sampleAirport);
    const source = createOurAirportsSource(log);

    const result = await source.lookup(
      { aeroway: "terminal", iata: "FRA", name: "Terminal 1" },
      undefined,
      { coordinates: FRA_COORDS },
    );

    expect(result?.airport?.iata).toBe("FRA");
    expect(lookupNearestAerodrome).not.toHaveBeenCalled();
  });

  it("matches a terminal without IATA tag via spatial fallback", async () => {
    lookupAirport.mockResolvedValue(null);
    lookupNearestAerodrome.mockResolvedValue(sampleAirport);
    const source = createOurAirportsSource(log);

    const result = await source.lookup({ aeroway: "terminal", name: "Terminal 2" }, undefined, {
      coordinates: FRA_COORDS,
    });

    expect(result?.airport?.iata).toBe("FRA");
    expect(lookupNearestAerodrome).toHaveBeenCalledWith(log, FRA_COORDS, 10);
  });

  it("matches a runway via spatial fallback", async () => {
    lookupAirport.mockResolvedValue(null);
    lookupNearestAerodrome.mockResolvedValue(sampleAirport);
    const source = createOurAirportsSource(log);

    const result = await source.lookup({ aeroway: "runway", ref: "07L/25R" }, undefined, {
      coordinates: FRA_COORDS,
    });

    expect(result?.airport?.icao).toBe("EDDF");
    expect(result?.airport?.runways).toBeDefined();
  });

  it("matches a taxiway via spatial fallback", async () => {
    lookupAirport.mockResolvedValue(null);
    lookupNearestAerodrome.mockResolvedValue(sampleAirport);
    const source = createOurAirportsSource(log);

    const result = await source.lookup({ aeroway: "taxiway" }, undefined, {
      coordinates: FRA_COORDS,
    });

    expect(result?.airport?.icao).toBe("EDDF");
  });

  it("matches a gate via spatial fallback", async () => {
    lookupAirport.mockResolvedValue(null);
    lookupNearestAerodrome.mockResolvedValue(sampleAirport);
    const source = createOurAirportsSource(log);

    const result = await source.lookup({ aeroway: "gate", ref: "B23" }, undefined, {
      coordinates: FRA_COORDS,
    });

    expect(result?.airport?.icao).toBe("EDDF");
  });

  it("rejects an unrelated aeroway value like `navigationaid` (standalone navaids exist)", async () => {
    const source = createOurAirportsSource(log);

    const result = await source.lookup({ aeroway: "navigationaid", name: "ILS" }, undefined, {
      coordinates: FRA_COORDS,
    });

    expect(result).toBeNull();
    expect(lookupAirport).not.toHaveBeenCalled();
    expect(lookupNearestAerodrome).not.toHaveBeenCalled();
  });

  it("does NOT fall back spatially when an aerodrome has no IATA/ICAO tag (data-quality signal)", async () => {
    lookupAirport.mockResolvedValue(null);
    const source = createOurAirportsSource(log);

    const result = await source.lookup(
      { aeroway: "aerodrome", name: "Untagged Field" },
      undefined,
      { coordinates: FRA_COORDS },
    );

    expect(result).toBeNull();
    expect(lookupNearestAerodrome).not.toHaveBeenCalled();
  });

  it("returns null when no aerodrome is within 10 km of an infra feature", async () => {
    lookupAirport.mockResolvedValue(null);
    lookupNearestAerodrome.mockResolvedValue(null);
    const source = createOurAirportsSource(log);

    const result = await source.lookup({ aeroway: "terminal" }, undefined, { coordinates: [0, 0] });

    expect(result).toBeNull();
  });

  it("returns null when no aeroway tag at all", async () => {
    const source = createOurAirportsSource(log);
    const result = await source.lookup({ name: "Some Place" }, undefined, {
      coordinates: FRA_COORDS,
    });
    expect(result).toBeNull();
  });

  it("falls back from `iata` to `ref:iata` when only the latter is set", async () => {
    lookupAirport.mockResolvedValue(sampleAirport);
    const source = createOurAirportsSource(log);

    await source.lookup({ aeroway: "aerodrome", "ref:iata": "FRA" });

    expect(lookupAirport).toHaveBeenCalledWith(log, expect.objectContaining({ iata: "FRA" }));
  });

  it("matches heliports but strips the runway list", async () => {
    lookupAirport.mockResolvedValue({
      ...sampleAirport,
      type: "heliport" as const,
      runways: [{ ident: "H1", closed: false, lighted: true }],
    });
    const source = createOurAirportsSource(log);

    const result = await source.lookup({ aeroway: "heliport", icao: "EDDF" });

    expect(result?.airport?.runways).toBeUndefined();
    expect(result?.airport?.type).toBe("heliport");
  });
});
