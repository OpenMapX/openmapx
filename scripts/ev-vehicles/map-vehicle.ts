/**
 * Pure mapping from an open-ev-data record to the seven `EvVehicleSpec` fields
 * the charge planner needs, plus a human display label. No network, no
 * filesystem — `generate.ts` owns the download and the file write so this half
 * stays unit-testable.
 *
 * Dataset: open-ev-data/open-ev-data-dataset, CDLA-Permissive-2.0.
 */

export interface RawRatedRange {
  cycle?: string;
  range_km?: number;
  notes?: string;
}

export interface RawVehicle {
  unique_code?: string;
  make?: { name?: string };
  model?: { name?: string };
  trim?: { name?: string };
  variant?: { name?: string };
  year?: number;
  vehicle_type?: string;
  battery?: { pack_capacity_kwh_net?: number };
  charging?: { ac?: { max_power_kw?: number }; dc?: { max_power_kw?: number } };
  range?: { rated?: RawRatedRange[] };
  weights?: { curb_weight_kg?: number };
  charge_ports?: Array<{ connector?: string }>;
  markets?: Array<string | { country?: string; code?: string; country_code?: string }>;
}

export interface GeneratedVehicle {
  id: string;
  label: string;
  batteryKwh: number;
  baseWhPerKm: number;
  massTonnes: number;
  maxDcKw: number;
  maxAcKw: number;
  vehicleTaperSocPct: number;
  connectors: string[];
}

export type DropReason = "no-battery" | "no-dc" | "no-range" | "no-connectors" | "hybrid";

/**
 * The dataset carries no consumption figure, only rated ranges, so Wh/km has to
 * come from battery / range. Rated cycles differ wildly in optimism: EPA is
 * already close to real-world, WLTP is optimistic, CLTC and NEDC more so. These
 * factors bring each cycle back towards a realistic figure. The result is an
 * estimate — the planner's arrival reserve and tight-margin warning absorb the
 * residual error.
 */
const CYCLE_FACTOR: Record<string, number> = {
  wltp: 0.82,
  epa: 1.0,
  cltc: 0.72,
  nedc: 0.78,
  jc08: 0.78,
};

const DEFAULT_CYCLE_FACTOR = 0.85;

/** Cycles in descending order of trust; anything else falls back to the first usable entry. */
const CYCLE_PREFERENCE = ["wltp", "epa", "cltc", "nedc"];

/** Curb weight is missing for ~200 records; mass only feeds the gravity term, so a body-type guess is enough. */
const MASS_BY_VEHICLE_TYPE: Record<string, number> = {
  passenger_car: 1.9,
  suv: 2.2,
  van: 2.6,
  pickup: 2.9,
};

const FALLBACK_MASS_TONNES = 2.1;

/** The dataset has no charge-curve data, so every vehicle tapers at the same nominal SoC. */
const DEFAULT_TAPER_SOC_PCT = 80;

const CONNECTOR_MAP: Record<string, string[]> = {
  ccs2: ["ccs2"],
  ccs1: ["ccs1"],
  type2: ["type2"],
  type1: ["type1"],
  chademo: ["chademo"],
  gb_t_dc: ["gbt_dc"],
  gb_t_ac: ["gbt_ac"],
};

/** Markets where a NACS-badged car in this dataset physically charges on CCS2. */
const EUROPEAN_MARKETS = new Set([
  "DE",
  "FR",
  "GB",
  "NL",
  "BE",
  "AT",
  "CH",
  "IT",
  "ES",
  "PL",
  "SE",
  "NO",
  "DK",
  "FI",
  "IE",
  "PT",
  "CZ",
]);

/** PHEVs and range-extender EREVs: their rated range is not a battery range, so derived Wh/km is nonsense. */
const HYBRID_NOTE_PATTERN = /range extender|electric[- ]only|extended.range.+extender/i;

function marketCode(
  entry: string | { country?: string; code?: string; country_code?: string },
): string {
  if (typeof entry === "string") return entry.toUpperCase();
  const code = entry.country_code ?? entry.code ?? entry.country;
  return typeof code === "string" ? code.toUpperCase() : "";
}

