import type { ConnectorStandard, CurrentStandard, LngLat, Route } from "@openmapx/core";
import { matchesAnyOperator, normalizeConnector, normalizeOperator } from "@openmapx/core";
import type { EvChargingStation, EvChargingTariff } from "@openmapx/mobility-core/ev-charging";
import { chargeSecondsFor } from "./charging";
import { routeEnergyKwh } from "./consumption";
import type {
  ChargePlan,
  MatrixCell,
  PlanCallbacks,
  PlanInput,
  PlannedStop,
  PlanWarning,
} from "./types";

const MAX_STOPS = 12;
const DETOUR_UPLIFT = 1.15; // off-route energy penalty (matrix gives no elevation)
const DETOUR_RESERVE_KWH_FRAC = 0.05; // keep this much battery spare to divert
const REACH_EPS_KWH = 0.05; // float slack so an "exactly enough" charge ends the loop
const MAX_WINDOW_KM = 30; // keeps the search bbox under the 0.6 deg² budget (D1/C4)
const AVAILABILITY_HORIZON_SEC = 45 * 60; // beyond this ETA, current occupancy says nothing about arrival
const AVAILABILITY_STALE_SEC = 20 * 60; // ignore live snapshots older than this
const OCCUPANCY_PENALTY_SEC = 12 * 60; // max ranking penalty for a full, imminent charger
const NETWORK_PREFERENCE_BONUS_SEC = 10 * 60; // D9 — "worth ~10 min detour to use my network"
const NETWORK_AVOID_PENALTY_SEC = 10 * 60; // D9 — symmetric de-prioritisation
const VALUE_OF_TIME_PER_HOUR = 20; // D10 — currency units/hour (money↔time conversion)
const MAX_COST_PENALTY_SEC = 6 * 60; // D10 — cap: price is a tiebreaker, below D8/D9 caps
const SCOPE_RANK: Record<string, number> = { evse: 3, cpo: 2, country: 1 };

interface CompatibleConn {
  standard: ConnectorStandard;
  current: CurrentStandard;
  powerKw: number;
}

/** Best compatible connector on a station for the vehicle (highest power first). */
function pickConnector(
  station: EvChargingStation,
  accepted: Set<ConnectorStandard>,
): CompatibleConn | null {
  let best: CompatibleConn | null = null;
  for (const c of station.connectors) {
    const norm = normalizeConnector(c.type, c.currentType);
    if (!norm || !accepted.has(norm.standard)) continue;
    const powerKw = c.powerKw ?? 0;
    if (powerKw <= 0) continue; // unknown/zero usable power — not a valid charge stop
    if (!best || powerKw > best.powerKw)
      best = { standard: norm.standard, current: norm.current, powerKw };
  }
  return best;
}

/** Effective charge power + which onboard limit applies, from the normalized current. */
function powerCaps(conn: CompatibleConn, vehicle: PlanInput["vehicle"]) {
  const vehicleMaxKw = conn.current === "dc" ? vehicle.maxDcKw : vehicle.maxAcKw;
  return { chargerPowerKw: conn.powerKw, vehicleMaxKw };
}

/**
 * Ranking penalty (seconds) for a charger's CURRENT live occupancy, gated by how
 * soon we'd arrive. Soft nudge only — never a hard filter, so a busy charger that
 * is the only reachable option is still chosen. Zero when: no/zero-total live
 * data, the snapshot is stale, or the ETA is beyond the horizon (occupancy that
 * far out says nothing about the state on arrival). We do NOT predict future
 * occupancy — only weigh the present state for imminent stops.
 */
function availabilityPenaltySec(
  station: EvChargingStation,
  etaToChargerSec: number,
  nowMs: number,
): number {
  const a = station.availability;
  if (!a || a.total <= 0) return 0;
  if (etaToChargerSec > AVAILABILITY_HORIZON_SEC) return 0;
  const ageMs = nowMs - Date.parse(a.updatedAt);
  if (!Number.isFinite(ageMs) || ageMs > AVAILABILITY_STALE_SEC * 1000) return 0;
  const occupancy = 1 - Math.max(0, Math.min(1, a.available / a.total)); // 0 all-free … 1 full
  const proximity = 1 - etaToChargerSec / AVAILABILITY_HORIZON_SEC; // 1 now … 0 at horizon
  return OCCUPANCY_PENALTY_SEC * occupancy * proximity;
}

/** Does a tariff apply to this connector's power + current? (time-of-day is Phase 2.) */
function tariffApplies(t: EvChargingTariff, powerKw: number, current: CurrentStandard): boolean {
  const r = t.restrictions;
  if (!r) return true;
  if (r.currentType && r.currentType !== current) return false;
  if (r.minPowerKw != null && powerKw < r.minPowerKw) return false;
  if (r.maxPowerKw != null && powerKw > r.maxPowerKw) return false;
  return true;
}

