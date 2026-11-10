import { type AppActivity, withBackgroundSafeProfiles } from "./backgroundSafeDriver";
import type { LocationDriver, LocationProfile } from "./LocationDriver";
import { profileFor } from "./profiles";

function platform() {
  const state = { running: false, profile: null as LocationProfile | null, starts: 0, stops: 0 };
  const driver: LocationDriver = {
    getPermissionState: async () => "background",
    requestForegroundPermission: async () => "background",
    requestBackgroundPermission: async () => "background",
    start: async (profile) => {
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

interface TestActivity extends AppActivity {
  active: boolean;
  open(): Promise<void>;
}

function activity(): TestActivity {
  const listeners = new Set<() => void>();
  const app: TestActivity = {
    active: true,
    isActive: () => app.active,
    onActive: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: async () => {
      app.active = true;
      for (const listener of listeners) listener();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return app;
}

const cruise = profileFor("transit-cruise", "android");
const near = profileFor("transit-near-event", "android");

describe("withBackgroundSafeProfiles", () => {
  it("leaves iOS untouched", () => {
    const { driver } = platform();
    expect(withBackgroundSafeProfiles(driver, "ios", activity())).toBe(driver);
  });

  it("changes the profile at once while the app is active", async () => {
    const { state, driver } = platform();
    const safe = withBackgroundSafeProfiles(driver, "android", activity());
    await safe.start(cruise);
    await safe.start(near);
    expect(state.profile).toBe(near);
  });

  it("holds a background change back and applies the latest one when the app is opened", async () => {
    const { state, driver } = platform();
    const app = activity();
    const safe = withBackgroundSafeProfiles(driver, "android", app);
    await safe.start(cruise);
    app.active = false;

    await safe.start(near);
    await safe.start(profileFor("walking", "android"));
    expect(state.profile).toBe(cruise);
    expect(state.starts).toBe(1);

    await app.open();
    expect(state.profile).toEqual(profileFor("walking", "android"));
  });

  it("forgets a held change when the stream goes back to the profile it runs", async () => {
    const { state, driver } = platform();
    const app = activity();
    const safe = withBackgroundSafeProfiles(driver, "android", app);
    await safe.start(cruise);
    app.active = false;
    await safe.start(near);
    await safe.start(cruise);

    await app.open();
    expect(state.starts).toBe(1);
  });

  it("does not restart a stream that was stopped while the change was held", async () => {
    const { state, driver } = platform();
    const app = activity();
    const safe = withBackgroundSafeProfiles(driver, "android", app);
    await safe.start(cruise);
    app.active = false;
    await safe.start(near);
    await safe.stop();

    await app.open();
    expect(state.running).toBe(false);
    expect(state.starts).toBe(1);
  });

  it("passes a start of a stopped stream straight through", async () => {
    const { state, driver } = platform();
    const app = activity();
    app.active = false;
    const safe = withBackgroundSafeProfiles(driver, "android", app);
    await safe.start(cruise);
    expect(state.starts).toBe(1);
  });
});