function isEuropean(raw: RawVehicle): boolean {
  return (raw.markets ?? []).some((entry) => EUROPEAN_MARKETS.has(marketCode(entry)));
}

/**
 * Vehicle-side connector list. `nacs` fans out to `tesla_ccs` plus the local CCS
 * flavour because charger data collapses every NACS/Tesla plug to the literal
 * "Tesla" (which normalises to `tesla_ccs`) — a NACS-only car would otherwise
 * match zero stations. European Teslas are listed as NACS here but physically
 * charge on CCS2.
 */
export function mapConnectors(raw: RawVehicle): string[] {
  const european = isEuropean(raw);
  const out: string[] = [];
  for (const port of raw.charge_ports ?? []) {
    const connector = port?.connector;
    if (!connector) continue;
    if (connector === "nacs") {
      out.push("nacs", "tesla_ccs", european ? "ccs2" : "ccs1");
      continue;
    }
    out.push(...(CONNECTOR_MAP[connector] ?? []));
  }
  return [...new Set(out)];
}

export function pickRange(raw: RawVehicle): { km: number; cycle: string; notes?: string } | null {
  const usable = (raw.range?.rated ?? []).filter(
    (entry) => typeof entry?.range_km === "number" && entry.range_km > 0,
  );
  if (usable.length === 0) return null;
  const picked =
    CYCLE_PREFERENCE.map((cycle) => usable.find((entry) => entry.cycle === cycle)).find(Boolean) ??
    usable[0];
  return { km: picked.range_km as number, cycle: picked.cycle ?? "", notes: picked.notes };
}

export function isHybrid(raw: RawVehicle): boolean {
  if (/phev/i.test(raw.unique_code ?? "")) return true;
  return (raw.range?.rated ?? []).some((entry) => HYBRID_NOTE_PATTERN.test(entry?.notes ?? ""));
}

export function estimateMassTonnes(raw: RawVehicle): number {
  const curbKg = raw.weights?.curb_weight_kg;
  if (typeof curbKg === "number" && curbKg > 0) return curbKg / 1000;
  return MASS_BY_VEHICLE_TYPE[raw.vehicle_type ?? ""] ?? FALLBACK_MASS_TONNES;
}

export function buildLabel(raw: RawVehicle): string {
  const parts = [raw.make?.name ?? "", raw.model?.name ?? ""];
  const trim = raw.trim?.name;
  if (trim && trim !== "Base") parts.push(trim);
  const variant = raw.variant?.name;
  // A fifth of the records repeat the trim name as the variant name
  // ("Model 3" / trim "Long Range" / variant "Long Range"), which would read
  // as "Tesla Model 3 Long Range Long Range".
  if (variant && !parts.some((part) => part.toLowerCase() === variant.toLowerCase())) {
    parts.push(variant);
  }
  if (raw.year) parts.push(`(${raw.year})`);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function mapVehicle(raw: RawVehicle): { ok: GeneratedVehicle } | { drop: DropReason } {
  const batteryKwh = raw.battery?.pack_capacity_kwh_net;
  if (typeof batteryKwh !== "number" || batteryKwh <= 0) return { drop: "no-battery" };

  const maxDcKw = raw.charging?.dc?.max_power_kw;
  if (typeof maxDcKw !== "number" || maxDcKw <= 0) return { drop: "no-dc" };

  if (isHybrid(raw)) return { drop: "hybrid" };

  const range = pickRange(raw);
  if (!range) return { drop: "no-range" };

  const connectors = mapConnectors(raw);
  if (connectors.length === 0) return { drop: "no-connectors" };

  const factor = CYCLE_FACTOR[range.cycle] ?? DEFAULT_CYCLE_FACTOR;
  const maxAcKw = raw.charging?.ac?.max_power_kw ?? 0;

  return {
    ok: {
      id: raw.unique_code ?? "",
      label: buildLabel(raw),
      batteryKwh,
      baseWhPerKm: Math.round((batteryKwh / (range.km * factor)) * 1000),
      massTonnes: estimateMassTonnes(raw),
      maxDcKw,
      maxAcKw,
      vehicleTaperSocPct: DEFAULT_TAPER_SOC_PCT,
      connectors,
    },
  };
}
