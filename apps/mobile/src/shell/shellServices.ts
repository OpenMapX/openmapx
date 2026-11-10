import { Linking } from "react-native";
import { createSystemAuthSession } from "../auth/createSystemAuthSession";
import type { AuxiliaryCommandHandler } from "../bridge/answerCommand";
import type { MobileRuntimeConfig } from "../config/runtimeConfig";
import { createLocationDriver } from "../location/createLocationDriver";
import { ForegroundLocationService } from "../location/ForegroundLocationService";
import type { LocationDriver, LocationPermissionState } from "../location/LocationDriver";
import { withPermissionPrompt } from "../permissions/permissionPromptLock";
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
    requestForegroundPermission: () =>
      withPermissionPrompt(async () =>
        options.isAppActive() ? driver.requestForegroundPermission() : driver.getPermissionState(),
      ),
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
