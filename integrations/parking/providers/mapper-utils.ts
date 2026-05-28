import type { I18nTokenLike, ParkingType } from "@openmapx/mobility-core/parking";

/**
 * Shared payload-coercion helpers used by every `*-mapper.ts` in this
 * directory. Each mapper validates the JSON blob stored in the POI registry
 * before constructing a `ParkingFacility`; the shape is intentionally
 * `unknown` so a malformed/stale payload from a previous schema can't
 * crash the read path.
 *
 * Fallback-bearing helpers (`asFee`, `asState`, `asParkingType`) are
 * parameterised because per-source defaults are genuinely different:
 *   - Operator-published garages default `fee` to `"paid"` (we know it's
 *     paid even before the row arrives).
 *   - Open-data aggregators default to `"unknown"` (they cover both).
 *   - Some sources want the state field omitted entirely when the source
 *     can't speak to it (returns `undefined`), others want an explicit
 *     `"unknown"` sentinel.
 *
 * The overloads narrow the return type so a call site that passes a
 * concrete fallback gets the concrete union back, not `T | undefined`.
 */

export type Fee = "free" | "paid" | "unknown";
export type Access = "public" | "private" | "customers" | "permit";
export type State = "open" | "closed" | "unknown";
export type Trend = "increasing" | "decreasing" | "constant";

export function asStringOrUndef(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumberOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolOrUndef(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? out : undefined;
}

export function asAccess(value: unknown): Access | undefined {
  if (value === "public" || value === "private" || value === "customers" || value === "permit") {
    return value;
  }
  return undefined;
}

export function asTrend(value: unknown): Trend | undefined {
  if (value === "increasing" || value === "decreasing" || value === "constant") return value;
  return undefined;
}

export function asFee(value: unknown, fallback: Fee): Fee;
export function asFee(value: unknown, fallback: undefined): Fee | undefined;
export function asFee(value: unknown, fallback: Fee | undefined): Fee | undefined {
  if (value === "free" || value === "paid" || value === "unknown") return value;
  return fallback;
}

export function asState(value: unknown, fallback: State): State;
export function asState(value: unknown, fallback: undefined): State | undefined;
export function asState(value: unknown, fallback: State | undefined): State | undefined {
  if (value === "open" || value === "closed" || value === "unknown") return value;
  return fallback;
}

const PARKING_TYPES: readonly ParkingType[] = [
  "garage",
  "surface",
  "underground",
  "on-street",
  "unknown",
] as const;

export function asParkingType(value: unknown, fallback: ParkingType): ParkingType;
export function asParkingType(value: unknown, fallback: undefined): ParkingType | undefined;
export function asParkingType(
  value: unknown,
  fallback: ParkingType | undefined,
): ParkingType | undefined {
  return PARKING_TYPES.includes(value as ParkingType) ? (value as ParkingType) : fallback;
}

function isI18nTokenLike(value: unknown): value is I18nTokenLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "$t" in value &&
    typeof (value as { $t: unknown }).$t === "string"
  );
}

/**
 * Coerce a JSON-deserialized tariff-rows array into `[I18nTokenLike, string][]`.
 * Labels emitted by the migrated parsers are already `I18nToken` objects; any
 * raw string surviving in a legacy registry payload is wrapped in the
 * `tariff.literal` token so the contract's I18nToken-only label invariant
 * holds end-to-end.
 */
export function asTariffRows(value: unknown): [I18nTokenLike, string][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: [I18nTokenLike, string][] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [label, price] = item;
    if (typeof price !== "string") continue;
    if (typeof label === "string") {
      rows.push([{ $t: "tariff.literal", values: { value: label } }, price]);
    } else if (isI18nTokenLike(label)) {
      rows.push([label, price]);
    }
  }
  return rows.length > 0 ? rows : undefined;
}
