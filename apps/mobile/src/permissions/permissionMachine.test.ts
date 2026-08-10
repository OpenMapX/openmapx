import {
  ANDROID_BACKGROUND_VIA_SETTINGS_SDK,
  ANDROID_VISIBLE_START_SDK,
  type PermissionEvent,
  type PermissionFlowState,
  type PermissionPlatform,
  permissionReducer,
  requiresVisibleStart,
} from "./permissionMachine";

const IOS: PermissionPlatform = { os: "ios" };
const ANDROID_10: PermissionPlatform = { os: "android", sdkInt: 29 };
const ANDROID_14: PermissionPlatform = { os: "android", sdkInt: 34 };

/** Drives the reducer through a sequence, returning the last transition. */
function drive(
  platform: PermissionPlatform,
  events: readonly PermissionEvent[],
  from: PermissionFlowState = { state: "idle" },
) {
  let state = from;
  let effects: ReturnType<typeof permissionReducer>["effects"] = [];
  for (const event of events) {
    const transition = permissionReducer(state, event, platform);
    state = transition.state;
    effects = transition.effects;
  }
  return { state, effects };
}

const START: PermissionEvent = {
  type: "start-requested",
  current: { permission: "not-determined", canAskAgain: true },
};

describe("permissionReducer", () => {
  it("explains before it asks", () => {
    const { state, effects } = drive(IOS, [START]);

    expect(state).toEqual({ state: "explaining", requested: "background" });
    expect(effects).toEqual([{ kind: "show-disclosure" }]);
  });

  it("asks for nothing when background is already granted", () => {
    const { state, effects } = drive(IOS, [
      { type: "start-requested", current: { permission: "background", accuracy: "precise" } },
    ]);

    expect(state).toEqual({ state: "granted", mode: "background" });
    expect(effects).toEqual([{ kind: "resolved", mode: "background" }]);
  });

  it("does not prompt again once the user has permanently refused", () => {
    const { state, effects } = drive(IOS, [
      { type: "start-requested", current: { permission: "denied", canAskAgain: false } },
    ]);

    expect(state).toEqual({
      state: "settings-required",
      platform: "ios",
      reason: "cannot-escalate",
    });
    expect(effects).toEqual([{ kind: "open-settings" }]);
  });

  it("abandons the flow when the user dismisses the explanation", () => {
    const { state, effects } = drive(IOS, [START, { type: "disclosure-dismissed" }]);

    expect(state).toEqual({ state: "idle" });
    expect(effects).toEqual([{ kind: "rejected", reason: "dismissed" }]);
  });

  describe("iOS", () => {
    it("grants background through the escalation prompt", () => {
      const { state, effects } = drive(IOS, [
        START,
        { type: "disclosure-accepted" },
        { type: "foreground-result", result: { permission: "foreground", accuracy: "precise" } },
        { type: "background-result", result: { permission: "background", accuracy: "precise" } },
      ]);

      expect(state).toEqual({ state: "granted", mode: "background" });
      expect(effects).toEqual([{ kind: "resolved", mode: "background" }]);
    });

    it("routes Allow Once to settings, because there is no prompt left", () => {
      const { state, effects } = drive(IOS, [
        START,
        { type: "disclosure-accepted" },
        { type: "foreground-result", result: { permission: "limited", accuracy: "precise" } },
      ]);

      expect(state).toEqual({
        state: "settings-required",
        platform: "ios",
        reason: "cannot-escalate",
      });
      expect(effects).toEqual([{ kind: "open-settings" }]);
    });

    it("accepts a background grant made in settings", () => {
      const { state } = drive(
        IOS,
        [
          {
            type: "returned-from-settings",
            result: { permission: "background", accuracy: "precise" },
          },
        ],
        { state: "settings-required", platform: "ios", reason: "cannot-escalate" },
      );

      expect(state).toEqual({ state: "granted", mode: "background" });
    });

    it("offers the limited mode when settings only produced foreground access", () => {
      const { state, effects } = drive(
        IOS,
        [
          {
            type: "returned-from-settings",
            result: { permission: "foreground", accuracy: "precise" },
          },
        ],
        { state: "settings-required", platform: "ios", reason: "cannot-escalate" },
      );

      expect(state).toEqual({ state: "foreground-only-choice" });
      expect(effects).toEqual([{ kind: "offer-foreground-only" }]);
    });

    it("stops instead of reopening settings when nothing changed", () => {
      const { state, effects } = drive(
        IOS,
        [{ type: "returned-from-settings", result: { permission: "denied" } }],
        { state: "settings-required", platform: "ios", reason: "cannot-escalate" },
      );

      expect(state).toEqual({ state: "denied", canAskAgain: false });
      expect(effects).toEqual([{ kind: "rejected", reason: "denied" }]);
    });

    it("refuses a reduced-accuracy grant rather than guiding from it", () => {
      const { state, effects } = drive(IOS, [
        START,
        { type: "disclosure-accepted" },
        {
          type: "foreground-result",
          result: { permission: "foreground", accuracy: "approximate" },
        },
      ]);

      expect(state).toEqual({
        state: "settings-required",
        platform: "ios",
        reason: "precise-required",
      });
      expect(effects).toEqual([{ kind: "open-settings" }]);
    });

    it("does not accept approximate accuracy even when settings grant background", () => {
      const { state } = drive(
        IOS,
        [
          {
            type: "returned-from-settings",
            result: { permission: "background", accuracy: "approximate" },
          },
        ],
        { state: "settings-required", platform: "ios", reason: "precise-required" },
      );

      expect(state).toEqual({ state: "denied", canAskAgain: false });
    });

    it("offers the limited mode when the escalation prompt is declined", () => {
      const { state, effects } = drive(IOS, [
        START,
        { type: "disclosure-accepted" },
        { type: "foreground-result", result: { permission: "foreground", accuracy: "precise" } },
        { type: "background-result", result: { permission: "foreground", accuracy: "precise" } },
      ]);

      expect(state).toEqual({ state: "foreground-only-choice" });
      expect(effects).toEqual([{ kind: "offer-foreground-only" }]);
    });
  });

  describe("Android", () => {
    it("requests background directly on Android 10", () => {
      const { state, effects } = drive(ANDROID_10, [
        START,
        { type: "disclosure-accepted" },
        { type: "foreground-result", result: { permission: "foreground", accuracy: "precise" } },
      ]);

      expect(state).toEqual({ state: "requesting-background" });
      expect(effects).toEqual([{ kind: "request-background" }]);
    });

    it("routes to settings from Android 11 onwards, where the dialog does not exist", () => {
      for (const sdkInt of [ANDROID_BACKGROUND_VIA_SETTINGS_SDK, 33, 34, 36]) {
        const { state, effects } = drive({ os: "android", sdkInt }, [
          START,
          { type: "disclosure-accepted" },
          { type: "foreground-result", result: { permission: "foreground", accuracy: "precise" } },
        ]);

        expect(state).toEqual({
          state: "settings-required",
          platform: "android",
          reason: "background-in-settings",
        });
        expect(effects).toEqual([{ kind: "open-settings" }]);
      }
    });

    it("treats a coarse-only grant as unusable", () => {
      const { state } = drive(ANDROID_14, [
        START,
        { type: "disclosure-accepted" },
        {
          type: "foreground-result",
          result: { permission: "foreground", accuracy: "approximate" },
        },
      ]);

      expect(state).toEqual({
        state: "settings-required",
        platform: "android",
        reason: "precise-required",
      });
    });

    it("records that Android 14 needs a visible start", () => {
      expect(requiresVisibleStart({ os: "android", sdkInt: ANDROID_VISIBLE_START_SDK })).toBe(true);
      expect(requiresVisibleStart({ os: "android", sdkInt: 33 })).toBe(false);
      expect(requiresVisibleStart(IOS)).toBe(false);
    });

    it("reports a refused foreground request as denied, with whether it may ask again", () => {
      const { state, effects } = drive(ANDROID_14, [
        START,
        { type: "disclosure-accepted" },
        { type: "foreground-result", result: { permission: "denied", canAskAgain: false } },
      ]);

      expect(state).toEqual({ state: "denied", canAskAgain: false });
      expect(effects).toEqual([{ kind: "rejected", reason: "denied" }]);
    });
  });

  describe("foreground-only", () => {
    it("asks only for foreground when the user chooses the limited mode", () => {
      const { state, effects } = drive(ANDROID_14, [START, { type: "disclosure-foreground-only" }]);

      expect(state).toEqual({ state: "foreground-only-choice" });
      expect(effects).toEqual([{ kind: "request-foreground" }]);
    });

    it("grants the limited mode without ever requesting background", () => {
      const { state, effects } = drive(ANDROID_14, [
        START,
        { type: "disclosure-foreground-only" },
        { type: "foreground-result", result: { permission: "foreground", accuracy: "precise" } },
      ]);

      expect(state).toEqual({ state: "granted", mode: "foreground-only" });
      expect(effects).toEqual([{ kind: "resolved", mode: "foreground-only" }]);
    });

    it("refuses the limited mode when even foreground was denied", () => {
      const { state } = drive(ANDROID_14, [
        START,
        { type: "disclosure-foreground-only" },
        { type: "foreground-result", result: { permission: "denied", canAskAgain: true } },
      ]);

      expect(state).toEqual({ state: "denied", canAskAgain: true });
    });
  });

  describe("revocation", () => {
    it.each([
      ["granted", { state: "granted", mode: "background" }],
      ["explaining", { state: "explaining", requested: "background" }],
      ["requesting-background", { state: "requesting-background" }],
      [
        "settings-required",
        { state: "settings-required", platform: "ios", reason: "cannot-escalate" },
      ],
    ])("denies from %s without asking again", (_label, from) => {
      const { state, effects } = drive(IOS, [{ type: "revoked" }], from as PermissionFlowState);

      expect(state).toEqual({ state: "denied", canAskAgain: false });
      expect(effects).toEqual([{ kind: "rejected", reason: "denied" }]);
    });
  });

  it("never emits two OS prompts from one transition", () => {
    const prompts = new Set(["request-foreground", "request-background", "open-settings"]);
    const events: PermissionEvent[] = [
      START,
      { type: "disclosure-accepted" },
      { type: "foreground-result", result: { permission: "foreground", accuracy: "precise" } },
      { type: "background-result", result: { permission: "foreground", accuracy: "precise" } },
    ];

    let state: PermissionFlowState = { state: "idle" };
    for (const event of events) {
      const transition = permissionReducer(state, event, IOS);
      state = transition.state;
      expect(transition.effects.filter((effect) => prompts.has(effect.kind))).toHaveLength(
        transition.effects.some((effect) => prompts.has(effect.kind)) ? 1 : 0,
      );
    }
  });

  it("ignores an event that does not belong to the current state", () => {
    const { state, effects } = drive(IOS, [
      { type: "background-result", result: { permission: "background" } },
    ]);

    expect(state).toEqual({ state: "idle" });
    expect(effects).toEqual([]);
  });

  it("abandons the flow when the app stops being visible mid-explanation", () => {
    const { state, effects } = drive(ANDROID_14, [START, { type: "app-not-visible" }]);

    expect(state).toEqual({ state: "idle" });
    expect(effects).toEqual([{ kind: "rejected", reason: "not-visible" }]);
  });
});
