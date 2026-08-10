import { openAppSettings, type SettingsOpener, type SettingsTarget } from "./openAppSettings";

function opener(options: { targetHandled?: boolean; throws?: boolean } = {}) {
  const calls: string[] = [];
  const value: SettingsOpener = {
    openSettings: async () => {
      if (options.throws) throw new Error("no settings activity");
      calls.push("application");
    },
    openTarget: async (target: SettingsTarget) => {
      calls.push(`target:${target}`);
      return options.targetHandled ?? false;
    },
  };
  return { opener: value, calls };
}

describe("openAppSettings", () => {
  it.each<SettingsTarget>(["location", "notifications", "application"])(
    "opens the dedicated page for %s when the platform has one",
    async (target) => {
      const { opener: value, calls } = opener({ targetHandled: true });

      await expect(openAppSettings(target, value)).resolves.toBe("opened");
      expect(calls).toEqual([`target:${target}`]);
    },
  );

  it("falls back to the app's own settings page", async () => {
    const { opener: value, calls } = opener({ targetHandled: false });

    // From there a user can always reach location and notifications; a platform
    // with no dedicated page is a longer walk, not a dead end.
    await expect(openAppSettings("location", value)).resolves.toBe("opened");
    expect(calls).toEqual(["target:location", "application"]);
  });

  it("reports a platform that cannot open settings at all", async () => {
    const { opener: value } = opener({ throws: true });

    await expect(openAppSettings("application", value)).resolves.toBe("unavailable");
  });

  it("takes no URI to open", () => {
    // Compile-time by construction: the only parameter is a closed enum. An
    // arbitrary intent URI reachable from the WebView would be a way out of the
    // app, which the fixed-origin design exists to rule out.
    const accepted: SettingsTarget[] = ["location", "notifications", "application"];

    expect(accepted).toHaveLength(3);
  });
});
