import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as Notifications from "expo-notifications";
import type { MobileLocale } from "../../config/nativeCopy";
import type { NavigationAudio } from "../audio/navigationAudio";
import { getNavigationAudio, isNavigationAudioAvailable } from "../audio/navigationAudioModule";
import { currentPlatform } from "../background/createHeadlessCoordinator";
import type { ShellDescription } from "../bridge/nativeBridge";
import { DiagnosticRepository, type DiagnosticType } from "../diagnostics/DiagnosticRepository";
import { createLocationDriver } from "../location/createLocationDriver";
import { readLocationPermissionSnapshot } from "../location/ExpoLocationDriver";
import type { LocationDriver } from "../location/LocationDriver";
import { initialProfileFor, type LocationProfileKind, profileFor } from "../location/profiles";
import { ExpoNotificationScheduler } from "../notifications/ExpoNotificationScheduler";
import type { NotificationScheduler } from "../notifications/NotificationScheduler";
import { PermissionController, type PermissionUi } from "../permissions/permissionController";
import type { PermissionSnapshot } from "../permissions/permissionMachine";
import { type Database, getDatabase } from "../storage/database";
import { createCoordinator } from "./createCoordinator";
import { createRemoteWork } from "./createRemoteWork";
import { registerForegroundCoordinator } from "./foregroundCoordinator";
import { GroundRerouteService } from "./ground/GroundRerouteService";
import type {
  AuxiliaryCommandHandler,
  BridgePort,
  NavigationCoordinator,
} from "./NavigationCoordinator";
import { createPublishPort } from "./snapshots/createPublishPort";
import type { NavigationStartContext } from "./startContext";
import { reconcileNavigationSurface } from "./surfaces/createSurfacePort";
import { alightAlertCopy } from "./transit/alightAlertCopy";
import { createAlertPort } from "./transit/createAlertPort";
import { TransitRefreshService } from "./transit/TransitRefreshService";

/**
 * Native navigation as the visible app runs it.
 *
 * The same coordinator class, repository and executor the background task
 * uses, with ports that reach this app's page: replies and snapshots go over
 * the bridge, the start flow shows the native permission screens, and reroutes
 * run against the compiled API origin. While this composition exists, the
 * background task hands its location batches here, so the page sees progress
 * as it happens.
 */

export interface ForegroundNavigationOptions {
  apiOrigin: string;
  locale: MobileLocale;
  /** Sends a message to the page; reports whether it was sent or queued. */
  send(
    type: Parameters<BridgePort["send"]>[0],
    payload: unknown,
    options?: { sessionId?: string; revision?: number; forMessageId?: string },
  ): "sent" | "queued" | "dropped" | "invalid";
  permissionUi: PermissionUi;
  isAppActive(): boolean;
  auxiliary: AuxiliaryCommandHandler;
  /** Told when guidance starts or ends, for the shell states. */
  onNavigatingChanged(navigating: boolean): void;
  registerAsForeground?: boolean;
  startContext?(): NavigationStartContext;
  /** Replaces device services; production binds the Expo modules. */
  device?: Partial<ForegroundDevice>;
}

/**
 * Everything this composition needs from the phone itself.
 *
 * Each member is the narrowest boundary the composition already depended on,
 * so a test can substitute the device while the coordinator, repository,
 * processors and effect ports above it stay the shipped ones.
 */
export interface ForegroundDevice {
  /** The location stream and the permission grants it reports. */
  driver: LocationDriver;
  /** Reads the location grant, including whether it is precise. */
  readLocationPermission(): Promise<PermissionSnapshot>;
  audio: Pick<NavigationAudio, "speak" | "stop">;
  speechAvailable(): boolean;
  notifications: {
    scheduler: NotificationScheduler;
    permission(): Promise<{ granted: boolean; canAskAgain: boolean }>;
    /** Asks the user; resolves with whether the grant now exists. */
    request(): Promise<boolean>;
  };
  /** Opens the durable store when this is the first composition in the process. */
  openStorage(): Promise<Database>;
  /** The screen's wake lock. Both calls are idempotent. */
  keepAwake: { activate(): Promise<void>; deactivate(): Promise<void> };
  clock(): number;
}

/** Scopes this composition's wake lock, so releasing it cannot release anyone else's. */
const KEEP_AWAKE_TAG = "openmapx-navigation";

