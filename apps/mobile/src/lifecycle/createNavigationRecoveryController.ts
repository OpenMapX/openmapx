import { getNavigationAudio } from "../audio/navigationAudioModule";
import { createLocationDriver } from "../location/createLocationDriver";
import { profileFor } from "../location/profiles";
import { getSharedCoordinatorCore } from "../navigation/createCoordinator";
import { ExpoNotificationScheduler } from "../notifications/ExpoNotificationScheduler";
import { NavigationRecoveryController } from "./NavigationRecoveryController";

export interface NavigationRecoveryEnvironment {
  isAppActive(): boolean;
}

/** Composes the recovery-only authority from the real durable/device ports. */
export async function createNavigationRecoveryController(
  environment: NavigationRecoveryEnvironment,
): Promise<NavigationRecoveryController> {
  const { repository, executor } = await getSharedCoordinatorCore();
  const driver = createLocationDriver();
  const audio = getNavigationAudio();
  const notifications = new ExpoNotificationScheduler();

  return new NavigationRecoveryController({
    store: {
      inspect: (nowMs) => repository.inspectActive(nowMs),
      terminate: async (sessionId, nowMs) => {
        const result = await repository.terminate(sessionId, "stopped", nowMs);
        return result.ack !== null;
      },
    },
    driver: {
      permission: () => driver.getPermissionState(),
      running: () => driver.isRunning(),
      start: (profile) => driver.start(profileFor(profile)),
      stop: () => driver.stop(),
    },
    stopAudio: () => audio.stop(),
    // Reconciliation with an empty desired set cancels only identifiers owned
    // by OpenMapX, including alerts whose DB rows were removed transactionally.
    clearAlerts: async () => {
      await notifications.reconcile([]);
    },
    isAppActive: environment.isAppActive,
    now: () => Date.now(),
    executor,
  });
}
