import type { SessionEffect } from "../storage/SessionRepository";

/**
 * Runs committed intents against the outside world.
 *
 * Two properties hold everything together:
 *
 *  - **It cannot write session state.** No repository is reachable from here, so
 *    an effect can never disagree with what was persisted.
 *  - **One failure does not stop the rest.** A muted speech synthesiser must not
 *    prevent the location driver from being stopped, so every effect is
 *    attempted and each failure becomes a redacted diagnostic.
 *
 * Order is fixed rather than incidental: stop the driver before releasing audio,
 * reconcile alerts before publishing, and publish the snapshot last so the page
 * sees the state that produced the events it just received.
 */

const ORDER: Record<SessionEffect["kind"], number> = {
  "stop-location": 0,
  "start-location": 1,
  "update-location-profile": 2,
  "cancel-session-alerts": 3,
  "reconcile-alerts": 4,
  "stop-audio": 5,
  speak: 6,
  "request-reroute": 7,
  "request-transit-refresh": 8,
  "request-transit-replan": 9,
  "publish-event": 10,
  "publish-snapshot": 11,
};

export interface LocationDriverPort {
  start(permissionMode: "background" | "foreground-only"): Promise<void>;
  stop(): Promise<void>;
  updateProfile(profile: string): Promise<void>;
  isRunning(): Promise<boolean>;
}

export interface AudioPort {
  speak(cueId: string, text: string, locale: "en" | "de"): Promise<void>;
  stop(): Promise<void>;
}

export interface AlertPort {
  reconcile(sessionId: string): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
}

export interface PublishPort {
  snapshot(immediate: boolean): Promise<void>;
  event(eventId: string): Promise<void>;
}

export interface RemoteWorkPort {
  reroute(requestId: string): Promise<void>;
  transitRefresh(requestId: string): Promise<void>;
  transitReplan(requestId: string): Promise<void>;
}

export interface DiagnosticSink {
  record(type: string, fields: Record<string, unknown>): void;
}

export interface EffectPorts {
  driver: LocationDriverPort;
  audio: AudioPort;
  alerts: AlertPort;
  publish: PublishPort;
  remote: RemoteWorkPort;
  diagnostics: DiagnosticSink;
}

export class EffectRunner {
  constructor(private readonly ports: EffectPorts) {}

  /** Executes every effect, in the fixed order, reporting how many failed. */
  async run(effects: readonly SessionEffect[]): Promise<{ failed: number }> {
    const ordered = [...effects].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
    let failed = 0;
    for (const effect of ordered) {
      try {
        await this.execute(effect);
      } catch {
        failed += 1;
        // Only the effect kind is recorded. A cue's text, a session's route and
        // the underlying error message all stay out of the local log.
        this.ports.diagnostics.record("typed.error", { scope: "effect", kind: effect.kind });
      }
    }
    return { failed };
  }

  private async execute(effect: SessionEffect): Promise<void> {
    const { driver, audio, alerts, publish, remote } = this.ports;
    switch (effect.kind) {
      case "start-location":
        return driver.start(effect.permissionMode);
      case "stop-location":
        return driver.stop();
      case "update-location-profile":
        return driver.updateProfile(effect.profile);
      case "speak":
        return audio.speak(effect.cueId, effect.text, effect.locale);
      case "stop-audio":
        return audio.stop();
      case "reconcile-alerts":
        return alerts.reconcile(effect.sessionId);
      case "cancel-session-alerts":
        return alerts.cancelSession(effect.sessionId);
      case "publish-snapshot":
        return publish.snapshot(effect.immediate);
      case "publish-event":
        return publish.event(effect.eventId);
      case "request-reroute":
        return remote.reroute(effect.requestId);
      case "request-transit-refresh":
        return remote.transitRefresh(effect.requestId);
      case "request-transit-replan":
        return remote.transitReplan(effect.requestId);
    }
  }
}
