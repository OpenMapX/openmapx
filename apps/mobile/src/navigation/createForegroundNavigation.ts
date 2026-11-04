import * as Notifications from "expo-notifications";
import type { MobileLocale } from "../../config/nativeCopy";
import { getNavigationAudio, isNavigationAudioAvailable } from "../audio/navigationAudioModule";
import { currentPlatform } from "../background/createHeadlessCoordinator";
import type { ShellDescription } from "../bridge/nativeBridge";
import { DiagnosticRepository, type DiagnosticType } from "../diagnostics/DiagnosticRepository";
import { createLocationDriver } from "../location/createLocationDriver";
import { readLocationPermissionSnapshot } from "../location/ExpoLocationDriver";
import type { LocationDriver } from "../location/LocationDriver";
import { initialProfileFor, type LocationProfileKind, profileFor } from "../location/profiles";
import { ExpoNotificationScheduler } from "../notifications/ExpoNotificationScheduler";
import { PermissionController, type PermissionUi } from "../permissions/permissionController";
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
import { reconcileNavigationSurface } from "./surfaces/createSurfacePort";
import type { NavigationStartContext } from "./startContext";
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
  /** Told when guidance starts or ends, for keep-awake and the shell states. */
  onNavigatingChanged(navigating: boolean): void;
  driver?: LocationDriver;
  registerAsForeground?: boolean;
  startContext?(): NavigationStartContext;
}

export interface ForegroundNavigation {
  coordinator: NavigationCoordinator;
  capabilities(): ShellDescription["capabilities"];
  activeSession(): Promise<ShellDescription["activeSession"]>;
  dispose(): void;
}

export async function createForegroundNavigation(
  options: ForegroundNavigationOptions,
): Promise<ForegroundNavigation> {
  const driver = options.driver ?? createLocationDriver();
  const audio = getNavigationAudio();
  const scheduler = new ExpoNotificationScheduler();
  const now = () => Date.now();

  let notificationsGranted = false;
  const refreshNotificationGrant = async () => {
    try {
      notificationsGranted = (await Notifications.getPermissionsAsync()).granted;
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

  const permissions = new PermissionController({
    driver,
    platform: currentPlatform(),
    ui: options.permissionUi,
    isAppActive: options.isAppActive,
    snapshot: readLocationPermissionSnapshot,
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
            const asked = await Notifications.getPermissionsAsync();
            if (asked.canAskAgain) {
              notificationsGranted = (await Notifications.requestPermissionsAsync()).granted;
            }
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
      speech: isNavigationAudioAvailable(),
    }),
    activeSession: async () => {
      const session = await repository.loadActive(now());
      if (!session) return null;
      return { sessionId: session.sessionId, revision: session.revision, kind: session.kind };
    },
    dispose: () => {
      remote?.abortAll();
      unregister();
    },
  };
}
