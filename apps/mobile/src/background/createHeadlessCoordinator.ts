import { Platform } from "react-native";
import { getNavigationAudio } from "../audio/navigationAudioModule";
import { createLocationDriver } from "../location/createLocationDriver";
import { type LocationProfileKind, profileFor } from "../location/profiles";
import { createCoordinator } from "../navigation/createCoordinator";
import type { EffectPorts } from "../navigation/effects";
import type { NavigationCoordinator } from "../navigation/NavigationCoordinator";
import { getDatabase } from "../storage/database";
import { SessionRepository } from "../storage/SessionRepository";

/**
 * The coordinator as it exists inside the background task.
 *
 * The operating system can launch this process straight into a location
 * callback with no user interface at all, so nothing here may reach React, the
 * WebView, a store or a hook — none of them exist in that case. What the
 * foreground app supplies through the bridge, this composition supplies through
 * the durable outbox instead: an event is persisted now and delivered when a
 * document next completes a handshake.
 *
 * It is the *same* coordinator class and the same database, which is what makes
 * a session started in the foreground and advanced in the background one
 * session rather than two.
 */

function ports(repository: SessionRepository): EffectPorts {
  const driver = createLocationDriver();
  const audio = getNavigationAudio();
  const nowMs = () => Date.now();

  return {
    driver: {
      // The permission mode changes when delivery stops, not how it is
      // requested: a foreground-only session uses the same cadence and is
      // stopped by the lifecycle policy when the app leaves the foreground.
      start: () => driver.start(profileFor("driving")),
      stop: () => driver.stop(),
      updateProfile: (profile) => driver.start(profileFor(profile as LocationProfileKind)),
      isRunning: () => driver.isRunning(),
    },
    audio: {
      speak: async (cueId, text, locale) => {
        const result = await audio.speak({ cueId, text, locale });
        // Only the stable result code is recorded — never the spoken text.
        await repository.recordDiagnostic("audio.result", { result }, nowMs());
      },
      stop: () => audio.stop(),
    },
    alerts: {
      // Notification scheduling is composed in the foreground; a headless run
      // records the intent durably and reconciles when the app next starts.
      reconcile: async (sessionId) => {
        await repository.recordDiagnostic(
          "notification.operation",
          { operation: "reconcile-deferred", session: sessionId.length },
          nowMs(),
        );
      },
      cancelSession: async () => undefined,
    },
    publish: {
      // No document exists to receive a snapshot. The next handshake reads the
      // authoritative session directly, so nothing is lost by skipping it.
      snapshot: async () => undefined,
      event: async () => undefined,
    },
    remote: {
      reroute: async () => undefined,
      transitRefresh: async () => undefined,
      transitReplan: async () => undefined,
    },
    diagnostics: {
      record: (type, fields) => {
        void repository.recordDiagnostic(type, fields, nowMs());
      },
    },
  };
}

/**
 * Builds — or reuses — the process-wide coordinator.
 *
 * `createCoordinator` memoises, so a callback arriving while the UI is starting
 * joins the existing authority instead of creating a second one.
 */
export async function getHeadlessCoordinator(): Promise<NavigationCoordinator> {
  const repository = new SessionRepository(await getDatabase());
  const { coordinator } = await createCoordinator({
    // Nothing to send to, and nothing that would accept it: a headless process
    // has no channel, so every outbound message is dropped by design.
    bridge: { send: () => undefined },
    permissions: {
      state: () => createLocationDriver().getPermissionState(),
      // A background callback is by definition not a visible start, so this is
      // false: the only command it can serve is one that needs no prompt.
      isAppActive: () => false,
      requestForStart: async () => "denied",
    },
    driver: { isRunning: () => createLocationDriver().isRunning() },
    ports: ports(repository),
  });
  return coordinator;
}

/** The platform description the permission flow needs, without importing React. */
export function currentPlatform(): { os: "ios" } | { os: "android"; sdkInt: number } {
  return Platform.OS === "android"
    ? { os: "android", sdkInt: typeof Platform.Version === "number" ? Platform.Version : 0 }
    : { os: "ios" };
}
