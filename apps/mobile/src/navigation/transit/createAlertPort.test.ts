import type { TransitMobileSession } from "@openmapx/core/navigation";
import type {
  NotificationScheduler,
  ScheduledNotification,
} from "../../notifications/NotificationScheduler";
import { migrateSessionSchema } from "../../storage/migrations";
import { SessionRepository } from "../../storage/SessionRepository";
import { openTestDatabase } from "../../storage/testing/nodeSqliteDatabase";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import type { AlightAlertCopy } from "./AlightAlertPolicy";
import { cancelOrphanedAlerts, createAlertPort } from "./createAlertPort";
import { transitSessionFixture } from "./testing/transitFixture";

const ARRIVAL_MS = new Date("2026-08-09T08:40:00Z").getTime();
const NOW = ARRIVAL_MS - 20 * 60_000;

const COPY: AlightAlertCopy = {
  title: (stop) => `Get off at ${stop}`,
  body: (stop, basis) => `${stop} — ${basis}`,
};

function riding(): TransitMobileSession {
  const base = transitSessionFixture();
  const capture = base.payload.startPackage.captures[0];
  return {
    ...base,
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
    },
  } as TransitMobileSession;
}

function fakeScheduler() {
  const calls: string[] = [];
  let held: string[] = [];
  const scheduler: NotificationScheduler = {
    prepare: async () => undefined,
    scheduleAlight: async () => undefined,
    scheduleCriticalInterruption: async () => undefined,
    cancel: async (id) => {
      calls.push(`cancel:${id}`);
      held = held.filter((entry) => entry !== id);
    },
    cancelSession: async (ids) => {
      for (const id of ids) {
        calls.push(`cancel:${id}`);
        held = held.filter((entry) => entry !== id);
      }
    },
    pending: async () => [...held],
    reconcile: async (records: readonly ScheduledNotification[]) => {
      calls.push(`reconcile:${records.map((r) => r.id).join(",") || "none"}`);
      held = records.map((record) => record.id);
      return { scheduled: records.length, cancelled: 0, orphans: 0 };
    },
  };
  return { scheduler, calls, held: () => held };
}

async function harness(options: { available?: boolean } = {}) {
  const database = openTestDatabase();
  await migrateSessionSchema(database, 1_000);
  const repository = new SessionRepository(database);
  const { scheduler, calls, held } = fakeScheduler();
  const port = createAlertPort({
    repository,
    scheduler,
    copy: COPY,
    now: () => NOW,
    isAvailable: () => options.available !== false,
  });
  return { repository, port, scheduler, calls, held, close: () => database.closeAsync() };
}

