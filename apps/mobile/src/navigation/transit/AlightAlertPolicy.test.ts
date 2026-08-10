import type { TransitMobileSession } from "@openmapx/core/navigation";
import { isOpenMapXNotificationId } from "../../notifications/notificationIds";
import {
  type AlightAlertCopy,
  alertHasChanged,
  computeAlightAlert,
  MIN_LEAD_MS,
  SCHEDULE_FALLBACK_LEAD_MS,
} from "./AlightAlertPolicy";
import { transitSessionFixture } from "./testing/transitFixture";

const ARRIVAL_MS = new Date("2026-08-09T08:40:00Z").getTime();
const NOW = ARRIVAL_MS - 20 * 60_000;

const COPY: AlightAlertCopy = {
  title: (stop) => `Get off at ${stop}`,
  body: (stop, basis, platform) => `${stop}${platform ? ` (platform ${platform})` : ""} — ${basis}`,
};

/** A session riding the transit leg, with the capture times a feed would supply. */
function riding(overrides: Partial<TransitMobileSession> = {}): TransitMobileSession {
  const base = transitSessionFixture(overrides);
  const capture = base.payload.startPackage.captures[0];
  return {
    ...base,
    // The fixture itinerary carries 2026 ISO times, so the session's own clock
    // has to sit around them or every trigger falls past its expiry.
    startedAtMs: NOW - 10 * 60_000,
    updatedAtMs: NOW,
    expiresAtMs: NOW + 12 * 60 * 60_000,
    payload: {
      ...base.payload,
      tickState: { ...base.payload.tickState, phase: "riding", currentLegIndex: 1 },
      startPackage: {
        ...base.payload.startPackage,
        captures: [
          {
            ...capture,
            stops: capture.stops.map((stop, index) => ({
              ...stop,
              scheduledDeparture: new Date(ARRIVAL_MS - (3 - index) * 5 * 60_000).toISOString(),
            })),
          },
        ],
      },
      ...(overrides.payload ?? {}),
    },
  } as TransitMobileSession;
}

