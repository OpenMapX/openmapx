import { z } from "zod";
import { setDebugLocationDriver } from "../location/createLocationDriver";
import { foregroundCoordinator } from "../navigation/foregroundCoordinator";
import type { NavigationCoordinator } from "../navigation/NavigationCoordinator";
import type { SessionRepository } from "../storage/SessionRepository";
import { SimulatedLocationDriver } from "./SimulatedLocationDriver";

let replay: SimulatedLocationDriver | null = null;
export async function stopTestDrive(): Promise<void> {
  if (replay) await setDebugLocationDriver(null);
  replay = null;
}
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
  await stopTestDrive();
  replay = new SimulatedLocationDriver(route.data.geometry, async (fix) => {
    const active = await repository.loadActive(Date.now());
    if (active?.sessionId !== session.sessionId || active.status !== "active") {
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
  await setDebugLocationDriver(replay);
  await replay.start({
    accuracy: "navigation",
    timeIntervalMs: 1000,
    distanceIntervalMeters: 0,
    activityType: "automotive-navigation",
    pausesUpdatesAutomatically: false,
  });
}
