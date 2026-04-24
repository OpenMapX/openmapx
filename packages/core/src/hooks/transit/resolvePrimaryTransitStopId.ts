import type { TransitStop } from "@integrations/transit/types";
import { parseId } from "../../types/identified";
import type { Place } from "../../types/place";

const ENTUR_PREFIX = "entur:";
const NSR_PREFIX = "NSR:";

function isInfrastructureStopId(rawId: string): boolean {
  return rawId.includes(":StopPlace:") || rawId.includes(":Quay:");
}

function normalizeNsrValue(value: string): string {
  return value.startsWith(NSR_PREFIX) ? value : `${NSR_PREFIX}${value}`;
}

function normalizeEnturStopId(value: string): string | null {
  const raw = value.startsWith(ENTUR_PREFIX) ? value.slice(ENTUR_PREFIX.length) : value;
  if (!isInfrastructureStopId(raw)) return null;
  if (raw.startsWith(NSR_PREFIX)) return `${ENTUR_PREFIX}${raw}`;
  if (raw.startsWith("StopPlace:") || raw.startsWith("Quay:")) {
    return `${ENTUR_PREFIX}${normalizeNsrValue(raw)}`;
  }
  return `${ENTUR_PREFIX}${raw}`;
}

export function resolvePrimaryTransitStopId(place: Place): string | null {
  const parsed = parseId(place.id);
  if (parsed?.scheme === "entur") {
    return normalizeEnturStopId(parsed.value);
  }
  if (parsed?.scheme === "nsr") {
    return normalizeEnturStopId(normalizeNsrValue(parsed.value));
  }
  if (place.ids.entur) {
    return normalizeEnturStopId(place.ids.entur);
  }
  if (place.ids.nsr) {
    return normalizeEnturStopId(normalizeNsrValue(place.ids.nsr));
  }
  return null;
}

export function resolvePrimaryTransitStopIdFromLinkedStops(
  stops: TransitStop[] | null | undefined,
): string | null {
  if (!stops?.length) return null;
  const ranked = [...stops]
    .map((stop) => ({ stop, id: normalizeEnturStopId(stop.id) }))
    .filter((entry): entry is { stop: TransitStop; id: string } => entry.id !== null)
    .sort((a, b) => {
      const score = (value: string) => {
        if (value.startsWith(`${ENTUR_PREFIX}${NSR_PREFIX}`) && value.includes(":StopPlace:"))
          return 0;
        if (value.startsWith(`${ENTUR_PREFIX}${NSR_PREFIX}`) && value.includes(":Quay:")) return 10;
        if (value.includes(":StopPlace:")) return 20;
        if (value.includes(":Quay:")) return 30;
        return 100;
      };
      return score(a.id) - score(b.id);
    });
  return ranked[0]?.id ?? null;
}
