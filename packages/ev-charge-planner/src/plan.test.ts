import type { EvVehicleSpec } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { estimateSessionCost, planCharges } from "./plan.js";

const vehicle: EvVehicleSpec = {
  batteryKwh: 60,
  baseWhPerKm: 200,
  massTonnes: 2,
  maxDcKw: 150,
  maxAcKw: 11,
  vehicleTaperSocPct: 80,
  connectors: ["ccs2"],
};
const NOW = 1_700_000_000_000; // fixed request time for deterministic availability gating

// straight flat east-west route: 7 pts at lat 50 spanning 2.7° lon ≈ 193 km
// (NOT 300 km — cos(50°) shrinks longitude; energy uses the haversine geometry).
function longRoute() {
  const pts: [number, number][] = Array.from({ length: 7 }, (_, i) => [i * 0.45, 50]);
  return {
    distance: 193_000,
    duration: 12_000,
    geometry: pts,
    legs: [],
    steps: [],
    mode: "driving" as const,
  };
}
const charger = (id: string, lng: number) => ({
  id,
  name: id,
  coordinates: [lng, 50] as [number, number],
  sources: ["ocm"],
  connectors: [{ type: "CCS", powerKw: 150, currentType: "dc" }],
});

describe("planCharges", () => {
  it("returns no stops when the trip is within range", async () => {
    const cb = { requestCorridorChargers: vi.fn().mockResolvedValue([]), requestMatrix: vi.fn() };
    // 60kWh battery, 200Wh/km => ~300km range; start full, reserve 0 -> reachable
    const plan = await planCharges(
      {
        route: longRoute(),
        vehicle,
        socStartKwh: 60,
        socArrivalMinKwh: 0,
        socTargetKwh: 48,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
      },
      cb,
    );
    expect(plan.stops).toHaveLength(0);
    expect(cb.requestCorridorChargers).not.toHaveBeenCalled();
  });

  it("inserts a compatible mid-route stop when range is insufficient", async () => {
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([charger("mid", 1.35)]),
      requestMatrix: vi
        .fn()
        .mockImplementation(async (s: any[], t: any[]) =>
          s.map(() => t.map(() => ({ seconds: 120, km: 2 }))),
        ),
    };
    const plan = await planCharges(
      {
        route: longRoute(),
        vehicle,
        socStartKwh: 30,
        socArrivalMinKwh: 6,
        socTargetKwh: 48,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
      },
      cb,
    );
    expect(plan.stops.length).toBeGreaterThanOrEqual(1);
    expect(plan.stops[0].connector).toBe("ccs2");
    expect(plan.totalChargeSeconds).toBeGreaterThan(0);
  });

  it("warns unreachable when no compatible charger exists", async () => {
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([
        {
          ...charger("chademo-only", 1.35),
          connectors: [{ type: "CHAdeMO", powerKw: 50, currentType: "dc" }],
        },
      ]),
      requestMatrix: vi.fn().mockResolvedValue([[{ seconds: 120, km: 2 }]]),
    };
    const plan = await planCharges(
      {
        route: longRoute(),
        vehicle,
        socStartKwh: 20,
        socArrivalMinKwh: 6,
        socTargetKwh: 48,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
      },
      cb,
    );
    expect(plan.warnings.some((w) => w.kind === "unreachable")).toBe(true);
  });

  it("emits no-charger-data when the source returns nothing but a stop was needed", async () => {
    const cb = { requestCorridorChargers: vi.fn().mockResolvedValue([]), requestMatrix: vi.fn() };
    const plan = await planCharges(
      {
        route: longRoute(),
        vehicle,
        socStartKwh: 20,
        socArrivalMinKwh: 6,
        socTargetKwh: 48,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
      },
      cb,
    );
    expect(plan.warnings.some((w) => w.kind === "no-charger-data")).toBe(true);
  });

  it("does not loop forever when it cannot progress from the start point", async () => {
    // Start already below reserve: divertIdx cannot advance past startIdx.
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([charger("mid", 0.0)]),
      requestMatrix: vi.fn().mockResolvedValue([
        [
          { seconds: 60, km: 1 },
          { seconds: 60, km: 1 },
        ],
        [
          { seconds: 60, km: 1 },
          { seconds: 60, km: 1 },
        ],
      ]),
    };
    const plan = await planCharges(
      {
        route: longRoute(),
        vehicle,
        socStartKwh: 3,
        socArrivalMinKwh: 6,
        socTargetKwh: 48,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
      },
      cb,
    );
    expect(plan.stops.length).toBeLessThanOrEqual(1);
    expect(plan.warnings.some((w) => w.kind === "unreachable")).toBe(true);
  });

  it("bridges above the taper SoC on the final leg when needed to finish (D5.7)", async () => {
    // Small 20 kWh car, taper 80% (16 kWh). ~120 km route; one stop, after which the
    // remaining leg needs > taper but < a full battery → must charge above taper.
    // (Implementer: confirm the arithmetic against the final consumption constants.)
    const smallEv: EvVehicleSpec = {
      batteryKwh: 20,
      baseWhPerKm: 200,
      massTonnes: 1.5,
      maxDcKw: 100,
      maxAcKw: 11,
      vehicleTaperSocPct: 80,
      connectors: ["ccs2"],
    };
    const pts: [number, number][] = Array.from({ length: 5 }, (_, i) => [i * 0.339, 50]); // ≈97 km
    const shortRoute = {
      distance: 97_000,
      duration: 4800,
      geometry: pts,
      legs: [],
      steps: [],
      mode: "driving" as const,
    };
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([charger("mid", 0.4)]),
      requestMatrix: vi
        .fn()
        .mockImplementation(async (s: any[], t: any[]) =>
          s.map(() => t.map(() => ({ seconds: 60, km: 1 }))),
        ),
    };
    const plan = await planCharges(
      {
        route: shortRoute,
        vehicle: smallEv,
        socStartKwh: 12,
        socArrivalMinKwh: 2,
        socTargetKwh: 16,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
      },
      cb,
    );
    expect(plan.stops).toHaveLength(1);
    expect(plan.stops[0].departSocKwh).toBeGreaterThan(16); // charged past the 80% taper to finish
  });

  it("prefers a charger with free stalls over a full one at similar detour (near-term)", async () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    const full = {
      ...charger("full", 1.35),
      availability: { available: 0, total: 8, updatedAt: fresh },
    };
    const free = {
      ...charger("free", 1.36),
      availability: { available: 6, total: 8, updatedAt: fresh },
    };
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([full, free]),
      requestMatrix: vi
        .fn()
        .mockImplementation(async (s: any[], t: any[]) =>
          s.map(() => t.map(() => ({ seconds: 120, km: 2 }))),
        ),
    };
    // Low start SoC → first stop is reached soon (well within the availability horizon).
    const plan = await planCharges(
      {
        route: longRoute(),
        vehicle,
        socStartKwh: 18,
        socArrivalMinKwh: 6,
        socTargetKwh: 48,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
      },
      cb,
    );
    expect(plan.stops[0]?.station.id).toBe("free");
  });

  it("ignores occupancy for a far-future stop (state would be stale on arrival)", async () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    const full = {
      ...charger("full", 1.35),
      availability: { available: 0, total: 8, updatedAt: fresh },
    };
    const free = {
      ...charger("free", 1.36),
      availability: { available: 8, total: 8, updatedAt: fresh },
    };
    // "full" is occupied but a much shorter detour; "free" is empty but far.
    // targets order is [full, free, onward]; give "full" the cheap detour.
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([full, free]),
      requestMatrix: vi.fn().mockImplementation(async (s: any[], t: any[]) =>
        s.map(() =>
          t.map((_: unknown, ti: number) => ({
            seconds: ti === 0 ? 60 : 300,
            km: ti === 0 ? 1 : 5,
          })),
        ),
      ),
    };
    // socStartKwh 40 → a stop is needed but the first divert is ~141 km in, an ETA
    // well beyond AVAILABILITY_HORIZON_SEC, so occupancy is NOT penalised and the
    // shorter detour ("full") must win. (At a near-term ETA occupancy would flip
    // this to "free".)
    const plan = await planCharges(
      {
        route: longRoute(),
        vehicle,
        socStartKwh: 40,
        socArrivalMinKwh: 6,
        socTargetKwh: 48,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
      },
      cb,
    );
    expect(plan.stops[0]?.station.id).toBe("full");
  });

  it("favours a preferred network even at a modestly longer detour (D9)", async () => {
    const ionity = { ...charger("ionity", 1.35), operator: { name: "IONITY GmbH" } };
    const other = { ...charger("other", 1.36), operator: { name: "SomeCPO" } };
    // "other" has the shorter detour (ti=0); "ionity" is a bit farther (ti=1).
    // The ~10-min preference bonus outweighs the small detour gap → ionity wins.
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([other, ionity]),
      requestMatrix: vi.fn().mockImplementation(async (s: any[], t: any[]) =>
        s.map(() =>
          t.map((_: unknown, ti: number) => ({
            seconds: ti === 0 ? 60 : 180,
            km: ti === 0 ? 1 : 3,
          })),
        ),
      ),
    };
    const plan = await planCharges(
      {
        route: longRoute(),
        vehicle,
        socStartKwh: 30,
        socArrivalMinKwh: 6,
        socTargetKwh: 48,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
        preferredNetworkKeys: new Set(["ionity"]),
        avoidedNetworkKeys: new Set(),
      },
      cb,
    );
    expect(plan.stops[0]?.station.id).toBe("ionity");
  });

  it("avoids a network the user named by brand, not by its full registered name (D9)", async () => {
    // The user types "EnBW"; the register carries "EnBW mobility+ AG und Co.KG",
    // whose key is "enbw mobility und". Matching those by equality silently
    // dropped the preference and the avoided operator was recommended anyway.
    const enbw = { ...charger("enbw", 1.35), operator: { name: "EnBW mobility+ AG und Co.KG" } };
    const other = { ...charger("other", 1.36), operator: { name: "SomeCPO" } };
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([enbw, other]),
      // "enbw" is the shorter detour (ti=0), so only the avoid penalty can flip this.
      requestMatrix: vi.fn().mockImplementation(async (s: any[], t: any[]) =>
        s.map(() =>
          t.map((_: unknown, ti: number) => ({
            seconds: ti === 0 ? 60 : 180,
            km: ti === 0 ? 1 : 3,
          })),
        ),
      ),
    };
    const plan = await planCharges(
      {
        route: longRoute(),
        vehicle,
        socStartKwh: 30,
        socArrivalMinKwh: 6,
        socTargetKwh: 48,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
        preferredNetworkKeys: new Set(),
        avoidedNetworkKeys: new Set(["enbw"]),
      },
      cb,
    );
    expect(plan.stops[0]?.station.id).toBe("other");
  });

  it("treats an exclusive whitelist named by brand as covering the full operator name", async () => {
    const enbw = { ...charger("enbw", 1.35), operator: { name: "EnBW mobility+ AG und Co.KG" } };
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([enbw]),
      requestMatrix: vi
        .fn()
        .mockImplementation(async (s: any[], t: any[]) =>
          s.map(() => t.map(() => ({ seconds: 120, km: 2 }))),
        ),
    };
    const plan = await planCharges(
      {
        route: longRoute(),
        vehicle,
        socStartKwh: 30,
        socArrivalMinKwh: 6,
        socTargetKwh: 48,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
        exclusiveNetworkKeys: new Set(["enbw"]),
      },
      cb,
    );
    // Equality matching would have filtered this station out and warned instead.
    expect(plan.stops[0]?.station.id).toBe("enbw");
    expect(plan.warnings.some((w) => w.kind === "no-allowed-network")).toBe(false);
  });

  it("keeps an avoided network when it is the only reachable option (soft, not a filter)", async () => {
    const only = { ...charger("only", 1.35), operator: { name: "SomeCPO" } };
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([only]),
      requestMatrix: vi
        .fn()
        .mockImplementation(async (s: any[], t: any[]) =>
          s.map(() => t.map(() => ({ seconds: 120, km: 2 }))),
        ),
    };
    const plan = await planCharges(
      {
        route: longRoute(),
        vehicle,
        socStartKwh: 30,
        socArrivalMinKwh: 6,
        socTargetKwh: 48,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
        preferredNetworkKeys: new Set(),
        avoidedNetworkKeys: new Set(["somecpo"]),
      },
      cb,
    );
    expect(plan.stops[0]?.station.id).toBe("only"); // penalised but still chosen
  });

  it("estimateSessionCost sums energy + flat with VAT and filters by power/current (D10)", () => {
    const station: any = {
      tariffs: [
        {
          scope: "cpo",
          elements: [
            { type: "energy", price: 0.5, currency: "EUR" },
            { type: "flat", price: 1, currency: "EUR" },
          ],
        },
      ],
    };
    // 20 kWh session: 0.5*20 + 1 = 11 EUR
    expect(estimateSessionCost(station, { powerKw: 150, current: "dc" }, 20, 30)).toEqual({
      amount: 11,
      currency: "EUR",
    });
    // AC-only tariff must not apply to a DC session → unknown (null)
    const acOnly: any = {
      tariffs: [
        {
          scope: "cpo",
          restrictions: { currentType: "ac" },
          elements: [{ type: "energy", price: 0.3, currency: "EUR" }],
        },
      ],
    };
    expect(estimateSessionCost(acOnly, { powerKw: 150, current: "dc" }, 20, 30)).toBeNull();
    expect(
      estimateSessionCost({ tariffs: [] } as any, { powerKw: 50, current: "dc" }, 10, 10),
    ).toBeNull();
  });

  it("prefers the cheaper of two comparable chargers (D10)", async () => {
    const cheap = {
      ...charger("cheap", 1.35),
      tariffs: [{ scope: "cpo", elements: [{ type: "energy", price: 0.39, currency: "EUR" }] }],
    };
    const pricey = {
      ...charger("pricey", 1.36),
      tariffs: [{ scope: "cpo", elements: [{ type: "energy", price: 0.79, currency: "EUR" }] }],
    };
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([pricey, cheap]),
      requestMatrix: vi
        .fn()
        .mockImplementation(async (s: any[], t: any[]) =>
          s.map(() => t.map(() => ({ seconds: 120, km: 2 }))),
        ),
    };
    const plan = await planCharges(
      {
        route: longRoute(),
        vehicle,
        socStartKwh: 30,
        socArrivalMinKwh: 6,
        socTargetKwh: 48,
        ambientTempC: 20,
        hasElevation: false,
        nowMs: NOW,
      },
      cb,
    );
    expect(plan.stops[0]?.station.id).toBe("cheap");
    expect(plan.stops[0]?.estimatedCost?.currency).toBe("EUR");
  });

  it("never lets price override a large detour, and ignores it when costWeight=0 (D10)", async () => {
    const cheapFar = {
      ...charger("cheapFar", 1.4),
      tariffs: [{ scope: "cpo", elements: [{ type: "energy", price: 0.3, currency: "EUR" }] }],
    };
    const pricyNear = {
      ...charger("pricyNear", 1.35),
      tariffs: [{ scope: "cpo", elements: [{ type: "energy", price: 0.9, currency: "EUR" }] }],
    };
    // pricyNear (ti=0) is close; cheapFar (ti=1) is a 30-min detour.
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([pricyNear, cheapFar]),
      requestMatrix: vi.fn().mockImplementation(async (s: any[], t: any[]) =>
        s.map(() =>
          t.map((_: unknown, ti: number) => ({
            seconds: ti === 0 ? 60 : 1800,
            km: ti === 0 ? 1 : 30,
          })),
        ),
      ),
    };
    const args = {
      route: longRoute(),
      vehicle,
      socStartKwh: 30,
      socArrivalMinKwh: 6,
      socTargetKwh: 48,
      ambientTempC: 20,
      hasElevation: false,
      nowMs: NOW,
    };
    const off = await planCharges({ ...args, costWeight: 0 }, cb);
    const on = await planCharges({ ...args, costWeight: 1 }, cb);
    expect(off.stops[0]?.station.id).toBe("pricyNear"); // price ignored → nearest wins
    expect(on.stops[0]?.station.id).toBe("pricyNear"); // capped (~6 min) penalty << 30-min detour
  });

  it("exclusive mode is a hard whitelist and warns when it leaves nothing (D9)", async () => {
    const ionity = { ...charger("ionity", 1.35), operator: { name: "Ionity" } };
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([ionity]),
      requestMatrix: vi
        .fn()
        .mockImplementation(async (s: any[], t: any[]) =>
          s.map(() => t.map(() => ({ seconds: 120, km: 2 }))),
        ),
    };
    const base = {
      route: longRoute(),
      vehicle,
      socStartKwh: 30,
      socArrivalMinKwh: 6,
      socTargetKwh: 48,
      ambientTempC: 20,
      hasElevation: false,
      nowMs: NOW,
    };
    const ok = await planCharges({ ...base, exclusiveNetworkKeys: new Set(["ionity"]) }, cb);
    expect(ok.stops[0]?.station.id).toBe("ionity");
    const blocked = await planCharges({ ...base, exclusiveNetworkKeys: new Set(["fastned"]) }, cb);
    expect(blocked.stops).toHaveLength(0);
    expect(blocked.warnings.some((w) => w.kind === "no-allowed-network")).toBe(true);
  });
});
