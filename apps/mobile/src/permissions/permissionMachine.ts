import type { LocationPermissionState } from "../location/LocationDriver";

/**
 * The deliberate path from "the user tapped Start" to "the app may track".
 *
 * It is a reducer rather than a sequence of awaited calls for one reason: the
 * operating systems disagree about what is even possible, and every difference
 * has to be visible and testable rather than buried in control flow.
 *
 *  - iOS grants "When In Use" first and will show the "Always" upgrade prompt
 *    exactly once. After "Allow Once" there is no prompt left to show.
 *  - Android 10 accepts a direct background request; Android 11 and later never
 *    show that dialog, so the only honest move is to send the user to Settings.
 *  - iOS 14 and later may grant a reduced-accuracy location, which cannot drive
 *    turn-by-turn guidance at all.
 *
 * The reducer is pure and never loops a prompt by itself. A controller executes
 * one effect, feeds the result back, and stops if the answer is no — the user
 * saying no must not produce a second dialog.
 */

export type PermissionPlatform = { os: "ios" } | { os: "android"; sdkInt: number };

/** The first Android release that removed the in-app background dialog. */
export const ANDROID_BACKGROUND_VIA_SETTINGS_SDK = 30;
/** The first Android release that refuses to start a location service from the background. */
export const ANDROID_VISIBLE_START_SDK = 34;

export type SettingsReason =
  /** iOS "Allow Once", or a background request that can no longer be prompted. */
  | "cannot-escalate"
  /** Android 11 and later: background is only grantable in system settings. */
  | "background-in-settings"
  /** A reduced-accuracy grant, which cannot drive turn-by-turn guidance. */
  | "precise-required";

export type PermissionFlowState =
  | { state: "idle" }
  | { state: "explaining"; requested: "background" }
  | { state: "requesting-foreground" }
  | { state: "requesting-background" }
  | { state: "settings-required"; platform: "ios" | "android"; reason: SettingsReason }
  | { state: "foreground-only-choice" }
  | { state: "granted"; mode: "background" | "foreground-only" }
  | { state: "denied"; canAskAgain: boolean };

export interface PermissionSnapshot {
  permission: LocationPermissionState;
  /** iOS 14+ and Android 12+ may grant a coarse location instead. */
  accuracy?: "precise" | "approximate";
  canAskAgain?: boolean;
}

export type PermissionEvent =
  /** The user asked to start navigation while the app was visible. */
  | { type: "start-requested"; current: PermissionSnapshot }
  | { type: "disclosure-accepted" }
  | { type: "disclosure-foreground-only" }
  | { type: "disclosure-dismissed" }
  | { type: "foreground-result"; result: PermissionSnapshot }
  | { type: "background-result"; result: PermissionSnapshot }
  | { type: "returned-from-settings"; result: PermissionSnapshot }
  | { type: "app-not-visible" }
  | { type: "revoked" };

export type PermissionEffect =
  | { kind: "show-disclosure" }
  | { kind: "request-foreground" }
  | { kind: "request-background" }
  | { kind: "open-settings" }
  | { kind: "offer-foreground-only" }
  | { kind: "resolved"; mode: "background" | "foreground-only" }
  | { kind: "rejected"; reason: "denied" | "dismissed" | "not-visible" };

export interface PermissionTransition {
  state: PermissionFlowState;
  effects: PermissionEffect[];
}

const IDLE: PermissionFlowState = { state: "idle" };

function platformName(platform: PermissionPlatform): "ios" | "android" {
  return platform.os;
}

/** Android 11+ can only reach "Allow all the time" through system settings. */
function backgroundNeedsSettings(platform: PermissionPlatform): boolean {
  return platform.os === "android" && platform.sdkInt >= ANDROID_BACKGROUND_VIA_SETTINGS_SDK;
}

function settingsRequired(
  platform: PermissionPlatform,
  reason: SettingsReason,
): PermissionTransition {
  return {
    state: { state: "settings-required", platform: platformName(platform), reason },
    effects: [{ kind: "open-settings" }],
  };
}

/**
 * Decides what to do once a foreground grant is in hand.
 *
 * Reduced accuracy is treated as a hard stop rather than a degraded mode: a
 * coarse fix cannot tell which street the user is on, and guiding from it would
 * be worse than admitting the app cannot.
 */
function afterForeground(
  platform: PermissionPlatform,
  result: PermissionSnapshot,
): PermissionTransition {
  if (result.accuracy === "approximate") {
    return settingsRequired(platform, "precise-required");
  }
  if (result.permission === "limited") {
    // iOS "Allow Once": usable now, but there is no prompt left to escalate it.
    return settingsRequired(platform, "cannot-escalate");
  }
  if (result.permission === "background") {
    return {
      state: { state: "granted", mode: "background" },
      effects: [{ kind: "resolved", mode: "background" }],
    };
  }
  if (result.permission !== "foreground") {
    return {
      state: { state: "denied", canAskAgain: result.canAskAgain ?? false },
      effects: [{ kind: "rejected", reason: "denied" }],
    };
  }
  if (backgroundNeedsSettings(platform)) {
    return settingsRequired(platform, "background-in-settings");
  }
  return { state: { state: "requesting-background" }, effects: [{ kind: "request-background" }] };
}