function productionDevice(): ForegroundDevice {
  return {
    driver: createLocationDriver(),
    readLocationPermission: readLocationPermissionSnapshot,
    audio: getNavigationAudio(),
    speechAvailable: isNavigationAudioAvailable,
    notifications: {
      scheduler: new ExpoNotificationScheduler(),
      permission: async () => {
        const current = await Notifications.getPermissionsAsync();
        return { granted: current.granted, canAskAgain: current.canAskAgain };
      },
      request: async () => (await Notifications.requestPermissionsAsync()).granted,
    },
    openStorage: getDatabase,
    keepAwake: {
      activate: () => activateKeepAwakeAsync(KEEP_AWAKE_TAG),
      deactivate: () => deactivateKeepAwake(KEEP_AWAKE_TAG),
    },
    clock: () => Date.now(),
  };
}

export interface ForegroundNavigation {
  coordinator: NavigationCoordinator;
  capabilities(): ShellDescription["capabilities"];
  activeSession(): Promise<ShellDescription["activeSession"]>;
  /**
   * Re-reads visibility and the durable session for keep-awake. Call it when
   * the app's visibility changes and after anything outside this composition
   * resumed or ended the session.
   */
  reviewKeepAwake(): Promise<void>;
  dispose(): void;
}

export async function createForegroundNavigation(
  options: ForegroundNavigationOptions,
): Promise<ForegroundNavigation> {
  const device: ForegroundDevice = { ...productionDevice(), ...options.device };
  const { driver, audio } = device;
  const scheduler = device.notifications.scheduler;
  const now = () => device.clock();

  let notificationsGranted = false;
  const refreshNotificationGrant = async () => {
    try {
      notificationsGranted = (await device.notifications.permission()).granted;
    } catch {
      notificationsGranted = false;
    }
    return notificationsGranted;
  };
  void refreshNotificationGrant();

  // The coordinator is created below, after the ports that need to reach it.
  let coordinatorRef: NavigationCoordinator | null = null;
  let repositoryRef: Awaited<ReturnType<typeof createCoordinator>>["repository"] | null = null;
  let diagnosticsRef: DiagnosticRepository | null = null;
  const record = (type: string, fields: Record<string, unknown>) => {
    diagnosticsRef?.recordAsync(type as DiagnosticType, fields);
  };

  /**
   * Keep-awake follows the durable session, not what the page or the shell
   * last heard: the screen is held only while the app is visible, a tracked
   * session is active and that session's keep-screen-on setting is on. It is
   * re-checked after every published change, so a setting, an arrival or an
   * end takes effect with the commit that caused it. Never held for a
   * composition that is not visible, such as the car runtime's.
   */
  let disposed = false;
  let screenHeld = false;
  let keepAwakeReview = 0;
  const holdScreen = (wanted: boolean) => {
    if (wanted === screenHeld) return;
    screenHeld = wanted;
    if (wanted) {
      device.keepAwake.activate().catch(() => {
        // Not held after all; the next review asks again.
        screenHeld = false;
      });
    } else {
      device.keepAwake.deactivate().catch(() => undefined);
    }
  };
  const reviewKeepAwake = async () => {
    const review = ++keepAwakeReview;
    let wanted = false;
    if (!disposed && options.isAppActive() && repositoryRef) {
      try {
        const session = await repositoryRef.loadActive(now());
        wanted =
          session?.status === "active" &&
          session.payload.startPackage.settings.keepScreenOn &&
          (await driver.isRunning());
      } catch {
        wanted = false;
      }
    }
    // Only the newest review decides; an older one may have read older state.
    if (review === keepAwakeReview && !disposed) holdScreen(wanted);
  };

  const permissions = new PermissionController({
    driver,
    platform: currentPlatform(),
    ui: options.permissionUi,
    isAppActive: options.isAppActive,
    snapshot: () => device.readLocationPermission(),
  });

  const rerouteService = new GroundRerouteService({ apiOrigin: options.apiOrigin, now });
  let remote: ReturnType<typeof createRemoteWork> | null = null;

  const bridge: BridgePort = {
    send: (type, payload, sendOptions) => {
      const outcome = options.send(type, payload, sendOptions);
      if (type === "session.started") options.onNavigatingChanged(true);
      if (type === "session.stopped") options.onNavigatingChanged(false);
      return outcome;
    },
  };

  const composition = await createCoordinator({
    openStorage: () => device.openStorage(),
    clock: now,
    bridge,
    permissions: {
      state: () => driver.getPermissionState(),
      isAppActive: options.isAppActive,
      ...(options.startContext ? { startContext: options.startContext } : {}),
      requestForStart: async () => {
        const decision = await permissions.requestForStart();
        // The tracking notification and the get-off alert both need the
        // notification permission on Android 13 and later; the start is the
        // moment it is asked for, once.
        if (decision !== "denied" && !(await refreshNotificationGrant())) {
          try {
            const asked = await device.notifications.permission();
            if (asked.canAskAgain) notificationsGranted = await device.notifications.request();
          } catch {
            // Navigation proceeds without alerts.
          }
        }
        return decision;
      },
    },
    driver: { isRunning: () => driver.isRunning() },
    // The page's one-shot requests ride the same command path.
    auxiliary: options.auxiliary,
    ports: {
      reconcileSurface: async () => {
        if (repositoryRef) await reconcileNavigationSurface(repositoryRef);
      },
      driver: {
        start: async () => {
          const session = repositoryRef ? await repositoryRef.loadActive(now()) : null;
          driver.setLocale?.(session?.locale ?? options.locale);
          await driver.start(profileFor(initialProfileFor(session)));
        },
        stop: () => driver.stop(),
        updateProfile: async (profile) => {
          const session = repositoryRef ? await repositoryRef.loadActive(now()) : null;
          driver.setLocale?.(session?.locale ?? options.locale);
          await driver.start(profileFor(profile as LocationProfileKind));
        },
        isRunning: () => driver.isRunning(),
      },
      audio: {
        speak: async (cueId, text, locale) => {
          const result = await audio.speak({ cueId, text, locale });
          // Only the stable result code is recorded, never the spoken text.
          record("audio.result", { result });
        },
        stop: () => audio.stop(),
      },
      alerts: {
        reconcile: async (sessionId) => {
          if (!repositoryRef) return;
          await scheduler.prepare();
          await createAlertPort({
            repository: repositoryRef,
            scheduler,
            copy: alightAlertCopy(
              (await repositoryRef.loadActive(now()))?.locale ?? options.locale,
            ),
            now,
            isAvailable: () => notificationsGranted,
          }).reconcile(sessionId);
        },
        cancelSession: async (sessionId) => {
          if (!repositoryRef) return;
          await createAlertPort({
            repository: repositoryRef,
            scheduler,
            copy: alightAlertCopy(
              (await repositoryRef.loadActive(now()))?.locale ?? options.locale,
            ),
            now,
            isAvailable: () => notificationsGranted,
          }).cancelSession(sessionId);
        },
      },
      publish: {
        snapshot: async (immediate) => {
          await publish?.port.snapshot(immediate);
          // Arrival and expiry end a session from a location batch rather than
          // a command, so the shell learns about them here.
          const active = repositoryRef ? await repositoryRef.loadActive(now()) : null;
          if (active?.status !== "active") options.onNavigatingChanged(false);
          await reviewKeepAwake();
        },
        event: async (eventId) => {
          await publish?.port.event(eventId);
        },
      },
      remote: {
        reroute: async (requestId) => remote?.port.reroute(requestId),
        transitRefresh: async (requestId) => remote?.port.transitRefresh(requestId),
      },
      diagnostics: { record },
    },
  });

  const { coordinator, repository } = composition;
  coordinatorRef = coordinator;
  repositoryRef = repository;
  diagnosticsRef = new DiagnosticRepository(repository);
  const publish = createPublishPort({
    repository,
    reconcileSurface: () => reconcileNavigationSurface(repository),
    send: (type, payload) => {
      const outcome = options.send(type, payload);
      return outcome === "sent" || outcome === "queued";
    },
    now,
  });
  remote = createRemoteWork({
    repository,
    reroute: rerouteService,
    transitRefresh: new TransitRefreshService({ apiOrigin: options.apiOrigin, now }),
    applyTransitRefresh: (outcome) => coordinator.applyTransitRefresh(outcome),
    applyReroute: (outcome) => coordinatorRef?.applyReroute(outcome) ?? Promise.resolve(),
    now,
    diagnostics: { record },
  });

  const unregister =
    options.registerAsForeground === false ? () => {} : registerForegroundCoordinator(coordinator);

  return {
    coordinator,
    capabilities: () => ({
      groundNavigation: true,
      transitNavigation: true,
      transitActions: true,
      backgroundLocation: true,
      localNotifications: notificationsGranted,
      speech: device.speechAvailable(),
    }),
    activeSession: async () => {
      const session = await repository.loadActive(now());
      if (!session) return null;
      return { sessionId: session.sessionId, revision: session.revision, kind: session.kind };
    },
    reviewKeepAwake,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      remote?.abortAll();
      unregister();
      holdScreen(false);
    },
  };
}
