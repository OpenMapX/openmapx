import type { MobileNavigationSession, WebToNativeMessage } from "@openmapx/core/navigation";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as Notifications from "expo-notifications";
import type { MobileLocale } from "../../config/nativeCopy";
import type { NavigationAudio } from "../audio/navigationAudio";
import { getNavigationAudio, isNavigationAudioAvailable } from "../audio/navigationAudioModule";
import {
  type AuxiliaryCommandHandler,
  answerCommand,
  isAuxiliaryCommand,
} from "../bridge/answerCommand";
import type { ShellDescription } from "../bridge/nativeBridge";
import { ConfirmedConnectivity } from "../connectivity/ConfirmedConnectivity";
import type { ConnectivityDriver } from "../connectivity/ConnectivityDriver";
import { NetInfoConnectivityDriver } from "../connectivity/NetInfoConnectivityDriver";
import { DiagnosticRepository, type DiagnosticType } from "../diagnostics/DiagnosticRepository";
import {
  NavigationRecoveryController,
  type RecoveryEvent,
} from "../lifecycle/NavigationRecoveryController";
import type { AppActivity } from "../location/backgroundSafeDriver";
import { appActivity, createLocationDriver } from "../location/createLocationDriver";
import { readLocationPermissionSnapshot } from "../location/ExpoLocationDriver";
import type { LocationDriver } from "../location/LocationDriver";
import { initialProfileFor, type LocationProfileKind, profileFor } from "../location/profiles";
import { ExpoNotificationScheduler } from "../notifications/ExpoNotificationScheduler";
import type { NotificationScheduler } from "../notifications/NotificationScheduler";
import { PermissionController, type PermissionUi } from "../permissions/permissionController";
import type { PermissionSnapshot } from "../permissions/permissionMachine";
import { withPermissionPrompt } from "../permissions/permissionPromptLock";
import { currentPlatform } from "../platform/currentPlatform";
import { type Database, getDatabase } from "../storage/database";
import { createCoordinator } from "./createCoordinator";
import { createRemoteWork } from "./createRemoteWork";
import { registerForegroundCoordinator } from "./foregroundCoordinator";
import { GroundCoastingScheduler } from "./ground/GroundCoastingScheduler";
import { GroundRerouteService } from "./ground/GroundRerouteService";
import type { BridgePort, NavigationCoordinator, SessionEnded } from "./NavigationCoordinator";
import { createPublishPort } from "./snapshots/createPublishPort";
import type { NavigationStartContext } from "./startContext";
import { clearNavigationSurface, reconcileNavigationSurface } from "./surfaces/createSurfacePort";
import { alightAlertCopy } from "./transit/alightAlertCopy";
import { createAlertPort } from "./transit/createAlertPort";
import { TransitRefreshService } from "./transit/TransitRefreshService";

/**
 * Native navigation, composed once per runtime from one set of device ports.
 *
 * The visible app, the Android Auto runtime and a process the operating system
 * starts for a background location batch all compose through here, over the
 * same coordinator class, repository and executor and the same location
 * driver, so reroutes, refreshes, alerts and Android's background restrictions
 * behave the same whichever runtime owns a batch. The visible app's ports
 * reach its page: replies and snapshots go over the bridge and the start flow
 * shows the native permission screens. While that composition exists, the
 * background task hands its location batches to it, so the page sees progress
 * as it happens. `createInvisibleNavigation` composes the other two.
 */

