import type { EvVehicleSpec, LngLat } from "@openmapx/core";
import type {
  ChargingConnector,
  ChargingSite,
  EnergyTariff,
  Evse,
  EvseStatus,
} from "@openmapx/mobility-core/ev-charging";
import { describe, expect, it, vi } from "vitest";
import { estimateSessionCost, pickEvse, planCharges, tariffMatches } from "./plan.js";
import { ChargerSourcesUnavailableError } from "./types.js";

const vehicle: EvVehicleSpec = {
  batteryKwh: 60,
  baseWhPerKm: 200,
  massTonnes: 2,
  maxDcKw: 150,
  maxAcKw: 11,
  vehicleTaperSocPct: 80,
  connectors: ["ccs2"],
};
/** Monday 2026-10-05, 10:00 in Paris (the test route runs through northern France). */
const NOW = Date.parse("2026-10-05T10:00:00+02:00");

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

const connector = (key: string, over: Partial<ChargingConnector> = {}): ChargingConnector => ({
  key,
  standard: "IEC_62196_T2_COMBO",
  current: "dc",
  maxPowerKw: 150,
  tariffIds: [],
  stale: false,
  ...over,
});

const evse = (key: string, over: Partial<Evse> = {}): Evse => ({
  key,
  quantity: 1,
  stale: false,
  capabilities: [],
  parkingRestrictions: [],
  connectors: [connector(`${key}/1`)],
  ...over,
});

const site = (id: string, lng: number, over: Partial<ChargingSite> = {}): ChargingSite => ({
  id,
  name: id,
  coordinates: [lng, 50],
  payment: [],
  authentication: [],
  closed: false,
  planned: false,
  evses: [evse(`${id}-1`)],
  tariffs: [],
  sources: ["ocm-charging"],
  attributions: [],
  ...over,
});

/** A site whose charge points report these statuses, each observed a minute before NOW. */
const withStatuses = (id: string, lng: number, statuses: EvseStatus[], stale = false) =>
  site(id, lng, {
    evses: statuses.map((status, i) =>
      evse(`${id}-${i}`, { status, statusAt: new Date(NOW - 60_000).toISOString(), stale }),
    ),
  });

type Element = EnergyTariff["elements"][number];

const tariff = (id: string, elements: Element[], over: Partial<EnergyTariff> = {}) =>
  ({
    id,
    currency: "EUR",
    elements,
    priceIncludesVat: true,
    sourceId: "nl-ndw-charging",
    ...over,
  }) satisfies EnergyTariff;

const energy = (price: number, restrictions?: Element["restrictions"]): Element => ({
  components: [{ type: "energy", price }],
  ...(restrictions ? { restrictions } : {}),
});

const flatMatrix = (seconds = 120, km = 2) =>
  vi
    .fn()
    .mockImplementation(async (s: LngLat[], t: LngLat[]) =>
      s.map(() => t.map(() => ({ seconds, km }))),
    );

const baseInput = {
  route: longRoute(),
  vehicle,
  socArrivalMinKwh: 6,
  socTargetKwh: 48,
  ambientTempC: 20,
  hasElevation: false,
  nowMs: NOW,
  tripStartMs: NOW,
};

/** A costed tariff's main price: the amount and unit, formatted by the client in its locale. */
const eurPer = (amount: number, unit: "kWh" | "h" | "session") => ({
  amount,
  currency: "EUR",
  unit,
});

const monday = (time: string) => ({ date: "2026-10-05", time, day: "MO" as const });

