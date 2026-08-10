/**
 * The alighting-alert permission, kept deliberately apart from location.
 *
 * These are two different asks with two different consequences, and bundling
 * them would make both worse. Location is what navigation *needs*; a
 * notification is a safety backup for when speech is missed. A rider who
 * declines the notification should still get guidance, and a rider who declines
 * location should not have been asked about notifications at all.
 *
 * So: asked only in transit context, only after its own explanation, only once,
 * and never as a precondition for starting.
 */

export type NotificationPermissionState = "not-determined" | "granted" | "denied";

export type AlightAlertAvailability = "available" | "denied" | "disabled";

export type NotificationFlowState =
  | { state: "idle" }
  | { state: "explaining" }
  | { state: "requesting" }
  | { state: "granted" }
  | { state: "denied"; canAskAgain: boolean };

export type NotificationEvent =
  | {
      type: "transit-start-requested";
      current: NotificationPermissionState;
      alertsEnabled: boolean;
    }
  | { type: "disclosure-accepted" }
  | { type: "disclosure-declined" }
  | { type: "result"; state: NotificationPermissionState; canAskAgain: boolean };

export type NotificationEffect =
  | { kind: "show-disclosure" }
  | { kind: "request-permission" }
  /** The flow finished; navigation proceeds either way. */
  | { kind: "resolved"; availability: AlightAlertAvailability };

export interface NotificationTransition {
  state: NotificationFlowState;
  effects: NotificationEffect[];
}

/**
 * Decides what to do about notifications when a transit session starts.
 *
 * Every path ends in `resolved`, because none of them may block navigation. The
 * availability it resolves to is what the snapshot reports, so the page can say
 * plainly that the backup is unavailable rather than implying it is armed.
 */
export function notificationReducer(
  state: NotificationFlowState,
  event: NotificationEvent,
): NotificationTransition {
  switch (state.state) {
    case "idle":
    case "granted":
    case "denied": {
      if (event.type !== "transit-start-requested") return { state, effects: [] };

      // The rider turned the backup off themselves; asking would be noise.
      if (!event.alertsEnabled) {
        return { state, effects: [{ kind: "resolved", availability: "disabled" }] };
      }
      if (event.current === "granted") {
        return {
          state: { state: "granted" },
          effects: [{ kind: "resolved", availability: "available" }],
        };
      }
      // Already refused: never ask again on its own.
      if (event.current === "denied") {
        return {
          state: { state: "denied", canAskAgain: false },
          effects: [{ kind: "resolved", availability: "denied" }],
        };
      }
      return { state: { state: "explaining" }, effects: [{ kind: "show-disclosure" }] };
    }

    case "explaining": {
      if (event.type === "disclosure-accepted") {
        return { state: { state: "requesting" }, effects: [{ kind: "request-permission" }] };
      }
      if (event.type === "disclosure-declined") {
        // Declining the explanation is a decision, not a permission refusal, so
        // the operating system is never asked at all.
        return {
          state: { state: "denied", canAskAgain: true },
          effects: [{ kind: "resolved", availability: "denied" }],
        };
      }
      return { state, effects: [] };
    }

    case "requesting": {
      if (event.type !== "result") return { state, effects: [] };
      if (event.state === "granted") {
        return {
          state: { state: "granted" },
          effects: [{ kind: "resolved", availability: "available" }],
        };
      }
      return {
        state: { state: "denied", canAskAgain: event.canAskAgain },
        effects: [{ kind: "resolved", availability: "denied" }],
      };
    }
  }
}

/** What a resolved flow means for the session's snapshot. */
export function availabilityFor(
  state: NotificationFlowState,
  alertsEnabled: boolean,
): AlightAlertAvailability {
  if (!alertsEnabled) return "disabled";
  return state.state === "granted" ? "available" : "denied";
}
