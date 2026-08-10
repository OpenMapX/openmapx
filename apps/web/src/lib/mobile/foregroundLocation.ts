/**
 * One fix, from whoever is allowed to give it.
 *
 * The ordinary browser keeps `navigator.geolocation.getCurrentPosition`, exactly
 * as it always had. Inside the installed shell it does not: native owns the one
 * location producer, and a browser fix taken alongside a native session would be
 * a second answer to "where am I" from a second sensor subscription.
 *
 * A v1 shell cannot answer this at all. That is reported as unavailable rather
 * than quietly falling back to the browser — falling back would restore exactly
 * the second producer this exists to prevent, and would do so precisely on the
 * devices running the oldest binaries.
 */

import type { BridgeClient } from "./bridgeClient";
import { BridgeError } from "./bridgeClient";

export interface ForegroundFix {
  lat: number;
  lng: number;
  accuracy?: number;
  heading?: number;
  speed?: number;
  timestampMs: number;
}

export type ForegroundLocationStatus =
  | "ok"
  | "denied"
  | "unavailable"
  | "timeout"
  /** The shell is too old to answer; the page must not fall back to the browser. */
  | "unsupported";

export type ForegroundLocationResult =
  | { status: "ok"; fix: ForegroundFix }
  | { status: Exclude<ForegroundLocationStatus, "ok"> };

export interface ForegroundLocationOptions {
  accuracy?: "balanced" | "precise";
  timeoutMs?: number;
  /** How old an already-known fix may be before a fresh one is required. */
  maxAgeMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_AGE_MS = 15_000;

/** Reads one fix through the browser's own geolocation. */
export function browserForegroundFix(
  options: ForegroundLocationOptions = {},
  geolocation: Geolocation | undefined = globalThis.navigator?.geolocation,
): Promise<ForegroundLocationResult> {
  if (!geolocation) return Promise.resolve({ status: "unavailable" });

  // Only what the caller actually asked for. The browser path is the one the
  // PWA has always taken, and quietly adding a timeout or a high-accuracy
  // request here would change behaviour for every existing user in order to
  // tidy up a code path they never see.
  const positionOptions: PositionOptions = {};
  if (options.accuracy !== undefined)
    positionOptions.enableHighAccuracy = options.accuracy !== "balanced";
  if (options.timeoutMs !== undefined) positionOptions.timeout = options.timeoutMs;
  if (options.maxAgeMs !== undefined) positionOptions.maximumAge = options.maxAgeMs;

  return new Promise((resolve) => {
    geolocation.getCurrentPosition(
      (position) =>
        resolve({
          status: "ok",
          fix: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy ?? undefined,
            heading: position.coords.heading ?? undefined,
            speed: position.coords.speed ?? undefined,
            timestampMs: position.timestamp,
          },
        }),
      (error) => {
        // 1 is PERMISSION_DENIED, 3 is TIMEOUT. Distinguished because one is
        // worth retrying and the other is a settings trip.
        if (error.code === 1) return resolve({ status: "denied" });
        if (error.code === 3) return resolve({ status: "timeout" });
        resolve({ status: "unavailable" });
      },
      positionOptions,
    );
  });
}

/** Requests one fix from the shell. */
export async function nativeForegroundFix(
  client: BridgeClient,
  requestId: string,
  options: ForegroundLocationOptions = {},
): Promise<ForegroundLocationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const reply = await client.request(
      "location.request",
      {
        requestId,
        accuracy: options.accuracy ?? "precise",
        timeoutMs,
        maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
      },
      // A little slack past the shell's own deadline, so the shell's answer wins
      // the race and the page reports what actually happened.
      { timeoutMs: timeoutMs + 2_000 },
    );
    if (reply.type !== "location.result") return { status: "unavailable" };
    const payload = reply.payload as { requestId: string; status: string; fix?: ForegroundFix };
    // A stale answer to an abandoned request would move the map under someone.
    if (payload.requestId !== requestId) return { status: "unavailable" };
    if (payload.status === "ok" && payload.fix) return { status: "ok", fix: payload.fix };
    if (payload.status === "denied") return { status: "denied" };
    if (payload.status === "timeout") return { status: "timeout" };
    return { status: "unavailable" };
  } catch (error) {
    if (error instanceof BridgeError && error.code === "unsupported-capability") {
      return { status: "unsupported" };
    }
    if (error instanceof BridgeError && error.code === "timeout") return { status: "timeout" };
    return { status: "unavailable" };
  }
}