export function permissionReducer(
  state: PermissionFlowState,
  event: PermissionEvent,
  platform: PermissionPlatform,
): PermissionTransition {
  // Revocation applies from any state, because the user can change their mind
  // in system settings while the app is not even in the foreground.
  if (event.type === "revoked") {
    return {
      state: { state: "denied", canAskAgain: false },
      effects: [{ kind: "rejected", reason: "denied" }],
    };
  }

  switch (state.state) {
    case "idle":
    case "granted":
    case "denied":
      if (event.type !== "start-requested") return { state, effects: [] };
      // A previously granted background permission needs no explanation and no
      // prompt: re-asking would be a dialog the user cannot connect to anything.
      if (event.current.accuracy === "approximate") {
        return settingsRequired(platform, "precise-required");
      }
      if (event.current.permission === "background") {
        return {
          state: { state: "granted", mode: "background" },
          effects: [{ kind: "resolved", mode: "background" }],
        };
      }
      if (event.current.permission === "denied" && event.current.canAskAgain === false) {
        return settingsRequired(platform, "cannot-escalate");
      }
      return {
        state: { state: "explaining", requested: "background" },
        effects: [{ kind: "show-disclosure" }],
      };

    case "explaining":
      if (event.type === "disclosure-accepted") {
        return {
          state: { state: "requesting-foreground" },
          effects: [{ kind: "request-foreground" }],
        };
      }
      if (event.type === "disclosure-foreground-only") {
        return {
          state: { state: "foreground-only-choice" },
          effects: [{ kind: "request-foreground" }],
        };
      }
      if (event.type === "disclosure-dismissed") {
        return { state: IDLE, effects: [{ kind: "rejected", reason: "dismissed" }] };
      }
      if (event.type === "app-not-visible") {
        return { state: IDLE, effects: [{ kind: "rejected", reason: "not-visible" }] };
      }
      return { state, effects: [] };

    case "requesting-foreground":
      if (event.type !== "foreground-result") return { state, effects: [] };
      return afterForeground(platform, event.result);

    case "foreground-only-choice": {
      if (event.type !== "foreground-result") return { state, effects: [] };
      const usable =
        event.result.accuracy !== "approximate" &&
        ["foreground", "background", "limited"].includes(event.result.permission);
      if (!usable) {
        return {
          state: { state: "denied", canAskAgain: event.result.canAskAgain ?? false },
          effects: [{ kind: "rejected", reason: "denied" }],
        };
      }
      return {
        state: { state: "granted", mode: "foreground-only" },
        effects: [{ kind: "resolved", mode: "foreground-only" }],
      };
    }

    case "requesting-background": {
      if (event.type !== "background-result") return { state, effects: [] };
      if (event.result.permission === "background") {
        return {
          state: { state: "granted", mode: "background" },
          effects: [{ kind: "resolved", mode: "background" }],
        };
      }
      // The user declined the upgrade but still has foreground access, so the
      // honest offer is the limited mode rather than a second prompt.
      if (["foreground", "limited"].includes(event.result.permission)) {
        return {
          state: { state: "foreground-only-choice" },
          effects: [{ kind: "offer-foreground-only" }],
        };
      }
      return {
        state: { state: "denied", canAskAgain: event.result.canAskAgain ?? false },
        effects: [{ kind: "rejected", reason: "denied" }],
      };
    }

    case "settings-required": {
      if (event.type !== "returned-from-settings") return { state, effects: [] };
      if (event.result.accuracy === "approximate") {
        return {
          state: { state: "denied", canAskAgain: false },
          effects: [{ kind: "rejected", reason: "denied" }],
        };
      }
      if (event.result.permission === "background") {
        return {
          state: { state: "granted", mode: "background" },
          effects: [{ kind: "resolved", mode: "background" }],
        };
      }
      if (["foreground", "limited"].includes(event.result.permission)) {
        return {
          state: { state: "foreground-only-choice" },
          effects: [{ kind: "offer-foreground-only" }],
        };
      }
      // Nothing changed in settings. Stop rather than reopening them in a loop.
      return {
        state: { state: "denied", canAskAgain: false },
        effects: [{ kind: "rejected", reason: "denied" }],
      };
    }
  }
}

/** Whether this platform refuses to start a location service from the background. */
export function requiresVisibleStart(platform: PermissionPlatform): boolean {
  return platform.os === "android" && platform.sdkInt >= ANDROID_VISIBLE_START_SDK;
}