describe("planCharges", () => {
  it("returns no stops when the trip is within range", async () => {
    const cb = { requestCorridorChargers: vi.fn().mockResolvedValue([]), requestMatrix: vi.fn() };
    // 60kWh battery, 200Wh/km => ~300km range; start full, reserve 0 -> reachable
    const plan = await planCharges({ ...baseInput, socStartKwh: 60, socArrivalMinKwh: 0 }, cb);
    expect(plan.stops).toHaveLength(0);
    expect(cb.requestCorridorChargers).not.toHaveBeenCalled();
  });

  it("inserts a compatible mid-route stop when range is insufficient", async () => {
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([site("mid", 1.35)]),
      requestMatrix: flatMatrix(),
    };
    const plan = await planCharges({ ...baseInput, socStartKwh: 30 }, cb);
    expect(plan.stops.length).toBeGreaterThanOrEqual(1);
    expect(plan.stops[0].connector).toBe("ccs2");
    expect(plan.stops[0].evse.key).toBe("mid-1");
    expect(plan.totalChargeSeconds).toBeGreaterThan(0);
  });

  it("warns unreachable when no compatible charger exists", async () => {
    const chademoOnly = site("chademo-only", 1.35, {
      evses: [
        evse("e1", {
          connectors: [connector("e1/1", { standard: "CHADEMO", maxPowerKw: 50 })],
        }),
      ],
    });
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([chademoOnly]),
      requestMatrix: vi.fn().mockResolvedValue([[{ seconds: 120, km: 2 }]]),
    };
    const plan = await planCharges({ ...baseInput, socStartKwh: 20 }, cb);
    expect(plan.warnings.some((w) => w.kind === "unreachable")).toBe(true);
  });

  it("emits no-charger-data when the source returns nothing but a stop was needed", async () => {
    const cb = { requestCorridorChargers: vi.fn().mockResolvedValue([]), requestMatrix: vi.fn() };
    const plan = await planCharges({ ...baseInput, socStartKwh: 20 }, cb);
    expect(plan.warnings.some((w) => w.kind === "no-charger-data")).toBe(true);
  });

  it("says the charger sources did not answer when a window's search fails", async () => {
    const cb = {
      requestCorridorChargers: vi.fn().mockRejectedValue(new ChargerSourcesUnavailableError()),
      requestMatrix: vi.fn(),
    };
    const plan = await planCharges({ ...baseInput, socStartKwh: 20 }, cb);
    expect(plan.warnings).toEqual([
      { kind: "charger-sources-unavailable" },
      { kind: "unreachable", afterStopIndex: -1 },
    ]);
  });

  it("lets any other failure of the charger search fail the plan", async () => {
    const cb = {
      requestCorridorChargers: vi.fn().mockRejectedValue(new TypeError("bug")),
      requestMatrix: vi.fn(),
    };
    await expect(planCharges({ ...baseInput, socStartKwh: 20 }, cb)).rejects.toThrow("bug");
  });

  it("does not loop forever when it cannot progress from the start point", async () => {
    // Start already below reserve: divertIdx cannot advance past startIdx.
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([site("mid", 0.0)]),
      requestMatrix: flatMatrix(60, 1),
    };
    const plan = await planCharges({ ...baseInput, socStartKwh: 3 }, cb);
    expect(plan.stops.length).toBeLessThanOrEqual(1);
    expect(plan.warnings.some((w) => w.kind === "unreachable")).toBe(true);
  });

  it("bridges above the taper SoC on the final leg when needed to finish", async () => {
    // Small 20 kWh car, taper 80% (16 kWh). ~97 km route; one stop, after which the
    // remaining leg needs > taper but < a full battery → must charge above taper.
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
      requestCorridorChargers: vi.fn().mockResolvedValue([site("mid", 0.4)]),
      requestMatrix: flatMatrix(60, 1),
    };
    const plan = await planCharges(
      {
        ...baseInput,
        route: shortRoute,
        vehicle: smallEv,
        socStartKwh: 12,
        socArrivalMinKwh: 2,
        socTargetKwh: 16,
      },
      cb,
    );
    expect(plan.stops).toHaveLength(1);
    expect(plan.stops[0].departSocKwh).toBeGreaterThan(16); // charged past the 80% taper to finish
  });

  it("prefers a charger with free stalls over a full one at similar detour (near-term)", async () => {
    const full = withStatuses("full", 1.35, ["occupied", "charging"]);
    const free = withStatuses("free", 1.36, ["available", "available"]);
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([full, free]),
      requestMatrix: flatMatrix(),
    };
    // Low start SoC → first stop is reached soon (well within the availability horizon).
    const plan = await planCharges({ ...baseInput, socStartKwh: 18 }, cb);
    expect(plan.stops[0]?.site.id).toBe("free");
  });

  it("does not treat a stale status as current occupancy", async () => {
    const full = withStatuses("full", 1.35, ["occupied", "occupied"], true);
    const free = withStatuses("free", 1.36, ["available", "available"]);
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([full, free]),
      requestMatrix: flatMatrix(),
    };
    const plan = await planCharges({ ...baseInput, socStartKwh: 18 }, cb);
    expect(plan.stops[0]?.site.id).toBe("full");
  });

  it("ignores occupancy for a far-future stop (state would be stale on arrival)", async () => {
    const full = withStatuses("full", 1.35, ["occupied"]);
    const free = withStatuses("free", 1.36, ["available"]);
    // "full" is occupied but a much shorter detour; "free" is empty but far.
    // targets order is [full, free, onward]; give "full" the cheap detour.
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([full, free]),
      requestMatrix: vi.fn().mockImplementation(async (s: LngLat[], t: LngLat[]) =>
        s.map(() =>
          t.map((_: unknown, ti: number) => ({
            seconds: ti === 0 ? 60 : 300,
            km: ti === 0 ? 1 : 5,
          })),
        ),
      ),
    };
    // socStartKwh 40 → a stop is needed but the first divert is ~141 km in, an ETA
    // well beyond the availability horizon, so occupancy is NOT penalised and the
    // shorter detour ("full") must win.
    const plan = await planCharges({ ...baseInput, socStartKwh: 40 }, cb);
    expect(plan.stops[0]?.site.id).toBe("full");
  });

  it("departAt moves the arrival time used for tariffs; occupancy uses now", async () => {
    const night = energy(0.29, {
      days: ["MO", "TU", "WE", "TH", "FR"],
      startTime: "18:00",
      endTime: "08:00",
    });
    const priced = (id: string, lng: number, statuses: EvseStatus[]) => ({
      ...withStatuses(id, lng, statuses),
      tariffs: [tariff("t1", [night, energy(0.59)])],
    });
    const full = priced("full", 1.35, ["occupied"]);
    const free = priced("free", 1.36, ["available"]);
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([full, free]),
      requestMatrix: flatMatrix(),
    };
    const input = { ...baseInput, socStartKwh: 18 };

    const leavingNow = await planCharges(input, cb);
    expect(leavingNow.stops[0]?.site.id).toBe("free");
    expect(leavingNow.stops[0]?.estimatedCost?.price).toEqual(eurPer(0.59, "kWh"));

    // Leaving at 20:00 the same Monday: the stop falls in the night window, and
    // occupancy read now says nothing about a stop ten hours ahead.
    const evening = await planCharges(
      { ...input, tripStartMs: Date.parse("2026-10-05T20:00:00+02:00") },
      cb,
    );
    expect(evening.stops[0]?.site.id).toBe("full");
    expect(evening.stops[0]?.estimatedCost?.price).toEqual(eurPer(0.29, "kWh"));
    expect(evening.stops[0]?.estimatedCost?.tariffId).toBe("t1");
  });

  it("favours a preferred network even at a modestly longer detour", async () => {
    const ionity = site("ionity", 1.35, { operator: { name: "IONITY GmbH" } });
    const other = site("other", 1.36, { operator: { name: "SomeCPO" } });
    // "other" has the shorter detour (ti=0); "ionity" is a bit farther (ti=1).
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([other, ionity]),
      requestMatrix: vi.fn().mockImplementation(async (s: LngLat[], t: LngLat[]) =>
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
        ...baseInput,
        socStartKwh: 30,
        preferredNetworkKeys: new Set(["ionity"]),
        avoidedNetworkKeys: new Set(),
      },
      cb,
    );
    expect(plan.stops[0]?.site.id).toBe("ionity");
  });

  it("avoids a network the user named by brand, not by its full registered name", async () => {
    const enbw = site("enbw", 1.35, { operator: { name: "EnBW mobility+ AG und Co.KG" } });
    const other = site("other", 1.36, { operator: { name: "SomeCPO" } });
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([enbw, other]),
      // "enbw" is the shorter detour (ti=0), so only the avoid penalty can flip this.
      requestMatrix: vi.fn().mockImplementation(async (s: LngLat[], t: LngLat[]) =>
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
        ...baseInput,
        socStartKwh: 30,
        preferredNetworkKeys: new Set(),
        avoidedNetworkKeys: new Set(["enbw"]),
      },
      cb,
    );
    expect(plan.stops[0]?.site.id).toBe("other");
  });

  it("treats an exclusive whitelist named by brand as covering the full operator name", async () => {
    const enbw = site("enbw", 1.35, { operator: { name: "EnBW mobility+ AG und Co.KG" } });
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([enbw]),
      requestMatrix: flatMatrix(),
    };
    const plan = await planCharges(
      { ...baseInput, socStartKwh: 30, exclusiveNetworkKeys: new Set(["enbw"]) },
      cb,
    );
    expect(plan.stops[0]?.site.id).toBe("enbw");
    expect(plan.warnings.some((w) => w.kind === "no-allowed-network")).toBe(false);
  });

  it("keeps an avoided network when it is the only reachable option (soft, not a filter)", async () => {
    const only = site("only", 1.35, { operator: { name: "SomeCPO" } });
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([only]),
      requestMatrix: flatMatrix(),
    };
    const plan = await planCharges(
      {
        ...baseInput,
        socStartKwh: 30,
        preferredNetworkKeys: new Set(),
        avoidedNetworkKeys: new Set(["somecpo"]),
      },
      cb,
    );
    expect(plan.stops[0]?.site.id).toBe("only"); // penalised but still chosen
  });

  it("prefers the cheaper of two comparable chargers", async () => {
    const cheap = site("cheap", 1.35, { tariffs: [tariff("t", [energy(0.39)])] });
    const pricey = site("pricey", 1.36, { tariffs: [tariff("t", [energy(0.79)])] });
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([pricey, cheap]),
      requestMatrix: flatMatrix(),
    };
    const plan = await planCharges({ ...baseInput, socStartKwh: 30 }, cb);
    expect(plan.stops[0]?.site.id).toBe("cheap");
    expect(plan.stops[0]?.estimatedCost?.currency).toBe("EUR");
  });

  it("never lets price override a large detour, and ignores it when costWeight=0", async () => {
    const cheapFar = site("cheapFar", 1.4, { tariffs: [tariff("t", [energy(0.3)])] });
    const pricyNear = site("pricyNear", 1.35, { tariffs: [tariff("t", [energy(0.9)])] });
    // pricyNear (ti=0) is close; cheapFar (ti=1) is a 30-min detour.
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([pricyNear, cheapFar]),
      requestMatrix: vi.fn().mockImplementation(async (s: LngLat[], t: LngLat[]) =>
        s.map(() =>
          t.map((_: unknown, ti: number) => ({
            seconds: ti === 0 ? 60 : 1800,
            km: ti === 0 ? 1 : 30,
          })),
        ),
      ),
    };
    const args = { ...baseInput, socStartKwh: 30 };
    const off = await planCharges({ ...args, costWeight: 0 }, cb);
    const on = await planCharges({ ...args, costWeight: 1 }, cb);
    expect(off.stops[0]?.site.id).toBe("pricyNear"); // price ignored → nearest wins
    expect(on.stops[0]?.site.id).toBe("pricyNear"); // capped (~6 min) penalty << 30-min detour
  });

  it("exclusive mode is a hard whitelist and warns when it leaves nothing", async () => {
    const ionity = site("ionity", 1.35, { operator: { name: "Ionity" } });
    const cb = {
      requestCorridorChargers: vi.fn().mockResolvedValue([ionity]),
      requestMatrix: flatMatrix(),
    };
    const base = { ...baseInput, socStartKwh: 30 };
    const ok = await planCharges({ ...base, exclusiveNetworkKeys: new Set(["ionity"]) }, cb);
    expect(ok.stops[0]?.site.id).toBe("ionity");
    const blocked = await planCharges({ ...base, exclusiveNetworkKeys: new Set(["fastned"]) }, cb);
    expect(blocked.stops).toHaveLength(0);
    expect(blocked.warnings.some((w) => w.kind === "no-allowed-network")).toBe(true);
  });
});

