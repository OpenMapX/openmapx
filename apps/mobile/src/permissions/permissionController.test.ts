import type { LocationDriver, LocationPermissionState } from "../location/LocationDriver";
import { PermissionController, type PermissionUi } from "./permissionController";
import type { PermissionPlatform, PermissionSnapshot } from "./permissionMachine";

function harness(options: {
  platform: PermissionPlatform;
  /** Each entry is the grant observed after the next request. */
  snapshots: PermissionSnapshot[];
  ui?: Partial<PermissionUi>;
  isAppActive?: boolean;
}) {
  const calls: string[] = [];
  let index = 0;

  const driver = {
    getPermissionState: async () => "not-determined" as LocationPermissionState,
    requestForegroundPermission: async () => {
      calls.push("request-foreground");
      return "foreground" as LocationPermissionState;
    },
    requestBackgroundPermission: async () => {
      calls.push("request-background");
      return "background" as LocationPermissionState;
    },
    start: async () => undefined,
    stop: async () => undefined,
    isRunning: async () => false,
    getCurrentFix: async () => null,
  } satisfies LocationDriver;

  const ui: PermissionUi = {
    showDisclosure: async () => {
      calls.push("disclosure");
      return "accept";
    },
    showSettingsRequired: async () => {
      calls.push("settings-required");
      return "returned";
    },
    offerForegroundOnly: async () => {
      calls.push("offer-foreground-only");
      return "accept";
    },
    showDenied: async () => {
      calls.push("denied");
    },
    openSystemSettings: async () => {
      calls.push("open-settings");
    },
    ...options.ui,
  };

  const controller = new PermissionController({
    driver,
    platform: options.platform,
    ui,
    isAppActive: () => options.isAppActive !== false,
    snapshot: async () => {
      const snapshot = options.snapshots[Math.min(index, options.snapshots.length - 1)];
      index += 1;
      return snapshot;
    },
  });

  return { controller, calls };
}

const IOS: PermissionPlatform = { os: "ios" };
const ANDROID_14: PermissionPlatform = { os: "android", sdkInt: 34 };

describe("PermissionController", () => {
  it("explains, then requests foreground, then requests background", async () => {
    const { controller, calls } = harness({
      platform: IOS,
      snapshots: [
        { permission: "not-determined", canAskAgain: true },
        { permission: "foreground", accuracy: "precise" },
        { permission: "background", accuracy: "precise" },
      ],
    });

    await expect(controller.requestForStart()).resolves.toBe("background");
    expect(calls).toEqual(["disclosure", "request-foreground", "request-background"]);
  });

  it("never requests background when the user chose the limited mode", async () => {
    const { controller, calls } = harness({
      platform: ANDROID_14,
      snapshots: [
        { permission: "not-determined", canAskAgain: true },
        { permission: "foreground", accuracy: "precise" },
      ],
      ui: { showDisclosure: async () => "foreground-only" },
    });

    await expect(controller.requestForStart()).resolves.toBe("foreground-only");
    expect(calls).not.toContain("request-background");
  });

  it("stops at the disclosure when the user declines", async () => {
    const { controller, calls } = harness({
      platform: IOS,
      snapshots: [{ permission: "not-determined", canAskAgain: true }],
      ui: { showDisclosure: async () => "dismiss" },
    });

    await expect(controller.requestForStart()).resolves.toBe("denied");
    // Declining the explanation must reach no operating-system prompt at all.
    expect(calls).toEqual([]);
  });

  it("refuses without any prompt when the app is not visible", async () => {
    const { controller, calls } = harness({
      platform: ANDROID_14,
      snapshots: [{ permission: "not-determined" }],
      isAppActive: false,
    });

    await expect(controller.requestForStart()).resolves.toBe("denied");
    expect(calls).toEqual([]);
  });

  it("routes Android 11+ background through system settings", async () => {
    const { controller, calls } = harness({
      platform: ANDROID_14,
      snapshots: [
        { permission: "not-determined", canAskAgain: true },
        { permission: "foreground", accuracy: "precise" },
        { permission: "background", accuracy: "precise" },
      ],
    });

    await expect(controller.requestForStart()).resolves.toBe("background");
    expect(calls).toEqual([
      "disclosure",
      "request-foreground",
      "settings-required",
      "open-settings",
    ]);
    expect(calls).not.toContain("request-background");
  });

  it("does not open settings when the user declines that route", async () => {
    const { controller, calls } = harness({
      platform: ANDROID_14,
      snapshots: [
        { permission: "not-determined", canAskAgain: true },
        { permission: "foreground", accuracy: "precise" },
      ],
      ui: { showSettingsRequired: async () => "dismiss" },
    });

    await expect(controller.requestForStart()).resolves.toBe("denied");
    expect(calls).not.toContain("open-settings");
  });

  it("requests each operating-system permission at most once per attempt", async () => {
    const { controller, calls } = harness({
      platform: IOS,
      snapshots: [
        { permission: "not-determined", canAskAgain: true },
        { permission: "foreground", accuracy: "precise" },
        // The upgrade was declined, and the user then declines the limited mode.
        { permission: "foreground", accuracy: "precise" },
      ],
      ui: { offerForegroundOnly: async () => "dismiss" },
    });

    await expect(controller.requestForStart()).resolves.toBe("denied");
    expect(calls.filter((call) => call === "request-foreground")).toHaveLength(1);
    expect(calls.filter((call) => call === "request-background")).toHaveLength(1);
  });

  it("reports a reduced-accuracy grant instead of navigating with it", async () => {
    const { controller, calls } = harness({
      platform: IOS,
      snapshots: [
        { permission: "not-determined", canAskAgain: true },
        { permission: "foreground", accuracy: "approximate" },
        { permission: "foreground", accuracy: "approximate" },
      ],
    });

    await expect(controller.requestForStart()).resolves.toBe("denied");
    expect(calls).toContain("settings-required");
  });

  it("shows the denied screen once and asks for nothing more", async () => {
    const { controller, calls } = harness({
      platform: ANDROID_14,
      snapshots: [
        { permission: "not-determined", canAskAgain: true },
        { permission: "denied", canAskAgain: false },
      ],
    });

    await expect(controller.requestForStart()).resolves.toBe("denied");
    expect(calls.filter((call) => call === "denied")).toHaveLength(1);
    expect(controller.current()).toEqual({ state: "denied", canAskAgain: false });
  });

  it("re-reads the grant on a second attempt rather than reusing the outcome", async () => {
    const { controller, calls } = harness({
      platform: IOS,
      snapshots: [
        { permission: "not-determined", canAskAgain: true },
        { permission: "denied", canAskAgain: true },
        // The user granted it in settings between the two attempts.
        { permission: "background", accuracy: "precise" },
      ],
    });

    await expect(controller.requestForStart()).resolves.toBe("denied");
    await expect(controller.requestForStart()).resolves.toBe("background");
    expect(calls.filter((call) => call === "disclosure")).toHaveLength(1);
  });

  it("moves to denied when a revocation is observed", () => {
    const { controller } = harness({ platform: IOS, snapshots: [{ permission: "background" }] });

    controller.revoke();

    expect(controller.current()).toEqual({ state: "denied", canAskAgain: false });
  });
});
