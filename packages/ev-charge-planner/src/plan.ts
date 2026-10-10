import type {
  ConnectorStandard,
  CurrentStandard,
  EvVehicleSpec,
  LngLat,
  Route,
  TariffPrice,
} from "@openmapx/core";
import {
  connectorStandardOf,
  isoWithOffsetInZone,
  matchesAnyOperator,
  normalizeOperator,
  timeZoneAt,
} from "@openmapx/core";
import {
  availabilityOf,
  type ChargingConnector,
  type ChargingSite,
  type EnergyTariff,
  type EnergyTariffRestrictions,
  type Evse,
  type EvseStatus,
  freshEvseStatus,
} from "@openmapx/mobility-core/ev-charging";
import { chargeSecondsFor } from "./charging";
import { routeEnergyKwh } from "./consumption";
import {
  type ChargePlan,
  ChargerSourcesUnavailableError,
  type MatrixCell,
  type PlanCallbacks,
  type PlanInput,
  type PlannedStop,
  type PlanWarning,
  type SessionCost,
} from "./types";

const MAX_STOPS = 12;
const DETOUR_UPLIFT = 1.15; // off-route energy penalty (matrix gives no elevation)
const DETOUR_RESERVE_KWH_FRAC = 0.05; // keep this much battery spare to divert
const REACH_EPS_KWH = 0.05; // float slack so an "exactly enough" charge ends the loop
const MAX_WINDOW_KM = 30; // keeps the search bbox under the 0.6 deg² budget
const AVAILABILITY_HORIZON_SEC = 45 * 60; // beyond this ETA, current occupancy says nothing about arrival
const OCCUPANCY_PENALTY_SEC = 12 * 60; // max ranking penalty for a full, imminent charger
const NETWORK_PREFERENCE_BONUS_SEC = 10 * 60; // worth ~10 min detour to use my network
const NETWORK_AVOID_PENALTY_SEC = 10 * 60; // symmetric de-prioritisation
const VALUE_OF_TIME_PER_HOUR = 20; // currency units/hour (money↔time conversion)
const MAX_COST_PENALTY_SEC = 6 * 60; // cap: price is a tiebreaker, below the occupancy and network caps

type Day = NonNullable<EnergyTariffRestrictions["days"]>[number];
type TariffElement = EnergyTariff["elements"][number];
type Component = TariffElement["components"][number];

