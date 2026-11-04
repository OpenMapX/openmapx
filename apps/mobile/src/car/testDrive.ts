import { z } from "zod";
import { setDebugLocationDriver } from "../location/createLocationDriver";
import { foregroundCoordinator } from "../navigation/foregroundCoordinator";
import type { NavigationCoordinator } from "../navigation/NavigationCoordinator";
import type { SessionRepository } from "../storage/SessionRepository";
import { SimulatedLocationDriver } from "./SimulatedLocationDriver";

let replay: SimulatedLocationDriver | null = null;
export async function stopTestDrive(): Promise<void> {
  if (replay) await setDebugLocationDriver(null, { hostAutoDrive: true });
  replay = null;
}
/**
 * Replays a route through the shared coordinator's location batch port.
 * `autoStart` starts it now (a trip already running); otherwise the coordinator
 * starts it as the trip's location driver.
 */
async function installReplay(
  geometry: readonly (readonly [number, number])[],
  coordinator: NavigationCoordinator,
  repository: SessionRepository,
  options: { hostAutoDrive: boolean; autoStart: boolean },
): Promise<void> {
  await stopTestDrive();
  const next = new SimulatedLocationDriver(geometry, async (fix) => {
    const active = await repository.loadActive(Date.now());
    if (active?.kind !== "ground" || active.status !== "active") {
      await stopTestDrive();
      return;
    }
    await (foregroundCoordinator() ?? coordinator).handleLocationBatch({
      locations: [
        {
          timestamp: fix.timestampMs,
          coords: {
            longitude: fix.coords[0],
            latitude: fix.coords[1],
            accuracy: 5,
            speed: fix.speedMps,
          },
        },
      ],
    });
  });
  replay = next;
  await setDebugLocationDriver(next, { hostAutoDrive: options.hostAutoDrive });
  if (options.autoStart)
    await next.start({
      accuracy: "navigation",
      timeIntervalMs: 1000,
      distanceIntervalMeters: 0,
      activityType: "automotive-navigation",
      pausesUpdatesAutomatically: false,
    });
}

/** Development builds: replay the running trip from the car's Test drive action. */
export async function startTestDrive(
  coordinator: NavigationCoordinator,
  repository: SessionRepository,
): Promise<void> {
  if (!__DEV__) return;
  const session = await repository.loadActive(Date.now());
  if (session?.kind !== "ground" || session.status !== "active") return;
  const route = z
    .object({ geometry: z.array(z.tuple([z.number(), z.number()])) })
    .safeParse(session.payload.startPackage.route);
  if (!route.success) return;
  await installReplay(route.data.geometry, coordinator, repository, {
    hostAutoDrive: false,
    autoStart: true,
  });
}

/**
 * Android Auto's test-drive mode (`onAutoDriveEnabled`, NF-7): the trip about to start
 * drives itself along `geometry`. Installed before the start, so the coordinator starts
 * the replay instead of the real location service.
 */
export async function prepareAutoDrive(
  geometry: readonly (readonly [number, number])[],
  coordinator: NavigationCoordinator,
  repository: SessionRepository,
): Promise<void> {
  await installReplay(geometry, coordinator, repository, {
    hostAutoDrive: true,
    autoStart: false,
  });
}