describe("pickEvse", () => {
  it("an out-of-order EVSE is skipped and a fresh available one at equal power is preferred", () => {
    const at = new Date(NOW - 60_000).toISOString();
    const s = site("s", 1, {
      evses: [
        evse("broken", {
          status: "out_of_order",
          statusAt: at,
          connectors: [connector("b/1", { maxPowerKw: 300 })],
        }),
        evse("busy", { status: "occupied", statusAt: at }),
        evse("stale", { status: "available", statusAt: at, stale: true }),
        evse("free", { status: "available", statusAt: at }),
        evse("slow", {
          status: "available",
          statusAt: at,
          connectors: [connector("s/1", { maxPowerKw: 50 })],
        }),
      ],
    });
    const pick = pickEvse(s, vehicle);
    expect(pick?.evse.key).toBe("free");
    expect(pick?.standard).toBe("ccs2");
    expect(pick?.powerKw).toBe(150);
  });

  it("prefers the highest power over a free charge point", () => {
    const at = new Date(NOW - 60_000).toISOString();
    const s = site("s", 1, {
      evses: [
        evse("free", {
          status: "available",
          statusAt: at,
          connectors: [connector("f/1", { maxPowerKw: 50 })],
        }),
        evse("busy", { status: "charging", statusAt: at }),
      ],
    });
    expect(pickEvse(s, vehicle)?.evse.key).toBe("busy");
  });

  it("a CCS1 connector does not serve a CCS2-only vehicle", () => {
    const s = site("s", 1, {
      evses: [evse("e", { connectors: [connector("e/1", { standard: "IEC_62196_T1_COMBO" })] })],
    });
    expect(pickEvse(s, vehicle)).toBeNull();
  });

  it("skips closed and planned sites, planned charge points and connectors without power", () => {
    expect(pickEvse(site("s", 1, { closed: true }), vehicle)).toBeNull();
    expect(pickEvse(site("s", 1, { planned: true }), vehicle)).toBeNull();
    expect(
      pickEvse(site("s", 1, { evses: [evse("e", { lifecycle: "planned" })] }), vehicle),
    ).toBeNull();
    expect(
      pickEvse(site("s", 1, { evses: [evse("e", { status: "removed" })] }), vehicle),
    ).toBeNull();
    expect(
      pickEvse(
        site("s", 1, {
          evses: [evse("e", { connectors: [connector("e/1", { maxPowerKw: undefined })] })],
        }),
        vehicle,
      ),
    ).toBeNull();
  });

  it("lets a vehicle with a Tesla inlet use a NACS connector", () => {
    const tesla: EvVehicleSpec = { ...vehicle, connectors: ["tesla_ccs", "ccs2"] };
    const s = site("s", 1, {
      evses: [
        evse("e", { connectors: [connector("e/1", { standard: "TESLA_S", maxPowerKw: 250 })] }),
      ],
    });
    expect(pickEvse(s, tesla)).toMatchObject({ standard: "nacs", powerKw: 250 });
  });
});

