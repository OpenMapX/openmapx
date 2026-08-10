import type { LocationDriver } from "../location/LocationDriver";
import {
  type PermissionEffect,
  type PermissionEvent,
  type PermissionFlowState,
  type PermissionPlatform,
  type PermissionSnapshot,
  permissionReducer,
} from "./permissionMachine";

/**
 * Executes the permission flow's effects exactly once each, and feeds the
 * result back in.
 *
 * The reducer decides; this executes. Keeping them apart is what makes the
 * "never loop a prompt" rule checkable: the controller runs one effect per
 * transition and then waits for a user or operating-system answer, so there is
 * no path that can re-enter a request on its own.
 */

export interface PermissionUi {
  /** Shows the native disclosure and resolves with the user's choice. */
  showDisclosure(): Promise<"accept" | "foreground-only" | "dismiss">;
  /** Shows the settings route and resolves once the user comes back or leaves. */
  showSettingsRequired(
    state: Extract<PermissionFlowState, { state: "settings-required" }>,
  ): Promise<"returned" | "dismiss">;
  /** Offers the limited mode after a declined upgrade. */
  offerForegroundOnly(): Promise<"accept" | "dismiss">;
  /** Reports the final refusal; purely informational. */
  showDenied(state: Extract<PermissionFlowState, { state: "denied" }>): Promise<void>;
  openSystemSettings(): Promise<void>;
}

export interface PermissionControllerDeps {
  driver: LocationDriver;
  platform: PermissionPlatform;
  ui: PermissionUi;
  isAppActive: () => boolean;
  /** Reads the current grant, including whether it is precise. */
  snapshot: () => Promise<PermissionSnapshot>;
}

export type PermissionOutcome = "background" | "foreground-only" | "denied";

/** Guards against a malformed transition table turning into an endless flow. */
const MAX_TRANSITIONS = 12;

export class PermissionController {
  private state: PermissionFlowState = { state: "idle" };

  constructor(private readonly deps: PermissionControllerDeps) {}

  current(): PermissionFlowState {
    return this.state;
  }

  /** Applies a revocation observed elsewhere, without prompting. */
  revoke(): void {
    this.state = permissionReducer(this.state, { type: "revoked" }, this.deps.platform).state;
  }

  /**
   * Runs the flow for an explicit navigation start.
   *
   * Always begins from `idle`: a previous outcome must not shortcut a new
   * request, because the user may have changed the grant in system settings
   * since it was recorded.
   */
  async requestForStart(): Promise<PermissionOutcome> {
    if (!this.deps.isAppActive()) return "denied";

    this.state = { state: "idle" };
    let event: PermissionEvent = { type: "start-requested", current: await this.deps.snapshot() };

    for (let step = 0; step < MAX_TRANSITIONS; step += 1) {
      const transition = permissionReducer(this.state, event, this.deps.platform);
      this.state = transition.state;

      const next = await this.perform(transition.effects);
      if (next.done) return next.outcome;
      event = next.event;
    }
    return "denied";
  }

  private async perform(
    effects: readonly PermissionEffect[],
  ): Promise<{ done: true; outcome: PermissionOutcome } | { done: false; event: PermissionEvent }> {
    for (const effect of effects) {
      switch (effect.kind) {
        case "resolved":
          return { done: true, outcome: effect.mode };
        case "rejected":
          if (this.state.state === "denied") await this.deps.ui.showDenied(this.state);
          return { done: true, outcome: "denied" };

        case "show-disclosure": {
          const choice = await this.deps.ui.showDisclosure();
          if (choice === "accept") return { done: false, event: { type: "disclosure-accepted" } };
          if (choice === "foreground-only") {
            return { done: false, event: { type: "disclosure-foreground-only" } };
          }
          return { done: false, event: { type: "disclosure-dismissed" } };
        }

        case "request-foreground": {
          await this.deps.driver.requestForegroundPermission();
          // Read the grant back rather than trusting the request's return value:
          // only a fresh read reports whether the grant is precise.
          return {
            done: false,
            event: { type: "foreground-result", result: await this.deps.snapshot() },
          };
        }

        case "request-background": {
          await this.deps.driver.requestBackgroundPermission();
          return {
            done: false,
            event: { type: "background-result", result: await this.deps.snapshot() },
          };
        }

        case "open-settings": {
          const settingsState = this.state;
          if (settingsState.state !== "settings-required") break;
          const outcome = await this.deps.ui.showSettingsRequired(settingsState);
          if (outcome === "dismiss") return { done: true, outcome: "denied" };
          await this.deps.ui.openSystemSettings();
          return {
            done: false,
            event: { type: "returned-from-settings", result: await this.deps.snapshot() },
          };
        }

        case "offer-foreground-only": {
          const choice = await this.deps.ui.offerForegroundOnly();
          if (choice === "dismiss") return { done: true, outcome: "denied" };
          return {
            done: false,
            event: { type: "foreground-result", result: await this.deps.snapshot() },
          };
        }
      }
    }
    // No effect asked for anything, so there is nothing left to wait for.
    return { done: true, outcome: "denied" };
  }
}
