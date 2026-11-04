import { simulatePositions } from "@openmapx/core/navigation";
import type { LocationDriver, LocationFix, LocationProfile } from "../location/LocationDriver";

/** Simulated speed: 36 km/h, a city drive a reviewer can follow. */
const SPEED_MPS = 10;
/** Debug route replay uses the coordinator batch port, never a second navigation engine. */
export class SimulatedLocationDriver implements LocationDriver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private index = 0;
  private last: LocationFix | null = null;
  constructor(
    coordinates: readonly (readonly [number, number])[],
    private readonly deliver: (fix: LocationFix) => Promise<void>,
    private readonly now = Date.now,
  ) {
    this.fixes = simulatePositions(
      coordinates.map(([lng, lat]) => [lng, lat] as [number, number]),
      { speedMps: SPEED_MPS, intervalMs: 1000, accuracy: 5 },
    );
  }
  async getPermissionState() {
    return "background" as const;
  }
  async requestForegroundPermission() {
    return this.getPermissionState();
  }
  async requestBackgroundPermission() {
    return this.getPermissionState();
  }
  async start(_profile: LocationProfile) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
  }
  /**
   * One fix per second at constant speed along the route, from the same
   * `simulatePositions` the web's navigation simulator uses, instead of one route
   * vertex per second (slow on curves, jumps on long straights).
   */
  private readonly fixes: ReturnType<typeof simulatePositions>;
  private async tick() {
    const fix = this.fixes[this.index++];
    if (!fix) {
      await this.stop();
      return;
    }
    this.last = {
      coords: [fix.coords[0], fix.coords[1]],
      accuracy: fix.accuracy,
      timestampMs: this.now(),
      speedMps: fix.speed ?? SPEED_MPS,
      ...(typeof fix.heading === "number" ? { headingDegrees: fix.heading } : {}),
    };
    await this.deliver(this.last);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async isRunning() {
    return this.timer !== null;
  }
  async getCurrentFix() {
    return this.last;
  }
}