describe("tariffMatches", () => {
  const conn = connector("e/1");
  const session = (over: Partial<Parameters<typeof tariffMatches>[2]> = {}) => ({
    connector: conn,
    powerKw: 150,
    arrivalLocal: monday("10:00"),
    addedKwh: 30,
    chargeSeconds: 1200,
    ...over,
  });
  const t = tariff("t", []);

  it("a weekday 18:00–08:00 rate applies at 19:30 and not at 10:00 station time", () => {
    const night = energy(0.29, {
      days: ["MO", "TU", "WE", "TH", "FR"],
      startTime: "18:00",
      endTime: "08:00",
    });
    expect(tariffMatches(t, night, session({ arrivalLocal: monday("19:30") }))).toBe(true);
    expect(tariffMatches(t, night, session({ arrivalLocal: monday("10:00") }))).toBe(false);
    expect(tariffMatches(t, night, session({ arrivalLocal: monday("08:00") }))).toBe(false);
    expect(
      tariffMatches(
        t,
        night,
        session({ arrivalLocal: { date: "2026-10-04", time: "19:30", day: "SU" } }),
      ),
    ).toBe(false);
  });

  it("checks the after-midnight part of a window against the day it started", () => {
    const night = energy(0.29, {
      days: ["MO", "TU", "WE", "TH", "FR"],
      startTime: "18:00",
      endTime: "08:00",
    });
    const at = (date: string, day: "MO" | "TU" | "SA", time: string) =>
      session({ arrivalLocal: { date, time, day } });
    // Monday 03:00 belongs to Sunday night; Tuesday and Saturday 03:00 to Monday and Friday nights.
    expect(tariffMatches(t, night, at("2026-10-05", "MO", "03:00"))).toBe(false);
    expect(tariffMatches(t, night, at("2026-10-06", "TU", "03:00"))).toBe(true);
    expect(tariffMatches(t, night, at("2026-10-10", "SA", "03:00"))).toBe(true);
  });

  it("checks dates, power, and current only where the connector states amperage", () => {
    expect(tariffMatches(t, energy(1, { startDate: "2026-10-06" }), session())).toBe(false);
    expect(tariffMatches(t, energy(1, { endDate: "2026-10-05" }), session())).toBe(false);
    expect(
      tariffMatches(t, energy(1, { startDate: "2026-10-05", endDate: "2026-10-06" }), session()),
    ).toBe(true);
    expect(tariffMatches(t, energy(1, { minPowerKw: 50 }), session({ powerKw: 22 }))).toBe(false);
    expect(tariffMatches(t, energy(1, { maxPowerKw: 50 }), session({ powerKw: 150 }))).toBe(false);
    expect(tariffMatches(t, energy(1, { minCurrentA: 100 }), session())).toBe(true);
    expect(
      tariffMatches(
        t,
        energy(1, { minCurrentA: 100 }),
        session({ connector: connector("e/1", { maxAmperage: 32 }) }),
      ),
    ).toBe(false);
  });

  it("never applies a reservation element", () => {
    expect(tariffMatches(t, energy(1, { reservation: "RESERVATION" }), session())).toBe(false);
  });
});

