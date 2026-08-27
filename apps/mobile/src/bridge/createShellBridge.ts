import type { WebToNativeMessage } from "@openmapx/core/navigation";
import { nativeApplicationVersion, nativeBuildVersion } from "expo-application";
import { Platform } from "react-native";
import { ChannelRegistry } from "./channel";
import { NativeBridge, type ShellDescription } from "./nativeBridge";

/**
 * Production composition of the bridge.
 *
 * Kept apart from `App` so the transport can be exercised without a renderer,
 * and so the shell description has exactly one definition — a capability
 * reported here that no processor implements would be a promise the page would
 * act on.
 */

export interface ShellBridgeOptions {
  webOrigin: string;
  inject: (script: string) => void;
  /**
   * Handles a fully validated command.
   *
   * Optional so the transport can stand alone; a shell without it rejects
   * commands with a correlated `unsupported-capability` response while it also
   * reports every capability as false.
   */
  dispatch?: (message: WebToNativeMessage) => Promise<unknown>;
  /** Reports what the shell can actually run right now. */
  capabilities?: () => ShellDescription["capabilities"];
  permission?: () => Promise<ShellDescription["permission"]>;
  activeSession?: () => Promise<ShellDescription["activeSession"]>;
}

export interface ShellBridge {
  registry: ChannelRegistry;
  bridge: NativeBridge;
}

/**
 * What the shell can actually do right now.
 *
 * A capability reported here is a promise the page will act on, so ground and
 * transit are answered from what is genuinely registered rather than from a
 * constant. Until a processor exists the page keeps planning in the browser.
 */
export async function describeShell(options: ShellBridgeOptions): Promise<ShellDescription> {
  const capabilities = options.capabilities?.() ?? {
    groundNavigation: false,
    transitNavigation: false,
    backgroundLocation: false,
    localNotifications: false,
    speech: false,
  };
  return {
    shellVersion: nativeApplicationVersion ?? "0.0.0",
    shellBuild: nativeBuildVersion ?? "0",
    platform: Platform.OS === "android" ? "android" : "ios",
    capabilities,
    permission: (await options.permission?.()) ?? "not-determined",
    locationDriver: "expo",
    activeSession: (await options.activeSession?.()) ?? null,
  };
}

export function createShellBridge(options: ShellBridgeOptions): ShellBridge {
  const registry = new ChannelRegistry();
  let messageCounter = 0;

  let bridge: NativeBridge;
  bridge = new NativeBridge({
    webOrigin: options.webOrigin,
    registry,
    now: () => Date.now(),
    // Unique within one shell process, which is all a correlation id needs to
    // be — it is never a secret and never addresses anything.
    nextMessageId: () => {
      messageCounter += 1;
      return `n${messageCounter}-${Date.now().toString(36)}`;
    },
    inject: options.inject,
    dispatch: async (message) => {
      if (options.dispatch) {
        await options.dispatch(message);
        return;
      }
      // A command from a stale or unexpected page must get an explicit answer.
      // Silently accepting it leaves the caller waiting for a timeout and makes
      // an uncomposed capability look like a broken implementation.
      if (message.type !== "event.ack") {
        bridge.send(
          "native.error",
          { code: "unsupported-capability", forMessageId: message.messageId },
          { forMessageId: message.messageId },
        );
      }
    },
    describeShell: () => describeShell(options),
  });

  return { registry, bridge };
}
