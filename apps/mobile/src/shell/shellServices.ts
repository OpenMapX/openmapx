import type { WebToNativeMessage } from "@openmapx/core/navigation";
import { Linking } from "react-native";
import { createSystemAuthSession } from "../auth/createSystemAuthSession";
import type { SendOutcome } from "../bridge/nativeBridge";
import type { MobileRuntimeConfig } from "../config/runtimeConfig";
import { createLocationDriver } from "../location/createLocationDriver";
import { ForegroundLocationService } from "../location/ForegroundLocationService";
import type { LocationDriver, LocationPermissionState } from "../location/LocationDriver";
import type { AuxiliaryCommandHandler, CommandResponse } from "../navigation/NavigationCoordinator";
import { openAppSettings } from "../settings/openAppSettings";
import { createAuxiliaryCommandHandler } from "./auxiliaryCommands";

/**
 * The foreground app's answers to the page's non-navigation requests.
 *
 * One per WebView shell. The location driver is the process-wide one, so a
 * one-off position never opens a second subscription beside a running session.
 */
export interface ShellServices {
  auxiliary: AuxiliaryCommandHandler;
  /** The OS location grant, for the handshake. Never prompts. */
  permission(): Promise<LocationPermissionState>;
}

export interface ShellServicesOptions {
  config: Pick<MobileRuntimeConfig, "webOrigin">;
  /** Prompts are shown only while the app is in front. */
  isAppActive(): boolean;
  driver?: LocationDriver;
}

export function createShellServices(options: ShellServicesOptions): ShellServices {
  const driver = options.driver ?? createLocationDriver();
  const location = new ForegroundLocationService({
    driver,
    clock: () => Date.now(),
    requestForegroundPermission: async () =>
      options.isAppActive() ? driver.requestForegroundPermission() : driver.getPermissionState(),
  });
  const auth = createSystemAuthSession({ webOrigin: options.config.webOrigin });

  return {
    auxiliary: createAuxiliaryCommandHandler({
      locate: (fixOptions) => location.getFix(fixOptions),
      openSettings: (target) =>
        openAppSettings(target, { openSettings: () => Linking.openSettings() }),
      signIn: (purpose) => auth.open(purpose),
    }),
    permission: async () => {
      try {
        return await driver.getPermissionState();
      } catch {
        return "not-determined";
      }
    },
  };
}

/**
 * Turns a handler's answer into a reply on the bridge.
 *
 * A command nothing in this shell handles is refused explicitly, except an
 * event acknowledgement, which never has a reply.
 */
export async function answerCommand(
  message: WebToNativeMessage,
  handle: (message: WebToNativeMessage) => Promise<CommandResponse | null>,
  send: (
    type: CommandResponse["type"],
    payload: unknown,
    options: { forMessageId: string; sessionId?: string; revision?: number },
  ) => SendOutcome,
): Promise<void> {
  if (message.type === "event.ack" || message.type === "web.hello") return;
  const response = await handle(message);
  if (!response) {
    send("native.error", { code: "unsupported-capability" }, { forMessageId: message.messageId });
    return;
  }
  const outcome = send(response.type, response.payload, {
    forMessageId: message.messageId,
    ...(response.sessionId === undefined ? {} : { sessionId: response.sessionId }),
    ...(response.revision === undefined ? {} : { revision: response.revision }),
  });
  // An answer that fails its schema is refused instead, so the page is not
  // left waiting out its deadline.
  if (outcome === "invalid" && response.type !== "native.error") {
    send("native.error", { code: "internal-error" }, { forMessageId: message.messageId });
  }
}
