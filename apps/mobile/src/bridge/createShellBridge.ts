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
   * Optional so the transport can stand alone; a shell without it accepts and
   * discards commands, which is the correct behaviour while it also reports
   * every navigation capability as false.
   */
  dispatch?: (message: WebToNativeMessage) => Promise<unknown>;
  /** Reports what the shell can actually run right now. */
  capabilities?: () => Pick<
    ShellDescription["capabilities"],
    "groundNavigation" | "transitNavigation"
  >;
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
  const modes = options.capabilities?.() ?? { groundNavigation: false, transitNavigation: false };
  return {
    shellVersion: nativeApplicationVersion ?? "0.0.0",
    shellBuild: nativeBuildVersion ?? "0",
    platform: Platform.OS === "android" ? "android" : "ios",
    capabilities: {
      ...modes,
      backgroundLocation: true,
      localNotifications: true,
      speech: true,
    },
    permission: (await options.permission?.()) ?? "not-determined",
    locationDriver: "expo",
    activeSession: (await options.activeSession?.()) ?? null,
  };
}

export function createShellBridge(options: ShellBridgeOptions): ShellBridge {
  const registry = new ChannelRegistry();
  let messageCounter = 0;

  const bridge = new NativeBridge({
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
      await options.dispatch?.(message);
    },
    describeShell: () => describeShell(options),
  });

  return { registry, bridge };
}
