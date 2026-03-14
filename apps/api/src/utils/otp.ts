import type { TransportMode } from "../services/transit/types.js";

const OTP_MODE_MAP: Record<string, TransportMode> = {
  BUS: "bus",
  RAIL: "rail",
  SUBWAY: "subway",
  TRAM: "tram",
  FERRY: "ferry",
  GONDOLA: "gondola",
  FUNICULAR: "funicular",
  CABLE_CAR: "cable_car",
  MONORAIL: "monorail",
  TROLLEYBUS: "bus",
  COACH: "bus",
  WALK: "walking",
};

/** Map an OTP transport mode string to a TransportMode. */
export function otpMode(mode: string | undefined): TransportMode {
  if (!mode) return "bus";
  return OTP_MODE_MAP[mode.toUpperCase()] ?? "bus";
}
