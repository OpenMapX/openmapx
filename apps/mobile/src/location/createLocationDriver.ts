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

let driver: LocationDriver | null = null;

export function createLocationDriver(): LocationDriver {
  driver ??= new ExpoLocationDriver();
  return driver;
}

/** Test seam: drops the memoised driver so a suite can supply its own. */
export function resetLocationDriverCache(): void {
  driver = null;
}
