import type { LocationDriver, LocationFix, LocationProfile } from "../location/LocationDriver";
/** Debug route replay uses the coordinator batch port, never a second navigation engine. */
export class SimulatedLocationDriver implements LocationDriver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private index = 0;
  private last: LocationFix | null = null;
  constructor(
    private readonly coordinates: readonly (readonly [number, number])[],
    private readonly deliver: (fix: LocationFix) => Promise<void>,
    private readonly now = Date.now,
  ) {}
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
  private async tick() {
    const coords = this.coordinates[this.index++];
    if (!coords) {
      await this.stop();
      return;
    }
    this.last = {
      coords: [coords[0], coords[1]],
      accuracy: 5,
      timestampMs: this.now(),
      speedMps: 10,
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
