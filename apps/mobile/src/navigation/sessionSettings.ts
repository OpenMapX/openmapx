import type { MobileNavigationSession, WebToNativeMessage } from "@openmapx/core/navigation";
import type { SessionEffect } from "../storage/SessionRepository";

export type SettingsPatch = Extract<WebToNativeMessage, { type: "settings.update" }>["payload"];

/**
 * A settings change applied to the session it was meant for.
 *
 * Every field is an absolute value, so the patch is applied on top of whatever
 * revision is current rather than the one the page last saw. Fields that do not
 * exist for the session's mode (voice timing on transit, alight alerts on
 * ground) are not settings of that trip and are left out.
 */
export function applySettingsPatch(
  session: MobileNavigationSession,
  patch: SettingsPatch,
  nowMs: number,
): { session: MobileNavigationSession; effects: SessionEffect[] } {
  const effects: SessionEffect[] = [];
  const base = {
    revision: session.revision + 1,
    updatedAtMs: nowMs,
    ...(patch.locale === undefined ? {} : { locale: patch.locale }),
    ...(patch.units === undefined ? {} : { units: patch.units }),
  };
  const voiceEnabled = patch.voiceEnabled ?? session.payload.startPackage.settings.voiceEnabled;
  // A prompt already playing keeps playing unless it is cut off here.
  if (session.payload.startPackage.settings.voiceEnabled && !voiceEnabled) {
    effects.push({ kind: "stop-audio" });
  }

  let next: MobileNavigationSession;
  if (session.kind === "ground") {
    const settings = session.payload.startPackage.settings;
    next = {
      ...session,
      ...base,
      payload: {
        ...session.payload,
        startPackage: {
          ...session.payload.startPackage,
          settings: {
            voiceEnabled,
            keepScreenOn: patch.keepScreenOn ?? settings.keepScreenOn,
            voiceTiming: patch.voiceTiming ?? settings.voiceTiming,
          },
        },
      },
    };
  } else {
    const settings = session.payload.startPackage.settings;
    const alightAlertsEnabled = patch.alightAlertsEnabled ?? settings.alightAlertsEnabled;
    if (alightAlertsEnabled !== settings.alightAlertsEnabled) {
      effects.push({ kind: "reconcile-alerts", sessionId: session.sessionId });
    }
    next = {
      ...session,
      ...base,
      payload: {
        ...session.payload,
        startPackage: {
          ...session.payload.startPackage,
          settings: {
            voiceEnabled,
            keepScreenOn: patch.keepScreenOn ?? settings.keepScreenOn,
            alightAlertsEnabled,
          },
        },
      },
    };
  }

  effects.push({ kind: "publish-snapshot", immediate: true });
  return { session: next, effects };
}
