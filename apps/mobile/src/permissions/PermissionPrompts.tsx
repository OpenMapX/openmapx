import { type ReactElement, useSyncExternalStore } from "react";
import { Alert, AppState, Linking } from "react-native";
import type { MobileLocale } from "../../config/nativeCopy";
import { PermissionDisclosure, PermissionOutcome } from "./PermissionDisclosure";
import type { PermissionUi } from "./permissionController";
import { permissionCopy } from "./permissionCopy";
import type { PermissionFlowState } from "./permissionMachine";

/**
 * The permission flow's screens, driven by the controller.
 *
 * The controller awaits each step; this turns those awaits into whichever
 * native screen is showing, and resolves them from the user's tap. Only one
 * prompt can be pending, because the controller runs one effect at a time.
 */

type Pending =
  | { kind: "disclosure"; resolve: (choice: "accept" | "foreground-only" | "dismiss") => void }
  | {
      kind: "settings";
      state: Extract<PermissionFlowState, { state: "settings-required" }>;
      resolve: (choice: "returned" | "dismiss") => void;
    }
  | {
      kind: "denied";
      state: Extract<PermissionFlowState, { state: "denied" }>;
      resolve: () => void;
    };

export interface PermissionPrompter {
  ui: PermissionUi;
  current(): Pending | null;
  subscribe(listener: () => void): () => void;
}

export interface PermissionPrompterOptions {
  locale: MobileLocale;
  /** Injected for tests. */
  openSettings?: () => Promise<void>;
  waitForReturn?: () => Promise<void>;
  confirm?: (title: string, body: string, accept: string, decline: string) => Promise<boolean>;
  /**
   * The background-location request. On Android 11 and later the system
   * answers it by opening the app's location permission page, the one with
   * "Allow all the time", and returns once the user leaves it, which is a
   * shorter way there than the app's general settings page.
   */
  requestBackgroundAccess?: () => Promise<unknown>;
}

/** Resolves once the app has left the foreground and come back. */
export function waitForAppReturn(maxWaitMs = 10 * 60_000): Promise<void> {
  return new Promise((resolve) => {
    let left = AppState.currentState !== "active";
    const done = () => {
      clearTimeout(timer);
      subscription.remove();
      resolve();
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") left = true;
      else if (left) done();
    });
    // Settings that never open (or a user who never comes back) must not hold
    // the start flow forever.
    const timer = setTimeout(done, maxWaitMs);
  });
}

function nativeConfirm(
  title: string,
  body: string,
  accept: string,
  decline: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      body,
      [
        { text: decline, style: "cancel", onPress: () => resolve(false) },
        { text: accept, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export function createPermissionPrompter(options: PermissionPrompterOptions): PermissionPrompter {
  let pending: Pending | null = null;
  let settingsReason:
    | Extract<PermissionFlowState, { state: "settings-required" }>["reason"]
    | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Pending | null) => {
    pending = next;
    for (const listener of listeners) listener();
  };
  const text = (key: Parameters<typeof permissionCopy>[1]) => permissionCopy(options.locale, key);

  const ui: PermissionUi = {
    showDisclosure: () =>
      new Promise((resolve) =>
        set({
          kind: "disclosure",
          resolve: (choice) => {
            set(null);
            resolve(choice);
          },
        }),
      ),
    showSettingsRequired: (state) => {
      settingsReason = state.reason;
      return new Promise((resolve) =>
        set({
          kind: "settings",
          state,
          resolve: (choice) => {
            set(null);
            resolve(choice);
          },
        }),
      );
    },
    offerForegroundOnly: async () => {
      const accepted = await (options.confirm ?? nativeConfirm)(
        text("foregroundOnly"),
        text("foregroundOnlyNote"),
        text("continue"),
        text("notNow"),
      );
      return accepted ? "accept" : "dismiss";
    },
    showDenied: (state) =>
      new Promise((resolve) =>
        set({
          kind: "denied",
          state,
          resolve: () => {
            set(null);
            resolve();
          },
        }),
      ),
    openSystemSettings: async () => {
      if (settingsReason === "background-in-settings" && options.requestBackgroundAccess) {
        try {
          await options.requestBackgroundAccess();
          return;
        } catch {
          // Fall back to the general settings page.
        }
      }
      // `openSettings` resolves as soon as the settings screen opens; the
      // controller reads the grant back afterwards, so wait for the user to
      // return first.
      const returned = (options.waitForReturn ?? waitForAppReturn)();
      try {
        await (options.openSettings ?? (() => Linking.openSettings()))();
      } catch {
        return;
      }
      await returned;
    },
  };

  return {
    ui,
    current: () => pending,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function PermissionPrompts({
  prompter,
  locale,
}: {
  prompter: PermissionPrompter;
  locale: MobileLocale;
}): ReactElement | null {
  const pending = useSyncExternalStore(prompter.subscribe, prompter.current, prompter.current);
  if (!pending) return null;

  switch (pending.kind) {
    case "disclosure":
      return (
        <PermissionDisclosure
          locale={locale}
          onAccept={() => pending.resolve("accept")}
          onForegroundOnly={() => pending.resolve("foreground-only")}
          onDismiss={() => pending.resolve("dismiss")}
        />
      );
    case "settings":
      return (
        <PermissionOutcome
          locale={locale}
          state={pending.state}
          onOpenSettings={() => pending.resolve("returned")}
          onDismiss={() => pending.resolve("dismiss")}
        />
      );
    case "denied":
      return (
        <PermissionOutcome
          locale={locale}
          state={pending.state}
          onOpenSettings={() => pending.resolve()}
          onDismiss={() => pending.resolve()}
        />
      );
  }
}
