import type {
  EvChargingPriceComponent,
  EvChargingTariffRestriction,
  EvTariffDimension,
} from "@openmapx/mobility-core/ev-charging";
import { cleanString } from "./utils.js";

// Shared OCPI 2.2 tariff mapping used by every OCPI-shaped charging source
// (nl-dotnl, de-ocpdb). Sources differ only in how they carry VAT (NL: an
// inline `vat` number; OCPDB: a `taxes[]` array) and in the tariff-level fields
// they wrap around each group — so those stay in the source parsers, and the
// element/restriction mapping plus the split-by-restriction grouping live here.

export interface OcpiPriceComponentLike {
  type?: string;
  price?: number;
  step_size?: number;
}

export interface OcpiRestrictionsLike {
  start_time?: string | null;
  end_time?: string | null;
  min_power?: number | null;
  max_power?: number | null;
  // Charging-session duration bounds in SECONDS. Both NDW and OCPDB serialize
  // `0` as "unset" (not "zero seconds"), so only strictly-positive values are a
  // real restriction.
  min_duration?: number | null;
  max_duration?: number | null;
}

export interface OcpiTariffElementLike<C extends OcpiPriceComponentLike = OcpiPriceComponentLike> {
  price_components?: C[] | null;
  restrictions?: OcpiRestrictionsLike | null;
}

export interface OcpiTariffGroup {
  restrictions: EvChargingTariffRestriction | undefined;
  elements: EvChargingPriceComponent[];
}

export function mapOcpiPriceComponentType(type: string | undefined): EvTariffDimension | undefined {
  switch (type) {
    case "ENERGY":
      return "energy";
    case "TIME":
      return "time";
    case "FLAT":
      return "flat";
    case "PARKING_TIME":
      return "parking";
    default:
      // Stray/unmapped types (e.g. the top-level-only "REGULAR") are dropped
      // rather than emitted with `type: undefined`.
      return undefined;
  }
}

function durationMinutes(seconds: number | null | undefined): number | undefined {
  return typeof seconds === "number" && seconds > 0 ? Math.round(seconds / 60) : undefined;
}

export function mapOcpiRestrictions(
  r: OcpiRestrictionsLike | null | undefined,
): EvChargingTariffRestriction | undefined {
  if (!r) return undefined;
  const out: EvChargingTariffRestriction = {
    timeOfDayStart: cleanString(r.start_time ?? undefined),
    timeOfDayEnd: cleanString(r.end_time ?? undefined),
    minPowerKw: typeof r.min_power === "number" ? r.min_power : undefined,
    maxPowerKw: typeof r.max_power === "number" ? r.max_power : undefined,
    minDurationMinutes: durationMinutes(r.min_duration),
    maxDurationMinutes: durationMinutes(r.max_duration),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

/**
 * Groups an OCPI tariff's price components by their element's restrictions, so
 * each distinct restriction becomes its own group. Callers wrap each returned
 * group in an `EvChargingTariff` with their own top-level fields (scope,
 * source, altText, …). Splitting per restriction keeps a duration-gated
 * blocking fee — or any per-element condition — on its own component instead of
 * flat-stamping one element's restriction across the whole tariff. `vatOf`
 * extracts the VAT percentage from a component (source-specific). Elements with
 * no priceable component are skipped; group order follows first appearance.
 */
export function splitOcpiTariffElements<C extends OcpiPriceComponentLike>(
  elements: ReadonlyArray<OcpiTariffElementLike<C>> | undefined,
  currency: string,
  vatOf: (component: C) => number | undefined,
): OcpiTariffGroup[] {
  const groups = new Map<string, OcpiTariffGroup>();
  for (const el of elements ?? []) {
    const components: EvChargingPriceComponent[] = [];
    for (const c of el.price_components ?? []) {
      const type = mapOcpiPriceComponentType(c.type);
      if (!type || typeof c.price !== "number") continue;
      components.push({
        type,
        price: c.price,
        currency,
        vat: vatOf(c),
        stepSize: typeof c.step_size === "number" ? c.step_size : undefined,
      });
    }
    if (components.length === 0) continue;
    const restrictions = mapOcpiRestrictions(el.restrictions);
    const key = JSON.stringify(restrictions ?? null);
    const group = groups.get(key);
    if (group) group.elements.push(...components);
    else groups.set(key, { restrictions, elements: components });
  }
  return [...groups.values()];
}
