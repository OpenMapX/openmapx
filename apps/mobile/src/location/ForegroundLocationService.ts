import type {
  CurrentFixOptions,
  LocationDriver,
  LocationFix,
  LocationPermissionState,
} from "./LocationDriver";

/**
 * Answers "where am I" for ordinary foreground actions.
 *
 * Two things this deliberately does not do.
 *
 * It does not escalate permission. Centring the map is not navigation, and
 * asking for Always location to satisfy a map gesture is both wrong and a store
 * review finding. Foreground access is enough. When it has never been asked
 * for, the request that reaches here is the user's own tap on a location
 * control, which is the moment the platforms expect the When-In-Use prompt;
 * the composition supplies that prompt only while the app is in front. A
 * refusal is final here: no second prompt, the answer is "denied".
 *
 * It does not open a second stream. When a navigation session is running the
 * driver already has a live subscription, and starting another would be the
 * duplicate producer the whole driver boundary exists to prevent — so a running
 * session's own latest fix is the answer, provided it is fresh enough.
 */

export type ForegroundFixStatus = "ok" | "denied" | "unavailable" | "timeout";

export type ForegroundFixResult =
  | { status: "ok"; fix: LocationFix }
  | { status: Exclude<ForegroundFixStatus, "ok"> };

export interface ForegroundLocationDeps {
  driver: LocationDriver;
  clock: () => number;
  /**
   * The newest fix the running navigation session has accepted, if any.
   *
   * Supplied by the coordinator rather than read from it, so this service never
   * reaches into a session it does not own.
   */
  latestSessionFix?: () => LocationFix | null;
  /**
   * Shows the When-In-Use prompt for a permission that was never asked for.
   *
   * Absent in contexts where no prompt may appear, such as a background
   * callback; there an unasked permission is simply "denied".
   */
  requestForegroundPermission?: () => Promise<LocationPermissionState>;
}

export class ForegroundLocationService {
  constructor(private readonly deps: ForegroundLocationDeps) {}

  async getFix(options: CurrentFixOptions): Promise<ForegroundFixResult> {
    let permission = await this.deps.driver.getPermissionState();
    if (permission === "not-determined" && this.deps.requestForegroundPermission) {
      permission = await this.deps.requestForegroundPermission();
    }
    if (permission === "denied" || permission === "not-determined") return { status: "denied" };

    const known = this.deps.latestSessionFix?.() ?? null;
    if (known && this.deps.clock() - known.timestampMs <= options.maxAgeMs) {
      return { status: "ok", fix: known };
    }

    const deadline = this.deps.clock() + options.timeoutMs;
    const fix = await this.deps.driver.getCurrentFix(options);
    if (!fix) {
      // A driver that answered nothing before the deadline timed out; one that
      // answered nothing after it had already given up.
      return { status: this.deps.clock() >= deadline ? "timeout" : "unavailable" };
    }
    return { status: "ok", fix };
  }
}