describe("computeAlightAlert", () => {
  it("warns from the penultimate captured stop's departure", () => {
    // Once the train leaves that stop, the next one is the rider's.
    const alert = computeAlightAlert(riding(), NOW, COPY);

    expect(alert?.basis).toBe("captured");
    expect(alert?.triggerAtMs).toBe(ARRIVAL_MS - 5 * 60_000);
  });

  it("prefers a live expected departure over the scheduled one", () => {
    const session = riding();
    const capture = session.payload.startPackage.captures[0];
    capture.stops[2].expectedDeparture = new Date(ARRIVAL_MS - 2 * 60_000).toISOString();

    expect(computeAlightAlert(session, NOW, COPY)?.triggerAtMs).toBe(ARRIVAL_MS - 2 * 60_000);
  });

  it("falls back to the plan's arrival when there is no capture", () => {
    const session = riding();
    session.payload.startPackage.captures = [];

    const alert = computeAlightAlert(session, NOW, COPY);

    expect(alert?.basis).toBe("schedule");
    expect(alert?.triggerAtMs).toBe(ARRIVAL_MS - SCHEDULE_FALLBACK_LEAD_MS);
  });

  it("says in the body which evidence it used", () => {
    // A rider deserves to know whether this is a live time or a timetable guess.
    expect(computeAlightAlert(riding(), NOW, COPY)?.body).toContain("captured");

    const noCapture = riding();
    noCapture.payload.startPackage.captures = [];
    expect(computeAlightAlert(noCapture, NOW, COPY)?.body).toContain("schedule");
  });

  it("names the stop and, when known, the platform", () => {
    const session = riding();
    const legs = (
      session.payload.startPackage.itinerary as { legs: Array<{ to: Record<string, unknown> }> }
    ).legs;
    legs[1].to.platformCode = "7";

    const alert = computeAlightAlert(session, NOW, COPY);

    expect(alert?.title).toContain("Messe");
    expect(alert?.body).toContain("7");
  });

  it("uses a stable identifier so a live update replaces rather than duplicates", () => {
    const first = computeAlightAlert(riding(), NOW, COPY);

    const shifted = riding();
    shifted.payload.startPackage.captures[0].stops[2].expectedDeparture = new Date(
      ARRIVAL_MS - 2 * 60_000,
    ).toISOString();
    const second = computeAlightAlert(shifted, NOW, COPY);

    expect(second?.id).toBe(first?.id);
    expect(second?.triggerAtMs).not.toBe(first?.triggerAtMs);
  });

  it("uses an identifier the reconciler recognises and that names nothing", () => {
    const alert = computeAlightAlert(riding(), NOW, COPY);

    expect(isOpenMapXNotificationId(alert?.id ?? "")).toBe(true);
    expect(alert?.id).not.toContain("Messe");
  });

  it("schedules nothing while walking, where there is no stop to miss", () => {
    expect(computeAlightAlert(transitSessionFixture(), NOW, COPY)).toBeNull();
  });

  it("schedules nothing once the rider has arrived", () => {
    const arrived = riding();
    arrived.payload.tickState.phase = "arrived";

    expect(computeAlightAlert(arrived, NOW, COPY)).toBeNull();
  });

  it.each(["arrived", "stopped", "expired", "error"] as const)(
    "schedules nothing for a %s session",
    (status) => {
      expect(computeAlightAlert(riding({ status }), NOW, COPY)).toBeNull();
    },
  );

  it("schedules nothing for a cancelled leg", () => {
    const session = riding();
    const legs = (
      session.payload.startPackage.itinerary as { legs: Array<Record<string, unknown>> }
    ).legs;
    legs[1].cancelled = true;

    expect(computeAlightAlert(session, NOW, COPY)).toBeNull();
  });

  it("schedules nothing the rider turned off", () => {
    const off = riding();
    off.payload.startPackage.settings.alightAlertsEnabled = false;

    expect(computeAlightAlert(off, NOW, COPY)).toBeNull();
  });

  it("schedules nothing for a moment that has effectively passed", () => {
    // Firing immediately would say nothing the spoken cue has not already said.
    const late = ARRIVAL_MS - 5 * 60_000 - MIN_LEAD_MS + 1;

    expect(computeAlightAlert(riding(), late, COPY)).toBeNull();
  });

  it("schedules nothing beyond the session's own lifetime", () => {
    const shortLived = riding();
    shortLived.expiresAtMs = ARRIVAL_MS - 10 * 60_000;

    expect(computeAlightAlert(shortLived, NOW, COPY)).toBeNull();
  });

  it("schedules nothing without a stop name to announce", () => {
    const nameless = riding();
    const legs = (
      nameless.payload.startPackage.itinerary as { legs: Array<{ to: { name?: string } }> }
    ).legs;
    legs[1].to.name = undefined;

    expect(computeAlightAlert(nameless, NOW, COPY)).toBeNull();
  });

  it("schedules nothing when no time can be established at all", () => {
    const timeless = riding();
    timeless.payload.startPackage.captures = [];
    const legs = (
      timeless.payload.startPackage.itinerary as { legs: Array<Record<string, unknown>> }
    ).legs;
    legs[1].endTime = undefined;
    legs[1].scheduledEndTime = undefined;

    expect(computeAlightAlert(timeless, NOW, COPY)).toBeNull();
  });
});

describe("alertHasChanged", () => {
  const alert = () => computeAlightAlert(riding(), NOW, COPY);

  it("is unchanged for the same identifier and time", () => {
    const next = alert();

    expect(
      alertHasChanged({ alertId: next?.id ?? "", triggerAtMs: next?.triggerAtMs ?? 0 }, next),
    ).toBe(false);
  });

  it("ignores a shift too small to matter", () => {
    // Cancelling and re-adding an OS request once a second is churn every
    // platform treats as abuse.
    const next = alert();

    expect(
      alertHasChanged(
        { alertId: next?.id ?? "", triggerAtMs: (next?.triggerAtMs ?? 0) + MIN_LEAD_MS - 1 },
        next,
      ),
    ).toBe(false);
  });

  it("reschedules for a meaningful shift", () => {
    const next = alert();

    expect(
      alertHasChanged(
        { alertId: next?.id ?? "", triggerAtMs: (next?.triggerAtMs ?? 0) - 120_000 },
        next,
      ),
    ).toBe(true);
  });

  it("reschedules when the leg changed", () => {
    const next = alert();

    expect(alertHasChanged({ alertId: "other", triggerAtMs: next?.triggerAtMs ?? 0 }, next)).toBe(
      true,
    );
  });

  it("cancels when there is no longer anything to schedule", () => {
    expect(alertHasChanged({ alertId: "a1", triggerAtMs: 1 }, null)).toBe(true);
  });

  it("schedules when nothing was held before", () => {
    expect(alertHasChanged(undefined, alert())).toBe(true);
  });

  it("does nothing when there was and is nothing", () => {
    expect(alertHasChanged(undefined, null)).toBe(false);
  });
});