export interface ForegroundNavigationOptions {
  apiOrigin: string;
  locale: MobileLocale;
  /** Sends a message to the page; reports whether it was sent or queued. */
  send: BridgePort["send"];
  permissionUi: PermissionUi;
  isAppActive(): boolean;
  /** Answers the page's one-shot requests, beside the navigation queue. */
  auxiliary: AuxiliaryCommandHandler;
  /**
   * Told when guidance starts, or stops while its session remains (an
   * arrival). Each change is reported once.
   */
  onNavigatingChanged(navigating: boolean): void;
  /** Told once whenever a session ends, whoever ended it. */
  onSessionEnded?(ended: SessionEnded): void;
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
  /**
   * The location stream and the permission grants it reports. Production's
   * driver never restarts a running Android stream while the app is in the
   * background (`withBackgroundSafeProfiles`); `app` activation re-applies the
   * session's cadence.
   */
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
  /** When the user comes back to the app. */
  app: AppActivity;
  /** Whether the internet is reachable, as the platform reports it. */
  connectivity: ConnectivityDriver;
  /** Which platform's location profiles and permission flow apply. */
  platform: ReturnType<typeof currentPlatform>;
  /** The screen's wake lock. Both calls are idempotent. */
  keepAwake: { activate(): Promise<void>; deactivate(): Promise<void> };
  clock(): number;
  /** Runs `callback` once after `delayMs` of clock time; returns a cancel function. */
  schedule(callback: () => void, delayMs: number): () => void;
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
    app: appActivity,
    connectivity: new NetInfoConnectivityDriver(),
    platform: currentPlatform(),
    keepAwake: {
      activate: () => activateKeepAwakeAsync(KEEP_AWAKE_TAG),
      deactivate: () => deactivateKeepAwake(KEEP_AWAKE_TAG),
    },
    clock: () => Date.now(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
}

export interface ForegroundNavigation {
  coordinator: NavigationCoordinator;
  /**
   * Handles a command from the page. Navigation commands enter the
   * coordinator's queue; one-shot requests are answered beside it, so a
   * permission prompt or a sign-in never holds up location batches.
   */
  dispatch(command: WebToNativeMessage): Promise<void>;
  capabilities(): ShellDescription["capabilities"];
  activeSession(): Promise<ShellDescription["activeSession"]>;
  /**
   * Re-reads visibility and the durable session for the work that runs only
   * while the app is visible: keep-awake and coasting. Call it when the app's
   * visibility changes and after anything outside this composition resumed or
   * ended the session.
   */
  reviewForegroundWork(): Promise<void>;
  /**
   * Reconciles a session that outlived its process or the app's visibility,
   * and the user's answers to the recovery screen. Ends go through the
   * coordinator, so they reach the page and keep-awake like any other end.
   */
  recovery: Pick<NavigationRecoveryController, "reconcile" | "resume" | "end">;
  /** Records a native message that failed its schema and was not sent. */
  reportInvalidSend(type: string): void;
  dispose(): void;
}

/** Permission screens for a runtime the user cannot see: every one is declined. */
const NO_PERMISSION_SCREENS: PermissionUi = {
  showDisclosure: async () => "dismiss",
  showSettingsRequired: async () => "dismiss",
  offerForegroundOnly: async () => "dismiss",
  showDenied: async () => {},
  openSystemSettings: async () => {},
};

/**
 * The same composition for a runtime with no page and no visible app: the
 * Android Auto runtime, or a process the operating system started for a
 * background location batch. Nothing reaches a page, no prompt is shown, the
 * screen is never held awake, and it does not take the batches the visible
 * app's composition would.
 */
export function createInvisibleNavigation(options: {
  apiOrigin: string;
  locale: MobileLocale;
  device?: Partial<ForegroundDevice>;
}): Promise<ForegroundNavigation> {
  return createForegroundNavigation({
    apiOrigin: options.apiOrigin,
    locale: options.locale,
    send: () => "dropped",
    permissionUi: NO_PERMISSION_SCREENS,
    isAppActive: () => false,
    auxiliary: async () => null,
    onNavigatingChanged: () => {},
    registerAsForeground: false,
    ...(options.device ? { device: options.device } : {}),
  });
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
   * Keep-awake and coasting follow the durable session, not what the page or
   * the shell last heard. The screen is held only while the app is visible, a
   * tracked session is active and that session's keep-screen-on setting is on.
   * The puck coasts only while the app is visible and the session allows it
   * (`canCoast`). Both are re-checked after every published change, so a
   * setting, a new fix, an arrival or an end takes effect with the commit that
   * caused it. Neither runs for a composition that is not visible, such as the
   * car runtime's or a headless process's.
   */
  let disposed = false;
  let screenHeld = false;
  let keepAwakeReview = 0;
  let coaster: GroundCoastingScheduler | null = null;
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
  /**
   * `loaded` is the committed row when the caller has just read it. The driver
   * is asked only when the screen is not already held: a held screen was
   * checked against a running stream, and anything that stops the stream for
   * an active session also ends that session or the app's visibility.
   */
  const reviewForegroundWork = async (loaded?: MobileNavigationSession | null) => {
    const review = ++keepAwakeReview;
    let wanted = false;
    let session: MobileNavigationSession | null = null;
    const visible = !disposed && options.isAppActive();
    if (visible && repositoryRef) {
      try {
        session = loaded === undefined ? await repositoryRef.loadActive(now()) : loaded;
        wanted =
          session?.status === "active" &&
          session.payload.startPackage.settings.keepScreenOn &&
          (screenHeld || (await driver.isRunning()));
      } catch {
        wanted = false;
      }
    }
    // Only the newest review decides; an older one may have read older state.
    if (review !== keepAwakeReview || disposed) return;
    holdScreen(wanted);
    coaster?.sync(session?.kind === "ground" ? session : null, visible ? "active" : "background");
  };

  const permissions = new PermissionController({
    driver,
    platform: device.platform,
    ui: options.permissionUi,
    isAppActive: options.isAppActive,
    snapshot: () => device.readLocationPermission(),
  });

  const rerouteService = new GroundRerouteService({ apiOrigin: options.apiOrigin, now });
  let remote: ReturnType<typeof createRemoteWork> | null = null;

  const bridge: BridgePort = { send: options.send };

  /**
   * Whether guidance is running, as the shell was last told. It follows the
   * committed row after every publish: active means guiding, anything else
   * (an arrival) means not. An end is reported separately, once, by
   * `onSessionEnded`; recovery outcomes set it without a report, because the
   * shell dispatches those outcomes itself.
   *
   * A recovery outcome that leaves an active session untracked (the stream
   * was not running, or the location grant was lost) holds it: the shell is
   * showing Resume or the permission screen, and a commit that has nothing to
   * do with tracking (a connectivity change, a late reroute or refresh answer)
   * must not report guidance as running. Only a resume, or the session's end,
   * lifts the hold.
   */
  let navigating = false;
  let heldByRecovery = false;
  const reportNavigating = (value: boolean) => {
    if (value === navigating || (value && heldByRecovery)) return;
    navigating = value;
    options.onNavigatingChanged(value);
  };

  const connectivity = new ConfirmedConnectivity({
    driver: device.connectivity,
    now,
    schedule: (callback, delayMs) => device.schedule(callback, delayMs),
  });

  const composition = await createCoordinator({
    openStorage: () => device.openStorage(),
    clock: now,
    connectivity,
    onSessionEnded: (ended) => {
      navigating = false;
      heldByRecovery = false;
      options.onSessionEnded?.(ended);
      void reviewForegroundWork(null);
    },
    schedule: (callback, delayMs) => device.schedule(callback, delayMs),
    bridge,
    permissions: {
      state: () => driver.getPermissionState(),
      isAppActive: options.isAppActive,
      ...(options.startContext ? { startContext: options.startContext } : {}),
      // The whole flow is one prompt sequence, so no other prompt interleaves.
      requestForStart: () =>
        withPermissionPrompt(async () => {
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
        }),
    },
    driver: { isRunning: () => driver.isRunning() },
    ports: {
      reconcileSurface: async () => {
        if (repositoryRef) await reconcileNavigationSurface(repositoryRef);
      },
      driver: {
        start: async () => {
          const session = repositoryRef ? await repositoryRef.loadActive(now()) : null;
          driver.setLocale?.(session?.locale ?? options.locale);
          await driver.start(profileFor(initialProfileFor(session), device.platform.os));
        },
        stop: () => driver.stop(),
        updateProfile: async (profile) => {
          const session = repositoryRef ? await repositoryRef.loadActive(now()) : null;
          driver.setLocale?.(session?.locale ?? options.locale);
          await driver.start(profileFor(profile as LocationProfileKind, device.platform.os));
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
          const active = repositoryRef ? await repositoryRef.loadActive(now()) : null;
          // With no row the session ended, which `onSessionEnded` reports.
          if (active) reportNavigating(active.status === "active");
          await reviewForegroundWork(active);
        },
      },
      remote: {
        reroute: async (requestId) => remote?.port.reroute(requestId),
        transitRefresh: async (requestId) => remote?.port.transitRefresh(requestId),
      },
      diagnostics: { record },
    },
  });

  const { coordinator, repository, executor } = composition;
  coordinatorRef = coordinator;
  coaster = new GroundCoastingScheduler({
    now,
    schedule: (callback, delayMs) => device.schedule(callback, delayMs),
    dispatch: (fix, origin) => {
      void coordinator.handleCoastedFix(fix, origin);
    },
  });
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
    track: (work) => coordinator.trackRemoteWork(work),
  });

  const recoveryController = new NavigationRecoveryController({
    store: { inspect: (nowMs) => repository.inspectActive(nowMs) },
    sessions: {
      closeFinished: (sessionId) => coordinator.closeFinishedSession(sessionId),
      stop: (sessionId) => coordinator.stopNatively(sessionId),
    },
    driver: {
      permission: () => driver.getPermissionState(),
      running: () => driver.isRunning(),
      start: (profile) => driver.start(profileFor(profile, device.platform.os)),
      stop: () => driver.stop(),
    },
    stopAudio: () => audio.stop(),
    clearSurface: clearNavigationSurface,
    reconcileSurface: () => reconcileNavigationSurface(repository, options.isAppActive()),
    // Reconciliation with an empty desired set cancels only identifiers owned
    // by OpenMapX, including alerts whose rows were removed with their session.
    clearAlerts: async () => {
      await scheduler.reconcile([]);
    },
    isAppActive: options.isAppActive,
    now,
    executor,
  });
  /** The shell shows a recovery outcome itself; this only keeps `navigating` in step. */
  const recovered = async (outcome: Promise<RecoveryEvent>) => {
    const event = await outcome;
    navigating = event === "session-started";
    heldByRecovery = event === "resume-required" || event === "permission-lost";
    return event;
  };

  const unregister =
    options.registerAsForeground === false ? () => {} : registerForegroundCoordinator(coordinator);
  const stopWatchingConnectivity = connectivity.start();
  const stopApplyingConnectivity = connectivity.onConfirmed(() => {
    void coordinator.connectivityChanged();
  });
  // On Android a cadence change asked for in the background was not applied,
  // and the runtime that asked may no longer exist. Apply the session's cadence
  // whenever the app becomes active, including a cold open where the app is
  // already active before this subscribes. iOS applies changes in the
  // background, so it needs no refresh.
  let stopWatchingActivity = () => {};
  if (device.platform.os === "android") {
    stopWatchingActivity = device.app.onActive(() => {
      void coordinator.refreshLocationProfile();
    });
    if (device.app.isActive()) void coordinator.refreshLocationProfile();
  }

  return {
    coordinator,
    dispatch: async (command) => {
      if (isAuxiliaryCommand(command.type)) {
        await answerCommand(command, options.auxiliary, (type, payload, sendOptions) =>
          options.send(type, payload, sendOptions),
        );
        return;
      }
      await coordinator.dispatch(command);
    },
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
    reviewForegroundWork: () => reviewForegroundWork(),
    recovery: {
      reconcile: (visibility) => recovered(recoveryController.reconcile(visibility)),
      resume: () => recovered(recoveryController.resume()),
      end: () => recovered(recoveryController.end()),
    },
    reportInvalidSend: (type) => record("typed.error", { scope: "bridge-send", type }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      remote?.abortReroutes();
      unregister();
      stopApplyingConnectivity();
      stopWatchingConnectivity();
      stopWatchingActivity();
      holdScreen(false);
      coaster?.stop();
    },
  };
}
