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
}

export interface ShellBridge {
  registry: ChannelRegistry;
  bridge: NativeBridge;
}

/**
 * What the shell can actually do right now.
 *
 * Ground and transit stay false until their processors are registered; the page
 * must keep planning in the browser until a capability is genuinely backed.
 */
export function describeShell(): ShellDescription {
  return {
    shellVersion: nativeApplicationVersion ?? "0.0.0",
    shellBuild: nativeBuildVersion ?? "0",
    platform: Platform.OS === "android" ? "android" : "ios",
    capabilities: {
      groundNavigation: false,
      transitNavigation: false,
      backgroundLocation: true,
      localNotifications: true,
      speech: true,
    },
    permission: "not-determined",
    locationDriver: "expo",
    activeSession: null,
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
    // No processor is registered yet, so a validated command is accepted by the
    // transport and then has nowhere to go. Task ordering, not an oversight:
    // the coordinator replaces this in the next step.
    dispatch: async () => undefined,
    describeShell,
  });

  return { registry, bridge };
}
