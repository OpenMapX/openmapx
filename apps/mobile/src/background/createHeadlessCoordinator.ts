import { getRuntimeConfig } from "../config/runtimeConfig";
import {
  createInvisibleNavigation,
  type ForegroundDevice,
  type ForegroundNavigation,
} from "../navigation/createForegroundNavigation";
import {
  foregroundCoordinator,
  onForegroundCoordinatorChanged,
} from "../navigation/foregroundCoordinator";
import type { NavigationCoordinator } from "../navigation/NavigationCoordinator";
import { deviceMobileLocale } from "../shell/shellCopy";

/**
 * The coordinator as it exists inside the background task.
 *
 * The operating system can launch this process straight into a location
 * callback with no user interface at all, so nothing here may reach React, the
 * WebView, a store or a hook; none of them exist in that case. The composition
 * is the one every runtime uses (`createInvisibleNavigation`), over the same
 * device ports, so an off-route driver gets a reroute and Android's background
 * restrictions apply exactly as they do with the app open. Nothing is sent to a
 * page; the next page to load reads the committed session.
 *
 * It is the same coordinator class and the same database, which is what makes
 * a session started in the foreground and advanced in the background one
 * session rather than two. It is composed once per process and given up when
 * the visible app's composition takes over.
 */

let headless: Promise<ForegroundNavigation> | null = null;
let stopWatchingForeground: () => void = () => {};

export interface HeadlessOverrides {
  apiOrigin?: string;
  /** Replaces device services, as for the visible app's composition. */
  device?: Partial<ForegroundDevice>;
}

export function getHeadlessCoordinator(
  overrides: HeadlessOverrides = {},
): Promise<NavigationCoordinator> {
  if (!headless) {
    const composing = createInvisibleNavigation({
      apiOrigin: overrides.apiOrigin ?? getRuntimeConfig().apiOrigin,
      locale: deviceMobileLocale(),
      ...(overrides.device ? { device: overrides.device } : {}),
    });
    headless = composing;
    composing.catch(() => {
      if (headless === composing) releaseHeadlessComposition();
    });
    stopWatchingForeground = onForegroundCoordinatorChanged(() => {
      if (foregroundCoordinator()) releaseHeadlessComposition();
    });
  }
  return headless.then((composed) => composed.coordinator);
}

/**
 * Disposes this process's headless composition. Called when the visible app's
 * composition registers, and by tests standing in for a process that died.
 */
export function releaseHeadlessComposition(): void {
  const released = headless;
  headless = null;
  stopWatchingForeground();
  stopWatchingForeground = () => {};
  void released?.then((composed) => composed.dispose()).catch(() => undefined);
}