describe("createAlertPort.reconcile", () => {
  it("schedules the alert the policy computed", async () => {
    const context = await harness();
    await context.repository.createPreparing(riding());

    await context.port.reconcile("session-t1");

    const recorded = await context.repository.listScheduledAlerts("session-t1");
    expect(recorded).toHaveLength(1);
    expect(context.held()).toEqual([recorded[0].alertId]);
    await context.close();
  });

  it("does not reschedule when nothing meaningfully changed", async () => {
    // A cancel-and-re-add every tick is churn platforms rate-limit, and it opens
    // a window with no alert scheduled at all.
    const context = await harness();
    await context.repository.createPreparing(riding());
    await context.port.reconcile("session-t1");
    const first = await context.repository.listScheduledAlerts("session-t1");

    await context.port.reconcile("session-t1");

    // The row is untouched: same identifier, same trigger, no cancel issued.
    expect(await context.repository.listScheduledAlerts("session-t1")).toEqual(first);
    expect(context.calls.filter((call) => call.startsWith("cancel:"))).toEqual([]);
    await context.close();
  });

  it("still asks the scheduler, because the system may have lost the request", async () => {
    const context = await harness();
    await context.repository.createPreparing(riding());
    await context.port.reconcile("session-t1");

    await context.port.reconcile("session-t1");

    expect(context.calls.filter((call) => call.startsWith("reconcile:"))).toHaveLength(2);
    await context.close();
  });

  it("reschedules under the same identifier when the time shifts", async () => {
    const context = await harness();
    await context.repository.createPreparing(riding());
    await context.port.reconcile("session-t1");
    const before = (await context.repository.listScheduledAlerts("session-t1"))[0];

    const shifted = riding();
    shifted.payload.startPackage.captures[0].stops[2].expectedDeparture = new Date(
      ARRIVAL_MS - 1 * 60_000,
    ).toISOString();
    await context.repository.terminate("session-t1", "stopped", NOW);
    await context.repository.createPreparing(shifted);
    await context.port.reconcile("session-t1");

    const after = (await context.repository.listScheduledAlerts("session-t1"))[0];
    expect(after.alertId).toBe(before.alertId);
    expect(after.triggerAtMs).not.toBe(before.triggerAtMs);
    await context.close();
  });

  it("schedules nothing when the rider declined the permission", async () => {
    // Navigation still runs; the page reports the backup as unavailable.
    const context = await harness({ available: false });
    await context.repository.createPreparing(riding());

    await context.port.reconcile("session-t1");

    expect(await context.repository.listScheduledAlerts("session-t1")).toEqual([]);
    expect(context.calls).toEqual([]);
    await context.close();
  });

  it("clears the alert once there is nothing to schedule", async () => {
    const context = await harness();
    await context.repository.createPreparing(riding());
    await context.port.reconcile("session-t1");

    const arrived = riding();
    arrived.payload.tickState.phase = "arrived";
    await context.repository.terminate("session-t1", "stopped", NOW);
    await context.repository.createPreparing(arrived);
    await context.port.reconcile("session-t1");

    expect(await context.repository.listScheduledAlerts("session-t1")).toEqual([]);
    expect(context.held()).toEqual([]);
    await context.close();
  });

  it("ignores a reconcile for a session that is no longer active", async () => {
    const context = await harness();
    await context.repository.createPreparing(riding());

    await context.port.reconcile("some-other-session");

    expect(context.calls).toEqual([]);
    await context.close();
  });

  it("ignores a ground session, which has no stop to miss", async () => {
    const context = await harness();
    await context.repository.createPreparing(groundSessionFixture({ status: "active" }));

    await context.port.reconcile("session-1");

    expect(context.calls).toEqual([]);
    await context.close();
  });
});

describe("createAlertPort.cancelSession", () => {
  it("cancels at the operating system before forgetting the row", async () => {
    // The other order would leave an alert nothing knows how to cancel if this
    // crashed between the two.
    const context = await harness();
    await context.repository.createPreparing(riding());
    await context.port.reconcile("session-t1");
    const scheduled = (await context.repository.listScheduledAlerts("session-t1"))[0];

    await context.port.cancelSession("session-t1");

    expect(context.calls).toContain(`cancel:${scheduled.alertId}`);
    expect(await context.repository.listScheduledAlerts("session-t1")).toEqual([]);
    expect(context.held()).toEqual([]);
    await context.close();
  });

  it("is safe to call when nothing was scheduled", async () => {
    const context = await harness();

    await expect(context.port.cancelSession("session-t1")).resolves.toBeUndefined();
    await context.close();
  });
});

describe("cancelOrphanedAlerts", () => {
  it("removes an alert whose session no longer exists", async () => {
    // A force-stop can leave the system holding a request for a trip that
    // ended; without this it fires hours later about a train nobody is on.
    const context = await harness();
    await context.repository.createPreparing(riding());
    await context.port.reconcile("session-t1");
    await context.repository.terminate("session-t1", "stopped", NOW);

    const removed = await cancelOrphanedAlerts({
      repository: context.repository,
      scheduler: context.scheduler,
      now: () => NOW,
    });

    expect(removed).toBe(1);
    expect(context.held()).toEqual([]);
    await context.close();
  });

  it("keeps an alert the active session still owns", async () => {
    const context = await harness();
    await context.repository.createPreparing(riding());
    await context.port.reconcile("session-t1");

    const removed = await cancelOrphanedAlerts({
      repository: context.repository,
      scheduler: context.scheduler,
      now: () => NOW,
    });

    expect(removed).toBe(0);
    expect(context.held()).toHaveLength(1);
    await context.close();
  });

  it("does nothing when the system holds nothing", async () => {
    const context = await harness();

    expect(
      await cancelOrphanedAlerts({
        repository: context.repository,
        scheduler: context.scheduler,
        now: () => NOW,
      }),
    ).toBe(0);
    await context.close();
  });
});
