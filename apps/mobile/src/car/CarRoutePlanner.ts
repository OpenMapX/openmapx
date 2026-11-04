import {
  buildGroundNavigationPackage,
  type CarDestinations,
  carDestinationSchema,
  type GroundNavigationStartPackage,
} from "@openmapx/core/navigation";
import { createApiClient, fetchDirections } from "@openmapx/core/navigation/api";
import { createLocationDriver } from "../location/createLocationDriver";
import type { NavigationCoordinator } from "../navigation/NavigationCoordinator";
import type { NavigationStartContext } from "../navigation/startContext";

/** Network work runs outside the coordinator queue and loses authority on stop/supersede. */
export class CarRoutePlanner {
  private generation = 0;
  private controller: AbortController | null = null;
  private candidates: GroundNavigationStartPackage[] = [];
  constructor(
    private readonly apiOrigin: string,
    private readonly coordinator: () => Promise<NavigationCoordinator>,
    private readonly context: () => NavigationStartContext,
  ) {}
  cancel() {
    this.generation++;
    this.controller?.abort();
    this.candidates = [];
  }
  async plan(destination: unknown, preferences: CarDestinations) {
    this.cancel();
    const generation = this.generation;
    const target = carDestinationSchema.parse(destination);
    const driver = createLocationDriver();
    if ((await driver.getPermissionState()) !== "background") throw new Error("phone-setup");
    const fix = await driver.getCurrentFix({
      accuracy: "precise",
      maxAgeMs: 10000,
      timeoutMs: 15000,
    });
    if (!fix || Date.now() - fix.timestampMs > 15000 || fix.accuracy > 100)
      throw new Error("location-unavailable");
    if (generation !== this.generation) return null;
    const controller = new AbortController();
    this.controller = controller;
    const waypoints: [number, number][] = [fix.coords, target.coordinates];
    const client = createApiClient({ baseUrl: this.apiOrigin, credentials: "omit" });
    const result = await fetchDirections(
      {
        waypoints,
        mode: "driving",
        units: preferences.units,
        lang: preferences.locale,
        avoidHighways: preferences.avoidHighways,
        avoidTolls: preferences.avoidTolls,
        avoidFerries: preferences.avoidFerries,
        avoidClosures: preferences.avoidClosures,
      },
      client,
      { signal: controller.signal, timeoutMs: 15000 },
    );
    if (generation !== this.generation) return null;
    this.candidates = result.routes.slice(0, 8).flatMap((route) => {
      const built = buildGroundNavigationPackage({
        route,
        alternatives: [],
        mode: "driving",
        destinationWaypoints: waypoints,
        routeSelectionIntent: "userSelected",
        routeOptions: {
          avoidHighways: preferences.avoidHighways,
          avoidTolls: preferences.avoidTolls,
          avoidFerries: preferences.avoidFerries,
          avoidClosures: preferences.avoidClosures,
        },
        locale: preferences.locale,
        units: preferences.units,
        settings: {
          voiceEnabled: preferences.voiceEnabled,
          keepScreenOn: preferences.keepScreenOn,
          voiceTiming: preferences.voiceTiming,
        },
      });
      return built.ok ? [built.startPackage] : [];
    });
    if (!this.candidates.length) throw new Error("no-route");
    return this.candidates.map((candidate) => ({ coordinates: candidate.route.geometry }));
  }
  async start(index: number, replaceSessionId?: string) {
    const candidate = this.candidates[index];
    const generation = this.generation;
    if (!candidate) return null;
    return (await this.coordinator()).startCarTrip(
      candidate,
      this.context,
      () => generation === this.generation,
      replaceSessionId,
    );
  }
}