/**
 * Modelled cost of the PLANNED session (D10): energy + time + flat components of
 * the applicable tariff, each grossed up by its VAT. Returns null when there is
 * no structured, applicable tariff or the cost resolves to ≤ 0 (e.g. only
 * parking/time-of-day components, which Phase 1 ignores) — callers treat null as
 * "price unknown" (neutral), never as free.
 */
export function estimateSessionCost(
  station: EvChargingStation,
  connector: { powerKw: number; current: CurrentStandard },
  addedKwh: number,
  chargeMinutes: number,
): { amount: number; currency: string } | null {
  const tariffs = station.tariffs;
  if (!tariffs?.length) return null;
  const applicable = tariffs
    .filter((t) => tariffApplies(t, connector.powerKw, connector.current))
    .sort((a, b) => (SCOPE_RANK[b.scope] ?? 0) - (SCOPE_RANK[a.scope] ?? 0));
  const t = applicable[0];
  if (!t) return null;
  let amount = 0;
  let currency = "";
  for (const e of t.elements) {
    currency = currency || e.currency;
    const vatMul = 1 + (e.vat ?? 0) / 100;
    if (e.type === "energy") amount += e.price * addedKwh * vatMul;
    else if (e.type === "time") amount += e.price * chargeMinutes * vatMul;
    else if (e.type === "flat") amount += e.price * vatMul;
    // "parking" and time-of-day windows are Phase 2.
  }
  if (!currency || amount <= 0) return null;
  return { amount, currency };
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
  const accepted = new Set<ConnectorStandard>(vehicle.connectors);
  const stops: PlannedStop[] = [];
  const warnings: PlanWarning[] = [];
  let soc = input.socStartKwh;
  const detourReserve = vehicle.batteryKwh * DETOUR_RESERVE_KWH_FRAC;

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
    // to distance along the route). Used only to ETA-gate live availability.
    const driveToDivertSec =
      route.duration * ((sampleDistM[divertIdx] - sampleDistM[startIdx]) / totalDistM);
    const etaBaseSec = elapsedSec + driveToDivertSec;

    const candidates = await cb.requestCorridorChargers(divertPoint, windowKm);
    if (candidates.length === 0) {
      warnings.push({ kind: "no-charger-data" });
      warnings.push({ kind: "unreachable", afterStopIndex: stops.length - 1 });
      break;
    }

    const connCompatible = candidates
      .map((s) => ({ s, conn: pickConnector(s, accepted) }))
      .filter((x): x is { s: EvChargingStation; conn: CompatibleConn } => x.conn !== null);
    if (connCompatible.length === 0) {
      warnings.push({ kind: "unreachable", afterStopIndex: stops.length - 1 });
      break;
    }
    // D9 exclusive mode: hard whitelist by operator. Soft bias (D9) still applies
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
    // estimated session cost). Pass 2 adds the soft factors — the D10 price
    // penalty is relative to the cheapest COMPARABLE candidate, so it needs the
    // whole set from pass 1 first.
    const costWeight = input.costWeight ?? 1;
    interface Scored {
      i: number;
      toSeconds: number;
      detourSec: number;
      reachKwh: number;
      approxCharge: number;
      cost: { amount: number; currency: string } | null;
    }
    const scored: Scored[] = [];
    for (let i = 0; i < compatible.length; i++) {
      const toCand = matrix[0]?.[i]; // divertPoint -> candidate i
      const fromCand = matrix[i + 1]?.[compatible.length]; // candidate i -> onwardTarget
      if (!toCand || !fromCand) continue;
      const divertEnergy = (toCand.km * vehicle.baseWhPerKm * DETOUR_UPLIFT) / 1000;
      const reachKwh = socAtDivert - divertEnergy;
      if (reachKwh < 0) continue; // can't reach this charger
      const conn = compatible[i].conn;
      const caps = powerCaps(conn, vehicle);
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
          ? estimateSessionCost(
              compatible[i].s,
              { powerKw: conn.powerKw, current: conn.current },
              Math.max(0, toSoc - Math.max(0, reachKwh)),
              approxCharge / 60,
            )
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
      const availPenalty = availabilityPenaltySec(cand.s, etaBaseSec + s.toSeconds, input.nowMs);
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
    const caps = powerCaps(chosen.conn, vehicle);
    const arriveKwh = Math.max(0, best.reachKwh);
    const taperKwh = (vehicle.vehicleTaperSocPct / 100) * vehicle.batteryKwh;
    const needForRest = destKwh - cumulativeKwh[divertIdx] + input.socArrivalMinKwh; // pack level to finish
    const userCapKwh = Math.min(input.socTargetKwh, vehicle.batteryKwh);
    // Charge target (spec D5.7): if the remaining trip fits on one charge this is the
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
      estimateSessionCost(
        chosen.s,
        { powerKw: chosen.conn.powerKw, current: chosen.conn.current },
        addedKwh,
        chargeSeconds / 60,
      ) ?? undefined;
    stops.push({
      station: chosen.s,
      connector: chosen.conn.standard,
      powerKw: chosen.conn.powerKw,
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
