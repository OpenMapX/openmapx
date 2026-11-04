import { deviceMobileLocale } from "../shell/shellCopy";
import { ExpoLocationDriver } from "./ExpoLocationDriver";
import type { LocationDriver } from "./LocationDriver";

/**
 * The one location driver for this process.
 *
 * Memoised because two drivers would mean two update streams for one session,
 * and the operating system happily grants that. The foreground app and the
 * headless task both come through here.
 *
 * `expo-location` is the provisionally selected implementation. Everything above
 * this function depends only on `LocationDriver`, so replacing it is a change to
 * this file and one class — not to the coordinator, storage, bridge or engines.
 */

let driver: ExpoLocationDriver | null = null;
let debugDriver: LocationDriver | null = null;
const sharedDriver: LocationDriver = {
  setLocale: (locale) => productionDriver().setLocale(locale),
  getPermissionState: () => productionDriver().getPermissionState(),
  requestForegroundPermission: () => productionDriver().requestForegroundPermission(),
  requestBackgroundPermission: () => productionDriver().requestBackgroundPermission(),
  start: (profile) => (debugDriver ?? productionDriver()).start(profile),
  stop: async () => {
    const current = debugDriver ?? productionDriver();
    debugDriver = null;
    await current.stop();
  },
  isRunning: () => (debugDriver ?? productionDriver()).isRunning(),
  getCurrentFix: (options) => (debugDriver ?? productionDriver()).getCurrentFix(options),
};
function productionDriver(): ExpoLocationDriver {
  driver ??= new ExpoLocationDriver(deviceMobileLocale());
  return driver;
}
/** A developer-only replacement; permission queries always read real OS grants. */
export async function setDebugLocationDriver(replacement: LocationDriver | null): Promise<void> {
  if (!__DEV__) return;
  await (debugDriver ?? productionDriver()).stop();
  debugDriver = replacement;
}

export function createLocationDriver(): LocationDriver {
  return sharedDriver;
}

/** Test seam: drops the memoised driver so a suite can supply its own. */
export function resetLocationDriverCache(): void {
  driver = null;
  debugDriver = null;
}