/** Weekdays in `Date.getUTCDay()` order. */
const WEEK: readonly Day[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * Standards that carry direct current when the source does not say. NACS and
 * the Tesla plug are taken as Superchargers, the case a route planner meets.
 */
const DC_STANDARDS: ReadonlySet<ConnectorStandard> = new Set([
  "ccs1",
  "ccs2",
  "chademo",
  "gbt_dc",
  "nacs",
  "tesla_ccs",
]);

/** Statuses of a charge point or connector that cannot be charged at. */
const UNUSABLE: ReadonlySet<EvseStatus> = new Set([
  "out_of_order",
  "inoperative",
  "planned",
  "removed",
]);

/** Charge point lifecycles that are not in service. */
const NOT_IN_SERVICE: ReadonlySet<string> = new Set([
  "planned",
  "temporarily_closed",
  "decommissioned",
]);

/**
 * The component types a charging stop pays for, in the order the summary
 * prefers them. Idle, reservation and distance components are not part of a
 * planned stop, and neither is parking time: it is the time plugged in but
 * not charging, and a planned stop leaves when the charge ends.
 */
const COSTED: readonly Component["type"][] = ["energy", "time", "flat", "session"];

/** The unit a costed component's price is quoted per. */
const UNIT: Partial<Record<Component["type"], TariffPrice["unit"]>> = {
  energy: "kWh",
  time: "h",
  flat: "session",
  session: "session",
};

/** The charge point and connector a vehicle would charge on at a site. */
export interface EvsePick {
  evse: Evse;
  connector: ChargingConnector;
  standard: ConnectorStandard;
  powerKw: number;
}

/** A station's wall clock at the moment the vehicle arrives. */
export interface LocalArrival {
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`, 24-hour. */
  time: string;
  day: Day;
}

/** A planned charging session, as tariff restrictions read it. */
export interface SessionFacts {
  /** The power the session charges at: the slower of the connector and the vehicle. */
  powerKw: number;
  arrivalLocal: LocalArrival;
  addedKwh: number;
  chargeSeconds: number;
}

/**
 * Whether the vehicle plugs into a connector of this standard. The vehicle
 * presets fan a NACS inlet out to `tesla_ccs` plus CCS, and a garage car may
 * list only `tesla_ccs`: a Tesla inlet takes a NACS plug.
 */
function accepts(vehicle: EvVehicleSpec, standard: ConnectorStandard): boolean {
  if (vehicle.connectors.includes(standard)) return true;
  return standard === "nacs" && vehicle.connectors.includes("tesla_ccs");
}

function currentOf(connector: ChargingConnector, standard: ConnectorStandard): CurrentStandard {
  return connector.current ?? (DC_STANDARDS.has(standard) ? "dc" : "ac");
}

/** A status the source still stands by: present and not past its validity. */
function liveStatus(status: EvseStatus | undefined, stale: boolean): EvseStatus | undefined {
  return status !== undefined && !stale ? status : undefined;
}

function outOfService(evse: Evse): boolean {
  if (evse.lifecycle && NOT_IN_SERVICE.has(evse.lifecycle)) return true;
  const own = liveStatus(evse.status, evse.stale);
  if (own && UNUSABLE.has(own)) return true;
  const fresh = freshEvseStatus(evse)?.status;
  return fresh !== undefined && UNUSABLE.has(fresh);
}

/**
 * The charge point and connector a vehicle would use at a site: a connector
 * the vehicle plugs into, with a known power, on a charge point in service,
 * at the highest power, and at equal power on one a fresh status says is
 * free. Closed and planned sites have none.
 */
export function pickEvse(site: ChargingSite, vehicle: EvVehicleSpec): EvsePick | null {
  if (site.closed || site.planned) return null;
  let best: { pick: EvsePick; free: boolean } | null = null;
  for (const evse of site.evses) {
    if (outOfService(evse)) continue;
    const free = freshEvseStatus(evse)?.status === "available";
    for (const connector of evse.connectors) {
      const status = liveStatus(connector.status, connector.stale);
      if (status && UNUSABLE.has(status)) continue;
      const standard = connectorStandardOf(connector.standard);
      if (!standard || !accepts(vehicle, standard)) continue;
      const powerKw = connector.maxPowerKw ?? 0;
      if (powerKw <= 0) continue; // unknown/zero usable power — not a valid charge stop
      const bestKw: number = best?.pick.powerKw ?? 0;
      if (!best || powerKw > bestKw || (powerKw === bestKw && free && !best.free)) {
        best = { pick: { evse, connector, standard, powerKw }, free };
      }
    }
  }
  return best?.pick ?? null;
}

/** Effective charge power + which onboard limit applies, from the connector's current. */
function powerCaps(pick: EvsePick, vehicle: PlanInput["vehicle"]) {
  const vehicleMaxKw =
    currentOf(pick.connector, pick.standard) === "dc" ? vehicle.maxDcKw : vehicle.maxAcKw;
  return { chargerPowerKw: pick.powerKw, vehicleMaxKw };
}

/** The station's wall clock at an instant: the site's own zone, else the zone at its location. */
function localArrival(site: ChargingSite, atMs: number): LocalArrival {
  const [lng, lat] = site.coordinates;
  const zone = site.timeZone ?? timeZoneAt(lat, lng) ?? "UTC";
  const iso = isoWithOffsetInZone(new Date(atMs), zone);
  const date = iso.slice(0, 10);
  const [y, m, d] = date.split("-").map(Number);
  return { date, time: iso.slice(11, 16), day: WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] };
}

/** `min` inclusive, `max` exclusive, as tariff restrictions bound a value. */
function within(value: number, min: number | undefined, max: number | undefined): boolean {
  return (min === undefined || value >= min) && (max === undefined || value < max);
}

/** Whether a `HH:MM` time falls in a daily window; a window ending before it starts crosses midnight. */
function withinWindow(time: string, start: string | undefined, end: string | undefined): boolean {
  if (start && end && start > end) return time >= start || time < end;
  return (!start || time >= start) && (!end || time < end);
}

function dayBefore(day: Day): Day {
  return WEEK[(WEEK.indexOf(day) + 6) % 7];
}

/**
 * Whether a tariff element's conditions on the session as a whole hold for a
 * session arriving at `arrivalLocal`: weekday, daily window, validity dates,
 * power, and current (only when the connector states its amperage). The
 * after-midnight part of a window that crosses midnight belongs to the day
 * it started. Energy and duration bounds say where within a session an
 * element applies, not whether it does (see `shareSpan`). Reservation
 * elements never apply to a charging stop.
 */
export function tariffMatches(
  _tariff: EnergyTariff,
  element: TariffElement,
  session: SessionFacts & { connector: ChargingConnector },
): boolean {
  const r = element.restrictions;
  if (!r) return true;
  if (r.reservation) return false;
  const at = session.arrivalLocal;
  const afterMidnight =
    r.startTime !== undefined &&
    r.endTime !== undefined &&
    r.startTime > r.endTime &&
    at.time < r.endTime;
  const day = afterMidnight ? dayBefore(at.day) : at.day;
  if (r.days?.length && !r.days.includes(day)) return false;
  if (!withinWindow(at.time, r.startTime, r.endTime)) return false;
  if (r.startDate && at.date < r.startDate) return false;
  if (r.endDate && at.date >= r.endDate) return false;
  return eligibleFor(element, session);
}

/**
 * Whether an element can apply to a session at all, whenever it runs: not a
 * reservation, and within its power and current (the current only when the
 * connector states its amperage).
 */
function eligibleFor(
  element: TariffElement,
  session: SessionFacts & { connector: ChargingConnector },
): boolean {
  const r = element.restrictions;
  if (!r) return true;
  if (r.reservation || !within(session.powerKw, r.minPowerKw, r.maxPowerKw)) return false;
  const amps = session.connector.maxAmperage;
  return amps === undefined || within(amps, r.minCurrentA, r.maxCurrentA);
}

/**
 * The part of a session an element's energy and duration bounds cover, as
 * shares of the session from 0 at plug-in to 1 at the end: OCPI's min/max kWh
 * and duration say from and until when within a session an element applies.
 * The plan knows only the session's totals, so it assumes energy is
 * delivered evenly over the charge time; that puts a kWh bound and a
 * duration bound on one axis.
 */
function shareSpan(
  r: EnergyTariffRestrictions | undefined,
  session: SessionFacts,
): [number, number] {
  const share = (value: number, total: number) =>
    total > 0 ? value / total : value > 0 ? Number.POSITIVE_INFINITY : 0;
  const from = Math.max(
    r?.minKwh !== undefined ? share(r.minKwh, session.addedKwh) : 0,
    r?.minDurationSec !== undefined ? share(r.minDurationSec, session.chargeSeconds) : 0,
  );
  const until = Math.min(
    r?.maxKwh !== undefined ? share(r.maxKwh, session.addedKwh) : 1,
    r?.maxDurationSec !== undefined ? share(r.maxDurationSec, session.chargeSeconds) : 1,
    1,
  );
  return [from, until];
}

/** A billed quantity, rounded up to whole steps; the epsilon keeps float noise from adding a step. */
function billed(quantity: number, stepSize: number | undefined): number {
  if (!stepSize || stepSize <= 0) return quantity;
  return Math.ceil(quantity / stepSize - 1e-9) * stepSize;
}

/**
 * How much of a component a share of the session pays for: kWh for energy
 * (steps in Wh), hours of charge time (steps in seconds), one for a flat or
 * session fee.
 */
function quantityOf(component: Component, share: number, session: SessionFacts): number {
  switch (component.type) {
    case "energy":
      return billed(share * session.addedKwh * 1000, component.stepSize) / 1000;
    case "time":
      return billed(share * session.chargeSeconds, component.stepSize) / 3600;
    default:
      return 1;
  }
}

const MINUTES_PER_DAY = 24 * 60;

/** Minutes past midnight of a `HH:MM` time. */
function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** The station's wall clock `seconds` after `start`, taking the clock not to change in between. */
function localAfter(start: LocalArrival, seconds: number): LocalArrival {
  const total = minutesOf(start.time) + Math.floor(seconds / 60);
  const days = Math.floor(total / MINUTES_PER_DAY);
  const minute = total - days * MINUTES_PER_DAY;
  const [y, m, d] = start.date.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");
  return {
    date: date.toISOString().slice(0, 10),
    time: `${hh}:${mm}`,
    day: WEEK[date.getUTCDay()],
  };
}

/**
 * The shares of a session at which the station's clock passes midnight or
 * the edge of an element's daily window: where an element starts or stops
 * applying while the vehicle charges.
 */
function clockCuts(elements: readonly TariffElement[], session: SessionFacts): number[] {
  const span = session.chargeSeconds / 60;
  if (!(span > 0)) return [];
  const edges = new Set([0]);
  for (const { restrictions: r } of elements) {
    if (r?.startTime) edges.add(minutesOf(r.startTime));
    if (r?.endTime) edges.add(minutesOf(r.endTime));
  }
  const start = minutesOf(session.arrivalLocal.time);
  const cuts: number[] = [];
  for (const edge of edges) {
    const first = (((edge - start) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    for (let at = first; at < span; at += MINUTES_PER_DAY) if (at > 0) cuts.push(at / span);
  }
  return cuts;
}

/**
 * One tariff's price for a session. For each component type, every stretch
 * of the session is priced by the first element that applies at that time
 * of the session, covers it and has that type, so tiers ("the first 20 kWh
 * at …, then …") add up and a session running into a night rate pays it
 * from the window's edge on; a flat or session fee is paid once, from the
 * first element applying at arrival that has one. A tariff whose base price
 * (energy, else time for a time-only tariff) covers only part of the session
 * prices none of it (null); other types are paid where their elements apply.
 * The total is held within the tariff's min and max price.
 */
function costOn(
  tariff: EnergyTariff,
  session: SessionFacts & { connector: ChargingConnector },
): SessionCost | null {
  const gross = (c: Component) => (tariff.priceIncludesVat ? 1 : 1 + (c.vatPct ?? 0) / 100);
  const elements = tariff.elements
    .map((element) => ({ element, span: shareSpan(element.restrictions, session) }))
    .filter(({ span: [from, until] }) => from < until);
  const appliesAt = (element: TariffElement, share: number) =>
    tariffMatches(tariff, element, {
      ...session,
      arrivalLocal: localAfter(session.arrivalLocal, share * session.chargeSeconds),
    });
  const cuts = [
    ...new Set([
      0,
      1,
      ...elements.flatMap((e) => e.span),
      ...clockCuts(
        elements.map((e) => e.element),
        session,
      ),
    ]),
  ]
    .filter((cut) => cut >= 0 && cut <= 1)
    .sort((a, b) => a - b);

  // The type that makes up the base price: energy where an element this
  // session's power and current can use prices energy, else time; a flat or
  // session fee needs no coverage. When and how much do not decide it.
  const priced = (type: Component["type"]) =>
    tariff.elements.some(
      (e) => eligibleFor(e, session) && e.components.some((c) => c.type === type),
    );
  const base = priced("energy") ? "energy" : priced("time") ? "time" : undefined;

  const charged: { component: Component; amount: number }[] = [];
  for (const type of COSTED) {
    if (type === "flat" || type === "session") {
      const component = elements
        .filter(({ element }) => appliesAt(element, 0))
        .flatMap(({ element }) => element.components)
        .find((c) => c.type === type);
      if (component) charged.push({ component, amount: component.price * gross(component) });
      continue;
    }
    const shares = new Map<Component, number>();
    let uncovered = false;
    for (let i = 1; i < cuts.length; i++) {
      const middle = (cuts[i - 1] + cuts[i]) / 2;
      const component = elements
        .filter(
          ({ element, span: [from, until] }) =>
            middle >= from && middle < until && appliesAt(element, middle),
        )
        .flatMap(({ element }) => element.components)
        .find((c) => c.type === type);
      if (component) shares.set(component, (shares.get(component) ?? 0) + cuts[i] - cuts[i - 1]);
      else uncovered = true;
    }
    // A tariff whose base price covers only part of the session (a night
    // rate the charge runs into, a validity ending at midnight) says nothing
    // about the rest of it, so it cannot price the session. Other types are
    // paid only where their elements apply.
    if (uncovered && type === base) return null;
    for (const [component, share] of shares) {
      const amount = component.price * quantityOf(component, share, session) * gross(component);
      charged.push({ component, amount });
    }
  }
  if (charged.length === 0) return null;

  // Price bounds are quoted without VAT unless the tariff says otherwise; the
  // VAT that grosses them up is that of the component the session pays most for.
  const largest = charged.reduce((a, b) => (b.amount > a.amount ? b : a)).component;
  const bound = (price: number) => price * gross(largest);
  let amount = charged.reduce((sum, c) => sum + c.amount, 0);
  if (tariff.minPrice !== undefined) amount = Math.max(amount, bound(tariff.minPrice));
  if (tariff.maxPrice !== undefined) amount = Math.min(amount, bound(tariff.maxPrice));

  const main = charged[0].component;
  return {
    amount,
    currency: tariff.currency,
    tariffId: tariff.id,
    price: {
      // Up to four decimals, as prices are shown; VAT grossing adds float noise.
      amount: Math.round(main.price * gross(main) * 10_000) / 10_000,
      currency: tariff.currency,
      unit: UNIT[main.type] ?? "session",
    },
  };
}

/** The tariff type anyone can pay without a contract. */
const AD_HOC = "ad_hoc";

/**
 * Modelled cost of a planned session, on the cheapest tariff that prices it.
 * The candidates are the tariffs the chosen connector names, else the
 * site-wide ones no connector names. VAT is added unless the tariff's prices
 * include it. When an ad-hoc tariff prices the session, tariffs of another
 * known type (profile, regular, member, roaming) are left out, and an ad-hoc
 * tariff wins a tie. Null when no tariff prices the session — callers treat
 * that as "price unknown" (neutral), never as free.
 */
export function estimateSessionCost(
  site: ChargingSite,
  pick: EvsePick,
  session: SessionFacts,
): SessionCost | null {
  const named = site.tariffs.filter((t) => pick.connector.tariffIds.includes(t.id));
  const referenced = new Set(site.evses.flatMap((e) => e.connectors.flatMap((c) => c.tariffIds)));
  const candidates = named.length ? named : site.tariffs.filter((t) => !referenced.has(t.id));
  const costed = candidates.flatMap((tariff) => {
    const cost = costOn(tariff, { ...session, connector: pick.connector });
    return cost ? [{ adHoc: tariff.type === AD_HOC, typed: tariff.type !== undefined, cost }] : [];
  });
  const eligible = costed.some((c) => c.adHoc) ? costed.filter((c) => c.adHoc || !c.typed) : costed;
  eligible.sort((a, b) => a.cost.amount - b.cost.amount || Number(b.adHoc) - Number(a.adHoc));
  return eligible[0]?.cost ?? null;
}

/**
 * Ranking penalty (seconds) for a site's CURRENT live occupancy, gated by how
 * soon after now we'd arrive. Soft nudge only — never a hard filter, so a busy
 * charger that is the only reachable option is still chosen. Zero when no
 * charge point has a fresh status or the arrival is beyond the horizon
 * (occupancy that far out says nothing about the state on arrival). We do NOT
 * predict future occupancy — only weigh the present state for imminent stops.
 */
function availabilityPenaltySec(site: ChargingSite, secondsFromNow: number): number {
  if (secondsFromNow > AVAILABILITY_HORIZON_SEC) return 0;
  const a = availabilityOf(site);
  if (!a || a.total <= 0) return 0;
  const occupancy = 1 - Math.max(0, Math.min(1, a.available / a.total)); // 0 all-free … 1 full
  const proximity = 1 - Math.max(0, secondsFromNow) / AVAILABILITY_HORIZON_SEC; // 1 now … 0 at horizon
  return OCCUPANCY_PENALTY_SEC * occupancy * proximity;
}

/** Metres between two lng/lat points (haversine). */
function haversineM(a: LngLat, b: LngLat): number {
  const R = 6_371_000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180,
    dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180,
    la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Distance (metres) from route start to each sample on the SAME axis as
 * `cumulativeKwh`. With elevation the axis is fixed 30 m samples; without it the
 * axis is geometry vertices, so distances are the running haversine sum. This is
 * what makes divert-point coordinates land in the right place (review S4).
 */
function buildSampleDistances(route: Route, sampleCount: number): number[] {
  if (route.elevation && route.elevationInterval && route.elevation.length === sampleCount) {
    return route.elevation.map((_, i) => i * (route.elevationInterval as number));
  }
  const dist: number[] = [0];
  for (let i = 1; i < route.geometry.length; i++)
    dist.push(dist[i - 1] + haversineM(route.geometry[i - 1], route.geometry[i]));
  return dist;
}

/** Coordinate at `targetM` metres along the geometry (walk + linear interp). */
function coordAtDistanceM(geometry: LngLat[], targetM: number): LngLat {
  let acc = 0;
  for (let i = 1; i < geometry.length; i++) {
    const seg = haversineM(geometry[i - 1], geometry[i]);
    if (acc + seg >= targetM) {
      const t = seg === 0 ? 0 : (targetM - acc) / seg;
      return [
        geometry[i - 1][0] + t * (geometry[i][0] - geometry[i - 1][0]),
        geometry[i - 1][1] + t * (geometry[i][1] - geometry[i - 1][1]),
      ];
    }
    acc += seg;
  }
  return geometry[geometry.length - 1];
}

/** Last sample index reachable from `startIdx` while keeping `>= floorKwh`. */
function reachOffset(
  cumulativeKwh: number[],
  startIdx: number,
  socKwh: number,
  floorKwh: number,
): number {
  const budget = socKwh - floorKwh;
  let last = 0;
  for (let i = startIdx + 1; i < cumulativeKwh.length; i++) {
    if (cumulativeKwh[i] - cumulativeKwh[startIdx] <= budget) last = i - startIdx;
    else break;
  }
  return last;
}

export async function planCharges(input: PlanInput, cb: PlanCallbacks): Promise<ChargePlan> {
  const { route, vehicle } = input;
  const stops: PlannedStop[] = [];
  const warnings: PlanWarning[] = [];
  let soc = input.socStartKwh;
  const detourReserve = vehicle.batteryKwh * DETOUR_RESERVE_KWH_FRAC;
  // Seconds from now until the trip starts: zero when leaving now, positive for a later departure.
  const startsInSec = (input.tripStartMs - input.nowMs) / 1000;

  const { cumulativeKwh } = routeEnergyKwh(route, vehicle, {
    ambientTempC: input.ambientTempC,
    elevationAbsentDerate: input.hasElevation ? 1 : 1.1,
  });
  const destKwh = cumulativeKwh[cumulativeKwh.length - 1];
  const sampleCount = cumulativeKwh.length;
  const sampleDistM = buildSampleDistances(route, sampleCount);
  const onwardTarget = route.geometry[route.geometry.length - 1];
  const windowKm = Math.min(
    MAX_WINDOW_KM,
    Math.max(15, (vehicle.batteryKwh / vehicle.baseWhPerKm) * 1000 * 0.15),
  );
  const totalDistM = sampleDistM[sampleDistM.length - 1] || 1;

  let startIdx = 0;
  let elapsedSec = 0; // wall-clock into the trip (drive so far + prior charge times)
  for (let iter = 0; iter < MAX_STOPS; iter++) {
    // reachable (REACH_EPS_KWH absorbs float error when a prior charge was exactly enough)
    if (soc - (destKwh - cumulativeKwh[startIdx]) >= input.socArrivalMinKwh - REACH_EPS_KWH) break;

    const divertIdx =
      startIdx + reachOffset(cumulativeKwh, startIdx, soc, input.socArrivalMinKwh + detourReserve);
    // Stall guard (review S3): if we cannot advance past the current point, stop.
    if (divertIdx <= startIdx) {
      warnings.push({ kind: "unreachable", afterStopIndex: stops.length - 1 });
      break;
    }
    const divertPoint = coordAtDistanceM(route.geometry, sampleDistM[divertIdx]);
    const socAtDivert = soc - (cumulativeKwh[divertIdx] - cumulativeKwh[startIdx]);
    // Approx drive time from the current start to the divert point (proportional
    // to distance along the route). Used to time the arrival at each candidate.
    const driveToDivertSec =
      route.duration * ((sampleDistM[divertIdx] - sampleDistM[startIdx]) / totalDistM);
    const etaBaseSec = elapsedSec + driveToDivertSec;
    const arrivalAt = (site: ChargingSite, toSeconds: number) =>
      localArrival(site, input.tripStartMs + (etaBaseSec + toSeconds) * 1000);

    let candidates: ChargingSite[];
    try {
      candidates = await cb.requestCorridorChargers(divertPoint, windowKm);
    } catch (err) {
      if (!(err instanceof ChargerSourcesUnavailableError)) throw err;
      warnings.push({ kind: "charger-sources-unavailable" });
      warnings.push({ kind: "unreachable", afterStopIndex: stops.length - 1 });
      break;
    }
    if (candidates.length === 0) {
      warnings.push({ kind: "no-charger-data" });
      warnings.push({ kind: "unreachable", afterStopIndex: stops.length - 1 });
      break;
    }

    const connCompatible = candidates
      .map((s) => ({ s, pick: pickEvse(s, vehicle) }))
      .filter((x): x is { s: ChargingSite; pick: EvsePick } => x.pick !== null);
    if (connCompatible.length === 0) {
      warnings.push({ kind: "unreachable", afterStopIndex: stops.length - 1 });
      break;
    }
    // Exclusive mode: hard whitelist by operator. The soft network bias still applies
    // among survivors. Empty whitelist ⇒ no filter. If it removes everything, this
    // is a distinct, user-actionable warning (not a generic "unreachable").
    const allowed = input.exclusiveNetworkKeys;
    const compatible = allowed?.size
      ? connCompatible.filter((c) =>
          matchesAnyOperator(normalizeOperator(c.s.operator?.name), allowed),
        )
      : connCompatible;
    if (compatible.length === 0) {
      warnings.push({ kind: "no-allowed-network", afterStopIndex: stops.length - 1 });
      break;
    }

    const sources: LngLat[] = [divertPoint, ...compatible.map((c) => c.s.coordinates)];
    const targets: LngLat[] = [...compatible.map((c) => c.s.coordinates), onwardTarget];
    let matrix: (MatrixCell | null)[][];
    try {
      matrix = await cb.requestMatrix(sources, targets);
    } catch {
      warnings.push({ kind: "unreachable", afterStopIndex: stops.length - 1 });
      break;
    }

    // Two-pass ranking. Pass 1 evaluates each reachable candidate (incl. an
    // estimated session cost). Pass 2 adds the soft factors — the price
    // penalty is relative to the cheapest COMPARABLE candidate, so it needs the
    // whole set from pass 1 first.
    const costWeight = input.costWeight ?? 1;
    interface Scored {
      i: number;
      toSeconds: number;
      detourSec: number;
      reachKwh: number;
      approxCharge: number;
      cost: SessionCost | null;
    }
    const scored: Scored[] = [];
    for (let i = 0; i < compatible.length; i++) {
      const toCand = matrix[0]?.[i]; // divertPoint -> candidate i
      const fromCand = matrix[i + 1]?.[compatible.length]; // candidate i -> onwardTarget
      if (!toCand || !fromCand) continue;
      const divertEnergy = (toCand.km * vehicle.baseWhPerKm * DETOUR_UPLIFT) / 1000;
      const reachKwh = socAtDivert - divertEnergy;
      if (reachKwh < 0) continue; // can't reach this charger
      const { s, pick } = compatible[i];
      const caps = powerCaps(pick, vehicle);
      const toSoc = Math.min(input.socTargetKwh, vehicle.batteryKwh);
      const approxCharge = chargeSecondsFor({
        fromSocKwh: Math.max(0, reachKwh),
        toSocKwh: toSoc,
        batteryKwh: vehicle.batteryKwh,
        ...caps,
        taperSocPct: vehicle.vehicleTaperSocPct,
      });
      const cost =
        costWeight > 0
          ? estimateSessionCost(s, pick, {
              powerKw: Math.min(caps.chargerPowerKw, caps.vehicleMaxKw),
              arrivalLocal: arrivalAt(s, toCand.seconds),
              addedKwh: Math.max(0, toSoc - Math.max(0, reachKwh)),
              chargeSeconds: approxCharge,
            })
          : null;
      scored.push({
        i,
        toSeconds: toCand.seconds,
        detourSec: toCand.seconds + fromCand.seconds,
        reachKwh,
        approxCharge,
        cost,
      });
    }
    if (scored.length === 0) {
      warnings.push({ kind: "unreachable", afterStopIndex: stops.length - 1 });
      break;
    }
    // Cheapest comparable session cost per currency, for the relative price nudge.
    const minCostByCcy = new Map<string, number>();
    for (const s of scored) {
      if (!s.cost) continue;
      const cur = minCostByCcy.get(s.cost.currency);
      if (cur === undefined || s.cost.amount < cur)
        minCostByCcy.set(s.cost.currency, s.cost.amount);
    }
    let best: { idx: number; score: number; reachKwh: number; toSeconds: number } | null = null;
    for (const s of scored) {
      const cand = compatible[s.i];
      const availPenalty = availabilityPenaltySec(cand.s, startsInSec + etaBaseSec + s.toSeconds);
      const opKey = normalizeOperator(cand.s.operator?.name);
      const networkBias = matchesAnyOperator(opKey, input.preferredNetworkKeys)
        ? -NETWORK_PREFERENCE_BONUS_SEC
        : matchesAnyOperator(opKey, input.avoidedNetworkKeys)
          ? NETWORK_AVOID_PENALTY_SEC
          : 0;
      let costPenalty = 0;
      if (s.cost && costWeight > 0) {
        const minCost = minCostByCcy.get(s.cost.currency); // same-currency cheapest
        if (minCost !== undefined) {
          const secPerUnit = (3600 / VALUE_OF_TIME_PER_HOUR) * costWeight;
          costPenalty = Math.min((s.cost.amount - minCost) * secPerUnit, MAX_COST_PENALTY_SEC);
        }
      }
      const score = s.detourSec + s.approxCharge + availPenalty + networkBias + costPenalty;
      if (!best || score < best.score)
        best = { idx: s.i, score, reachKwh: s.reachKwh, toSeconds: s.toSeconds };
    }

    if (!best) {
      // every scored candidate is reachable, but keep the type honest + safe
      warnings.push({ kind: "unreachable", afterStopIndex: stops.length - 1 });
      break;
    }

    const chosen = compatible[best.idx];
    const caps = powerCaps(chosen.pick, vehicle);
    const arriveKwh = Math.max(0, best.reachKwh);
    const taperKwh = (vehicle.vehicleTaperSocPct / 100) * vehicle.batteryKwh;
    const needForRest = destKwh - cumulativeKwh[divertIdx] + input.socArrivalMinKwh; // pack level to finish
    const userCapKwh = Math.min(input.socTargetKwh, vehicle.batteryKwh);
    // Charge target: if the remaining trip fits on one charge this is the
    // FINAL leg — charge enough to finish, ABOVE taper if required (the final-leg
    // bridge), honouring the user's target as a lower buffer. Otherwise charge to
    // taper for speed (bounded by the user's target) and a later stop covers the
    // rest. (General above-taper bridging to reach an INTERMEDIATE charger is Phase
    // 2; here taper-insufficiency falls through to the stall guard as unreachable.)
    let departKwh =
      needForRest <= vehicle.batteryKwh
        ? Math.min(vehicle.batteryKwh, Math.max(needForRest, userCapKwh))
        : Math.min(taperKwh, userCapKwh);
    departKwh = Math.min(vehicle.batteryKwh, Math.max(arriveKwh + detourReserve, departKwh));
    const chargeSeconds = chargeSecondsFor({
      fromSocKwh: arriveKwh,
      toSocKwh: departKwh,
      batteryKwh: vehicle.batteryKwh,
      ...caps,
      taperSocPct: vehicle.vehicleTaperSocPct,
    });
    const addedKwh = departKwh - arriveKwh;
    // Cost for display is computed from the FINAL session (regardless of costWeight,
    // so the card shows a price even when price ranking is off).
    const estimatedCost =
      estimateSessionCost(chosen.s, chosen.pick, {
        powerKw: Math.min(caps.chargerPowerKw, caps.vehicleMaxKw),
        arrivalLocal: arrivalAt(chosen.s, best.toSeconds),
        addedKwh,
        chargeSeconds,
      }) ?? undefined;
    stops.push({
      site: chosen.s,
      evse: chosen.pick.evse,
      connector: chosen.pick.standard,
      powerKw: chosen.pick.powerKw,
      coordinates: chosen.s.coordinates,
      arriveSocKwh: arriveKwh,
      departSocKwh: departKwh,
      chargeSeconds,
      addedKwh,
      estimatedCost,
    });
    soc = departKwh;
    startIdx = divertIdx;
    elapsedSec = etaBaseSec + best.toSeconds + chargeSeconds; // arrival at charger + time spent charging
  }

  if (
    stops.length >= MAX_STOPS &&
    soc - (destKwh - cumulativeKwh[startIdx]) < input.socArrivalMinKwh
  ) {
    warnings.push({ kind: "unreachable", afterStopIndex: stops.length - 1 });
  }

  return {
    stops,
    warnings,
    totalChargeSeconds: stops.reduce((a, s) => a + s.chargeSeconds, 0),
    totalEnergyKwh: destKwh,
  };
}
