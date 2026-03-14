import type { TransportMode } from "../services/transit/types.js";

const MOTIS_MODE_MAP: Record<string, TransportMode> = {
  WALK: "walking",
  TRAM: "tram",
  SUBWAY: "subway",
  FERRY: "ferry",
  BUS: "bus",
  COACH: "bus",
  RAIL: "rail",
  HIGHSPEED_RAIL: "rail",
  LONG_DISTANCE: "rail",
  NIGHT_RAIL: "rail",
  REGIONAL_FAST_RAIL: "rail",
  REGIONAL_RAIL: "rail",
  SUBURBAN: "rail",
  FUNICULAR: "funicular",
  AERIAL_LIFT: "gondola",
  OTHER: "bus",
  MONORAIL: "monorail",
};

/** Map a MOTIS transport mode string to a TransportMode. */
export function motisMode(mode: string | undefined): TransportMode {
  if (!mode) return "bus";
  return MOTIS_MODE_MAP[mode] ?? "bus";
}

/** Deduplicate mapped transport modes. */
export function uniqueModes(modes: string[]): TransportMode[] {
  const mapped = modes.map(motisMode);
  return [...new Set(mapped)];
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** Fetch JSON from a MOTIS-compatible API, returning null on non-ok responses. */
export async function motisFetch<T>(
  baseUrl: string,
  path: string,
  params: Record<string, string> = {},
  options?: { timeoutMs?: number; userAgent?: string },
): Promise<T | null> {
  const url = new URL(`${baseUrl}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (options?.userAgent) headers["User-Agent"] = options.userAgent;
    const res = await fetch(url.toString(), { headers, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
