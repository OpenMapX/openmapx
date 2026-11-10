import { withBackgroundSafeProfiles } from "./backgroundSafeDriver";
import type { LocationDriver, LocationProfile, StartOptions } from "./LocationDriver";
import { profileFor } from "./profiles";

/** A driver that restarts a running stream to change profile, as expo-location does. */
function platform() {
  const state = { running: false, profile: null as LocationProfile | null, starts: 0, stops: 0 };
  const driver: LocationDriver = {
    getPermissionState: async () => "background",
    requestForegroundPermission: async () => "background",
    requestBackgroundPermission: async () => "background",
    start: async (profile: LocationProfile, options: StartOptions = {}) => {
      if (state.running && state.profile === profile) return;
      if (state.running && options.mayRestart && !options.mayRestart()) return;
      if (state.running) state.stops += 1;
      state.starts += 1;
      state.running = true;
      state.profile = profile;
    },
    stop: async () => {
      state.stops += 1;
      state.running = false;
      state.profile = null;
    },
    isRunning: async () => state.running,
    getCurrentFix: async () => null,
  };
  return { state, driver };
}

const cruise = profileFor("transit-cruise", "android");
const near = profileFor("transit-near-event", "android");

describe("withBackgroundSafeProfiles", () => {
  it("leaves iOS untouched", () => {
    const { driver } = platform();
    expect(withBackgroundSafeProfiles(driver, "ios", { isActive: () => false })).toBe(driver);
  });

  it("changes a running stream's profile while the app is active", async () => {
    const { state, driver } = platform();
    const safe = withBackgroundSafeProfiles(driver, "android", { isActive: () => true });
    await safe.start(cruise);
    await safe.start(near);
    expect(state.profile).toBe(near);
  });

  it("keeps a running stream as it is while the app is not active", async () => {
    const { state, driver } = platform();
    const app = { active: true, isActive: () => app.active };
    const safe = withBackgroundSafeProfiles(driver, "android", app);
    await safe.start(cruise);
    app.active = false;

    await safe.start(near);

    expect(state).toMatchObject({ running: true, profile: cruise, starts: 1, stops: 0 });
  });

  it("asks whether the app is active when the driver is about to restart, not when called", async () => {
    const { state, driver } = platform();
    const app = { active: true, isActive: () => app.active };
    let release = () => {};
    const queued: LocationDriver = {
      ...driver,
      // The real driver serializes its work; the screen locks while this waits.
      start: async (profile, options) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return driver.start(profile, options);
      },
    };
    await driver.start(cruise);
    const safe = withBackgroundSafeProfiles(queued, "android", app);

    const changing = safe.start(near);
    app.active = false;
    release();
    await changing;

    expect(state).toMatchObject({ running: true, profile: cruise, stops: 0 });
  });

  it("starts a stopped stream whatever the app's state", async () => {
    const { state, driver } = platform();
    const safe = withBackgroundSafeProfiles(driver, "android", { isActive: () => false });
    await safe.start(cruise);
    expect(state).toMatchObject({ running: true, starts: 1 });
  });
});
