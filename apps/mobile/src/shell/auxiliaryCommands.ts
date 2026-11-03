import type { WebToNativeMessage } from "@openmapx/core/navigation";
import type { AuthPurpose, SystemAuthResult } from "../auth/SystemAuthSession";
import type { ForegroundFixResult } from "../location/ForegroundLocationService";
import type { CurrentFixOptions, LocationFix } from "../location/LocationDriver";
import type { AuxiliaryCommandHandler, CommandResponse } from "../navigation/NavigationCoordinator";
import type { SettingsOpenStatus, SettingsTarget } from "../settings/openAppSettings";

/**
 * The page's requests that are not about a navigation session: one position for
 * a "where am I" control, a trip to the OS settings, and a system-browser
 * sign-in.
 *
 * Each answer is a correlated reply in the protocol's own shape. A failure of
 * the underlying platform call is an answer too ("unavailable", "failed"),
 * never silence: a page left waiting cannot tell a refusal from a broken shell.
 */

export interface AuxiliaryCommandDeps {
  locate(options: CurrentFixOptions): Promise<ForegroundFixResult>;
  openSettings(target: SettingsTarget): Promise<SettingsOpenStatus>;
  signIn(purpose: AuthPurpose): Promise<SystemAuthResult>;
}

/** What the protocol's `location.result` fix accepts; anything else is dropped. */
export function wireFix(fix: LocationFix): {
  lat: number;
  lng: number;
  accuracy?: number;
  heading?: number;
  speed?: number;
  timestampMs: number;
} | null {
  const [lng, lat] = fix.coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (!Number.isFinite(fix.timestampMs) || fix.timestampMs < 0) return null;
  return {
    lat,
    lng,
    // Platforms report "unknown" as -1, NaN or Infinity depending on the field
    // and the version; the protocol rejects all of them, so they are omitted.
    ...(Number.isFinite(fix.accuracy) && fix.accuracy >= 0 && fix.accuracy <= 100_000
      ? { accuracy: fix.accuracy }
      : {}),
    ...(fix.headingDegrees !== undefined &&
    Number.isFinite(fix.headingDegrees) &&
    fix.headingDegrees >= 0 &&
    fix.headingDegrees <= 360
      ? { heading: fix.headingDegrees }
      : {}),
    ...(fix.speedMps !== undefined &&
    Number.isFinite(fix.speedMps) &&
    fix.speedMps >= 0 &&
    fix.speedMps <= 1_000
      ? { speed: fix.speedMps }
      : {}),
    timestampMs: Math.round(fix.timestampMs),
  };
}

/** The protocol's identifier bound; a longer handoff value cannot cross. */
const MAX_WIRE_ID = 128;

export function createAuxiliaryCommandHandler(deps: AuxiliaryCommandDeps): AuxiliaryCommandHandler {
  return async (command: WebToNativeMessage): Promise<CommandResponse | null> => {
    switch (command.type) {
      case "location.request": {
        const { requestId, accuracy, timeoutMs, maxAgeMs } = command.payload;
        let result: ForegroundFixResult;
        try {
          result = await withDeadline(deps.locate({ accuracy, timeoutMs, maxAgeMs }), timeoutMs);
        } catch {
          result = { status: "unavailable" };
        }
        if (result.status === "ok") {
          const fix = wireFix(result.fix);
          if (fix) return { type: "location.result", payload: { requestId, status: "ok", fix } };
          return { type: "location.result", payload: { requestId, status: "unavailable" } };
        }
        return { type: "location.result", payload: { requestId, status: result.status } };
      }

      case "settings.open": {
        const { target } = command.payload;
        let status: SettingsOpenStatus;
        try {
          status = await deps.openSettings(target);
        } catch {
          status = "unavailable";
        }
        return { type: "settings.result", payload: { target, status } };
      }

      case "auth.open": {
        const { requestId, purpose } = command.payload;
        let result: SystemAuthResult;
        try {
          result = await deps.signIn(purpose);
        } catch {
          result = { status: "failed" };
        }
        if (result.status !== "ok") {
          return { type: "auth.result", payload: { requestId, status: result.status } };
        }
        const { callbackCode, state, codeVerifier } = result;
        if ([callbackCode, state, codeVerifier].some((value) => value.length > MAX_WIRE_ID)) {
          return { type: "auth.result", payload: { requestId, status: "failed" } };
        }
        return {
          type: "auth.result",
          payload: { requestId, status: "ok", handoffCode: callbackCode, state, codeVerifier },
        };
      }

      default:
        return null;
    }
  };
}

/**
 * The page asked for an answer within `timeoutMs`; a platform call that never
 * settles must not hold the reply past that.
 */
function withDeadline(
  work: Promise<ForegroundFixResult>,
  timeoutMs: number,
): Promise<ForegroundFixResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ForegroundFixResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
