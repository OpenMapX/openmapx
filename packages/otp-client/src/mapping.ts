import type { TransportMode } from "@openmapx/mobility-core/transit";

const OTP_TRANSPORT_MODES: Readonly<Record<string, TransportMode>> = {
  BUS: "bus",
  COACH: "bus",
  TROLLEYBUS: "bus",
  RAIL: "rail",
  SUBWAY: "subway",
  METRO: "subway",
  TRAM: "tram",
  FERRY: "ferry",
  WATER: "ferry",
  GONDOLA: "gondola",
  CABLEWAY: "gondola",
  FUNICULAR: "funicular",
  CABLE_CAR: "cable_car",
  MONORAIL: "monorail",
  WALK: "walking",
};

/**
 * The transport mode of an OTP mode name, from both the GTFS (`SUBWAY`) and the
 * Transmodel (`METRO`, `WATER`, `CABLEWAY`) vocabularies; undefined when unknown.
 */
export function otpTransportMode(value: string | null | undefined): TransportMode | undefined {
  return value ? OTP_TRANSPORT_MODES[value.toUpperCase()] : undefined;
}

/**
 * An OTP route colour as six hex digits without `#`, as every provider emits
 * it. Undefined when the route has none; null when the value is not a colour.
 */
export function otpRouteColor(value: string | null | undefined): string | undefined | null {
  if (!value) return undefined;
  const hex = value.replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? hex : null;
}