describe("estimateSessionCost", () => {
  const facts = (over: Partial<Parameters<typeof estimateSessionCost>[2]> = {}) => ({
    powerKw: 150,
    arrivalLocal: monday("10:00"),
    addedKwh: 20,
    chargeSeconds: 1800,
    ...over,
  });
  const pickOn = (s: ChargingSite) => {
    const pick = pickEvse(s, vehicle);
    if (!pick) throw new Error("no pick");
    return pick;
  };

  it("sums the first matching element of each component, by quantity, adding VAT", () => {
    const s = site("s", 1, {
      tariffs: [
        tariff(
          "t",
          [
            {
              components: [
                { type: "energy", price: 0.5, vatPct: 20 },
                { type: "time", price: 6, vatPct: 20 },
              ],
            },
            {
              components: [
                { type: "energy", price: 9 },
                { type: "flat", price: 1, vatPct: 20 },
                { type: "idle", price: 50 },
              ],
            },
          ],
          { priceIncludesVat: false },
        ),
      ],
    });
    // (0.5 × 20 kWh + 6 × 0.5 h + 1) × 1.2 = 16.8
    const cost = estimateSessionCost(s, pickOn(s), facts());
    expect(cost?.amount).toBeCloseTo(16.8);
    expect(cost).toMatchObject({ currency: "EUR", tariffId: "t", price: eurPer(0.6, "kWh") });
  });

  it("rounds the billed quantity up to the step size", () => {
    const s = site("s", 1, {
      tariffs: [
        tariff("t", [
          {
            components: [
              { type: "energy", price: 1, stepSize: 1000 },
              { type: "time", price: 60, stepSize: 900 },
            ],
          },
        ]),
      ],
    });
    // 20.2 kWh billed as 21; 1000 s billed as 1800 s = 0.5 h
    const cost = estimateSessionCost(s, pickOn(s), facts({ addedKwh: 20.2, chargeSeconds: 1000 }));
    expect(cost?.amount).toBeCloseTo(21 + 30);
  });

  it("splits a session that runs into a time window at the window's edge", () => {
    const s = site("s", 1, {
      tariffs: [tariff("t", [energy(0.2, { startTime: "18:00", endTime: "08:00" }), energy(0.5)])],
    });
    // 17:30 for an hour: half at the day rate, half at the night rate.
    const cost = estimateSessionCost(
      s,
      pickOn(s),
      facts({ arrivalLocal: monday("17:30"), addedKwh: 40, chargeSeconds: 3600 }),
    );
    expect(cost?.amount).toBeCloseTo(20 * 0.5 + 20 * 0.2);
    expect(cost?.price).toEqual(eurPer(0.5, "kWh"));
  });

  it("does not cost a tariff that prices only part of the session", () => {
    const s: ChargingSite = {
      ...site("s", 1),
      tariffs: [
        tariff("night-only", [energy(0.2, { startTime: "18:00", endTime: "08:00" })]),
        tariff("all-day", [energy(0.5)]),
      ],
    };
    const cost = estimateSessionCost(
      s,
      pickOn(s),
      facts({ arrivalLocal: monday("17:30"), addedKwh: 40, chargeSeconds: 3600 }),
    );
    expect(cost).toMatchObject({ tariffId: "all-day" });
    expect(cost?.amount).toBeCloseTo(20);
  });

  it("costs a time fee only where its window applies, on top of all-day energy", () => {
    const s = site("s", 1, {
      tariffs: [
        tariff("t", [
          energy(0.4),
          {
            components: [{ type: "time", price: 6 }],
            restrictions: { startTime: "18:00", endTime: "08:00" },
          },
        ]),
      ],
    });
    // 17:30 for an hour: 40 kWh × 0.4, plus the 30 minutes after 18:00 at 6/h.
    const cost = estimateSessionCost(
      s,
      pickOn(s),
      facts({ arrivalLocal: monday("17:30"), addedKwh: 40, chargeSeconds: 3600 }),
    );
    expect(cost).toMatchObject({ tariffId: "t" });
    expect(cost?.amount).toBeCloseTo(16 + 3);
  });

  it("chooses the base price from the elements this session's power can use", () => {
    const s = site("s", 1, {
      tariffs: [
        tariff("t", [
          energy(0.3, { minPowerKw: 50 }),
          { components: [{ type: "time", price: 6 }], restrictions: { maxPowerKw: 50 } },
        ]),
      ],
    });
    // An 11 kW AC session for an hour: DC energy does not apply, AC time covers it.
    const cost = estimateSessionCost(
      s,
      pickOn(s),
      facts({ powerKw: 11, addedKwh: 11, chargeSeconds: 3600 }),
    );
    expect(cost).toMatchObject({ tariffId: "t", price: eurPer(6, "h") });
    expect(cost?.amount).toBeCloseTo(6);
  });

  it("does not cost a time-only tariff that prices only part of the session", () => {
    const s: ChargingSite = {
      ...site("s", 1),
      tariffs: [
        tariff("night-time", [
          { components: [{ type: "time", price: 1 }], restrictions: { startTime: "18:00" } },
        ]),
        tariff("all-day", [energy(0.5)]),
      ],
    };
    const cost = estimateSessionCost(
      s,
      pickOn(s),
      facts({ arrivalLocal: monday("17:30"), addedKwh: 40, chargeSeconds: 3600 }),
    );
    expect(cost).toMatchObject({ tariffId: "all-day" });
  });

  it("does not cost a tariff whose validity ends during the session", () => {
    const s: ChargingSite = {
      ...site("s", 1),
      tariffs: [
        tariff("ending", [energy(0.2, { endDate: "2026-10-06" })]),
        tariff("lasting", [energy(0.5)]),
      ],
    };
    // Monday 23:30 for an hour: the cheap tariff ends at midnight.
    const cost = estimateSessionCost(
      s,
      pickOn(s),
      facts({ arrivalLocal: monday("23:30"), addedKwh: 40, chargeSeconds: 3600 }),
    );
    expect(cost).toMatchObject({ tariffId: "lasting" });
  });

  it("splits a session that runs past midnight into a weekend rate", () => {
    const s = site("s", 1, {
      tariffs: [tariff("t", [energy(0.3, { days: ["SA", "SU"] }), energy(0.6)])],
    });
    // Friday 23:30 for an hour: half on Friday, half on Saturday.
    const cost = estimateSessionCost(
      s,
      pickOn(s),
      facts({
        arrivalLocal: { date: "2026-10-09", time: "23:30", day: "FR" },
        addedKwh: 40,
        chargeSeconds: 3600,
      }),
    );
    expect(cost?.amount).toBeCloseTo(20 * 0.6 + 20 * 0.3);
  });

  it("first 20 kWh at 0.29, then 0.49", () => {
    const s = site("s", 1, {
      tariffs: [tariff("t", [energy(0.29, { maxKwh: 20 }), energy(0.49)])],
    });
    expect(estimateSessionCost(s, pickOn(s), facts({ addedKwh: 40 }))?.amount).toBeCloseTo(
      20 * 0.29 + 20 * 0.49,
    );
    expect(estimateSessionCost(s, pickOn(s), facts({ addedKwh: 10 }))?.amount).toBeCloseTo(
      10 * 0.29,
    );
  });

  it("never bills parking time, the time not charging that a planned stop does not spend", () => {
    const s = site("s", 1, {
      tariffs: [
        tariff("t", [
          {
            components: [
              { type: "energy", price: 0.3 },
              { type: "parking_time", price: 2 },
            ],
          },
          {
            components: [{ type: "parking_time", price: 5 }],
            restrictions: { minDurationSec: 3600 },
          },
        ]),
      ],
    });
    const cost = estimateSessionCost(s, pickOn(s), facts({ addedKwh: 30, chargeSeconds: 5400 }));
    expect(cost?.amount).toBeCloseTo(9);
    expect(cost?.price).toEqual(eurPer(0.3, "kWh"));
    const parkingOnly = site("p", 1, {
      tariffs: [tariff("p", [{ components: [{ type: "parking_time", price: 2 }] }])],
    });
    expect(estimateSessionCost(parkingOnly, pickOn(parkingOnly), facts())).toBeNull();
  });

  it("caps a session at the tariff's max price, grossed up by the main component's VAT", () => {
    const s = site("s", 1, {
      tariffs: [
        tariff(
          "t",
          [
            {
              components: [
                { type: "energy", price: 0.5, vatPct: 20 },
                { type: "flat", price: 0.1, vatPct: 10 },
              ],
            },
          ],
          { priceIncludesVat: false, maxPrice: 10 },
        ),
      ],
    });
    // 40 kWh would be 24.11 gross; the cap is 10 excl. VAT at the energy component's 20 %.
    expect(estimateSessionCost(s, pickOn(s), facts({ addedKwh: 40 }))?.amount).toBeCloseTo(12);
  });

  it("raises a session to the tariff's min price before comparing tariffs", () => {
    const s: ChargingSite = {
      ...site("s", 1),
      tariffs: [tariff("floored", [energy(0.3)], { minPrice: 5 }), tariff("plain", [energy(0.4)])],
    };
    // floored: 2 kWh × 0.3 = 0.6 → 5; plain: 0.8
    const cost = estimateSessionCost(s, pickOn(s), facts({ addedKwh: 2 }));
    expect(cost).toMatchObject({ tariffId: "plain" });
    expect(cost?.amount).toBeCloseTo(0.8);
    const floored = site("s", 1, { tariffs: [tariff("floored", [energy(0.3)], { minPrice: 5 })] });
    expect(
      estimateSessionCost(floored, pickOn(floored), facts({ addedKwh: 2 }))?.amount,
    ).toBeCloseTo(5);
  });

  it("prefers an ad-hoc tariff, and takes a profile or regular one only when none matches", () => {
    const tied: ChargingSite = {
      ...site("s", 1),
      tariffs: [
        tariff("regular", [energy(0.4)], { type: "regular" }),
        tariff("adhoc", [energy(0.4)], { type: "ad_hoc" }),
      ],
    };
    expect(estimateSessionCost(tied, pickOn(tied), facts())?.tariffId).toBe("adhoc");

    const cheaperProfile: ChargingSite = {
      ...site("s", 1),
      tariffs: [
        tariff("cheap", [energy(0.2)], { type: "profile_cheap" }),
        tariff("adhoc", [energy(0.5)], { type: "ad_hoc" }),
      ],
    };
    expect(estimateSessionCost(cheaperProfile, pickOn(cheaperProfile), facts())?.tariffId).toBe(
      "adhoc",
    );

    const weekendAdHoc: ChargingSite = {
      ...site("s", 1),
      tariffs: [
        tariff("cheap", [energy(0.2)], { type: "profile_cheap" }),
        tariff("adhoc", [energy(0.5, { days: ["SA", "SU"] })], { type: "ad_hoc" }),
      ],
    };
    expect(estimateSessionCost(weekendAdHoc, pickOn(weekendAdHoc), facts())?.tariffId).toBe(
      "cheap",
    );
  });

  it("the card's tariff summary is the costed tariff, not the first", () => {
    const base = site("s", 1);
    const s: ChargingSite = {
      ...base,
      evses: [evse("e", { connectors: [connector("e/1", { tariffIds: ["dear", "cheap"] })] })],
      tariffs: [
        tariff("dear", [energy(0.79)]),
        tariff("cheap", [energy(0.39)]),
        tariff("ac", [energy(0.1)]),
      ],
    };
    const cost = estimateSessionCost(s, pickOn(s), facts());
    expect(cost).toMatchObject({ tariffId: "cheap", price: eurPer(0.39, "kWh") });
    expect(cost?.amount).toBeCloseTo(7.8);
  });

  it("uses the site-wide tariffs when the connector names none", () => {
    const s: ChargingSite = {
      ...site("s", 1),
      evses: [
        evse("e", { connectors: [connector("e/1")] }),
        evse("ac", {
          connectors: [
            connector("ac/1", {
              standard: "IEC_62196_T2",
              current: "ac",
              maxPowerKw: 11,
              tariffIds: ["ac"],
            }),
          ],
        }),
      ],
      tariffs: [tariff("ac", [energy(0.1)]), tariff("site", [energy(0.45)])],
    };
    expect(estimateSessionCost(s, pickOn(s), facts())?.tariffId).toBe("site");
  });

  it("is null without a tariff or without a costed component", () => {
    expect(estimateSessionCost(site("s", 1), pickOn(site("s", 1)), facts())).toBeNull();
    const idleOnly = site("s", 1, {
      tariffs: [tariff("t", [{ components: [{ type: "idle", price: 10 }] }])],
    });
    expect(estimateSessionCost(idleOnly, pickOn(idleOnly), facts())).toBeNull();
  });
});
