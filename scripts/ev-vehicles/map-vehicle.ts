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
  /** Manufacturer on its own, so the picker can group by it without parsing the label. */
  make: string;
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

// A CCS inlet is a DC combo built around its AC plug: every CCS2 car charges AC
// on Type 2, every CCS1 car on Type 1. Upstream only lists the DC port, and the
// planner matches a station's standard against this set, so without the AC half
// a CCS car could never use an AC charger and its maxAcKw would be dead weight.
const CONNECTOR_MAP: Record<string, string[]> = {
  ccs2: ["ccs2", "type2"],
  ccs1: ["ccs1", "type1"],
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
      out.push("nacs", "tesla_ccs", ...CONNECTOR_MAP[european ? "ccs2" : "ccs1"]);
      continue;
    }
    out.push(...(CONNECTOR_MAP[connector] ?? []));
  }
  return [...new Set(out)];
}

/** Realism-corrected range of one rated entry — the distance the derived Wh/km is based on. */
function effectiveRangeKm(entry: RawRatedRange): number {
  return (entry.range_km as number) * (CYCLE_FACTOR[entry.cycle ?? ""] ?? DEFAULT_CYCLE_FACTOR);
}

/**
 * The rated entry that implies the HIGHEST consumption once its own cycle factor
 * is applied — i.e. the shortest realism-corrected range.
 *
 * Upstream sometimes lists an implausible figure for one cycle next to a sane one
 * for another (the 2024 Model Y Long Range AWD claims 719 km WLTP alongside
 * 500 km EPA), so trusting a fixed cycle order silently under-estimates
 * consumption. Erring high adds an early charge stop, which is annoying; erring
 * low strands the driver, because the plan's arrival reserve is computed from
 * this figure. Take the conservative candidate.
 */
export function pickRange(raw: RawVehicle): { km: number; cycle: string; notes?: string } | null {
  const usable = (raw.range?.rated ?? []).filter(
    (entry) => typeof entry?.range_km === "number" && entry.range_km > 0,
  );
  if (usable.length === 0) return null;
  let picked = usable[0];
  for (const entry of usable) {
    if (effectiveRangeKm(entry) < effectiveRangeKm(picked)) picked = entry;
  }
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

/**
 * Append a name segment, folding away any overlap with what the label already
 * says. The upstream name fields repeat each other constantly — make "Polestar"
 * + model "Polestar 2", model "Cooper SE" + trim "SE", trim "Long Range" +
 * variant "Long Range AWD" — and concatenating them verbatim reads as
 * "Polestar Polestar 2" or "Model Y Long Range Long Range AWD". Merging on the
 * longest suffix/prefix word overlap keeps whichever segment carries the extra
 * detail without repeating the shared words.
 */
function appendSegment(tokens: string[], segment: string | undefined): string[] {
  const added = (segment ?? "").split(/\s+/).filter(Boolean);
  if (added.length === 0) return tokens;
  const lower = (words: string[]) => words.map((w) => w.toLowerCase());
  const current = lower(tokens);
  const incoming = lower(added);
  for (let overlap = Math.min(current.length, incoming.length); overlap > 0; overlap--) {
    const tail = current.slice(current.length - overlap).join(" ");
    if (tail === incoming.slice(0, overlap).join(" ")) return [...tokens, ...added.slice(overlap)];
  }
  return [...tokens, ...added];
}

export function buildLabel(raw: RawVehicle): string {
  let tokens = appendSegment([], raw.make?.name);
  tokens = appendSegment(tokens, raw.model?.name);
  const trim = raw.trim?.name;
  if (trim && trim !== "Base") tokens = appendSegment(tokens, trim);
  tokens = appendSegment(tokens, raw.variant?.name);
  const name = tokens.join(" ");
  return raw.year ? `${name} (${raw.year})` : name;
}

/** Everything the app actually shows or plans with — two records equal on all of it are the same car. */
function specSignature(vehicle: GeneratedVehicle): string {
  return JSON.stringify([
    vehicle.label,
    vehicle.batteryKwh,
    vehicle.baseWhPerKm,
    vehicle.massTonnes,
    vehicle.maxDcKw,
    vehicle.maxAcKw,
    vehicle.vehicleTaperSocPct,
    // Sorted for comparison only; the stored order is meaningful (it drives
    // connector preference) and must not be touched.
    [...vehicle.connectors].sort(),
  ]);
}

/**
 * Upstream ships both a bare record and a trim-qualified one for some cars
 * (`bmw:i4:2024:i4` and `bmw:i4:2024:i4_edrive40`); once distilled they carry
 * identical labels and identical specs, so the picker would offer the same car
 * twice. Keep the first by ascending id, which makes the choice deterministic.
 */
export function dedupeVehicles(list: GeneratedVehicle[]): {
  kept: GeneratedVehicle[];
  collapsed: number;
} {
  const seen = new Map<string, GeneratedVehicle>();
  let collapsed = 0;
  for (const vehicle of [...list].sort((a, b) => a.id.localeCompare(b.id))) {
    const signature = specSignature(vehicle);
    if (seen.has(signature)) {
      collapsed += 1;
      continue;
    }
    seen.set(signature, vehicle);
  }
  return { kept: [...seen.values()], collapsed };
}

/**
 * Safety net for a future dataset release: if two genuinely different cars end
 * up sharing a display name, tell them apart by the figure that differs rather
 * than shipping two indistinguishable entries. A no-op when no label collides,
 * which is the case today.
 */
export function disambiguateLabels(list: GeneratedVehicle[]): GeneratedVehicle[] {
  const groups = new Map<string, GeneratedVehicle[]>();
  for (const vehicle of list) {
    const group = groups.get(vehicle.label);
    if (group) group.push(vehicle);
    else groups.set(vehicle.label, [vehicle]);
  }
  return list.map((vehicle) => {
    const group = groups.get(vehicle.label) as GeneratedVehicle[];
    if (group.length < 2) return vehicle;
    const batteryDiffers = group.some((other) => other.batteryKwh !== group[0].batteryKwh);
    const suffix = batteryDiffers ? `${vehicle.batteryKwh} kWh` : `${vehicle.maxDcKw} kW`;
    return { ...vehicle, label: `${vehicle.label} · ${suffix}` };
  });
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
      make: (raw.make?.name ?? "").trim(),
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
