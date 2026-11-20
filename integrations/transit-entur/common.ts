import type { TransportMode } from "@openmapx/mobility-core/transit";

export const ENTUR_PREFIX = "entur:";

const FEATURE_CATEGORY_MODE_MAP: Record<string, TransportMode> = {
  railStation: "rail",
  vehicleRailInterchange: "rail",
  metroStation: "subway",
  tramStation: "tram",
  onstreetTram: "tram",
  busStation: "bus",
  coachStation: "bus",
  onstreetBus: "bus",
  ferryPort: "ferry",
  ferryStop: "ferry",
  harbourPort: "ferry",
  liftStation: "gondola",
};

const FEATURE_MODE_KEY_MAP: Record<string, TransportMode> = {
  bus: "bus",
  coach: "bus",
  rail: "rail",
  metro: "subway",
  subway: "subway",
  tram: "tram",
  ferry: "ferry",
  water: "ferry",
  lift: "gondola",
  cableway: "cable_car",
  cablecar: "cable_car",
  cable_car: "cable_car",
  funicular: "funicular",
  monorail: "monorail",
};

export function withEnturPrefix(rawId: string): string {
  return `${ENTUR_PREFIX}${rawId}`;
}

export function isTruthyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Map an Entur mode to its OpenMapX equivalent. Returns undefined for modes with
 * no equivalent (air, taxi, carpool, snowAndIce, unknown) so callers decide how
 * to represent them instead of mislabelling them.
 */
export function toTransportMode(mode: string | null | undefined): TransportMode | undefined {
  const normalized = (mode ?? "").toLowerCase();
  switch (normalized) {
    case "rail":
      return "rail";
    case "metro":
      return "subway";
    case "tram":
      return "tram";
    case "water":
    case "ferry":
      return "ferry";
    case "lift":
      return "gondola";
    case "cableway":
      return "cable_car";
    case "funicular":
      return "funicular";
    case "monorail":
      return "monorail";
    case "coach":
    case "trolleybus":
    case "bus":
      return "bus";
    case "foot":
      return "walking";
    default:
      return undefined;
  }
}

export function collectStopModes(
  transportModes?: Array<string | null> | null,
  categories?: string[] | null,
  featureModes?: Array<Record<string, string | null>> | null,
): TransportMode[] {
  const modes = new Set<TransportMode>();
  for (const raw of transportModes ?? []) {
    const mapped = toTransportMode(raw);
    if (mapped) modes.add(mapped);
  }
  for (const category of categories ?? []) {
    const mapped = FEATURE_CATEGORY_MODE_MAP[category];
    if (mapped) modes.add(mapped);
  }
  for (const entry of featureModes ?? []) {
    for (const [key] of Object.entries(entry)) {
      const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
      const mapped = FEATURE_MODE_KEY_MAP[normalized];
      if (mapped) modes.add(mapped);
    }
  }
  return [...modes];
}

export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}
