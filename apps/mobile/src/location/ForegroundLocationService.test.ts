import { ForegroundLocationService } from "./ForegroundLocationService";
import type {
  CurrentFixOptions,
  LocationDriver,
  LocationFix,
  LocationPermissionState,
} from "./LocationDriver";

const OPTIONS: CurrentFixOptions = { accuracy: "precise", timeoutMs: 10_000, maxAgeMs: 15_000 };

const fixAt = (timestampMs: number): LocationFix => ({
  coords: [8.68, 50.11],
  accuracy: 8,
  timestampMs,
});

function harness(options: {
  permission?: LocationPermissionState;
  fix?: LocationFix | null;
  sessionFix?: LocationFix | null;
  onCurrentFix?: () => void;
  nowSteps?: number[];
}) {
  const calls = { getCurrentFix: 0, requestBackground: 0, requestForeground: 0, start: 0 };
  const steps = options.nowSteps ?? [];
  let step = 0;
  const clock = () => steps[Math.min(step++, steps.length - 1)] ?? 1_000;

  const driver: LocationDriver = {
    getPermissionState: async () => options.permission ?? "foreground",
    requestForegroundPermission: async () => {
      calls.requestForeground += 1;
      return "foreground";
    },
    requestBackgroundPermission: async () => {
      calls.requestBackground += 1;
      return "background";
    },
    start: async () => {
      calls.start += 1;
    },
    stop: async () => {},
    isRunning: async () => false,
    getCurrentFix: async () => {
      calls.getCurrentFix += 1;
      options.onCurrentFix?.();
      return options.fix ?? null;
    },
  };

  const service = new ForegroundLocationService({
    driver,
    clock,
    latestSessionFix: () => options.sessionFix ?? null,
  });
  return { service, calls };
}

describe("ForegroundLocationService", () => {
  it("returns a fresh fix", async () => {
    const { service } = harness({ fix: fixAt(1_000) });

    await expect(service.getFix(OPTIONS)).resolves.toEqual({
      status: "ok",
      fix: fixAt(1_000),
    });
  });

  it("never requests background permission for a foreground action", async () => {
    const { service, calls } = harness({ fix: fixAt(1_000) });

    await service.getFix(OPTIONS);

    // Asking for Always location to centre a map is both wrong and a store
    // review finding.
    expect(calls.requestBackground).toBe(0);
    expect(calls.requestForeground).toBe(0);
  });

  it("reports a denial rather than prompting", async () => {
    const { service, calls } = harness({ permission: "denied" });

    await expect(service.getFix(OPTIONS)).resolves.toEqual({ status: "denied" });
    expect(calls.getCurrentFix).toBe(0);
  });

  it("does not prompt when permission has never been asked for", async () => {
    const { service, calls } = harness({ permission: "not-determined" });

    // The disclosure that earns that prompt belongs to starting navigation.
    await expect(service.getFix(OPTIONS)).resolves.toEqual({ status: "denied" });
    expect(calls.requestForeground).toBe(0);
  });

  it("answers from the running session rather than opening a second source", async () => {
    const { service, calls } = harness({
      sessionFix: fixAt(1_000),
      nowSteps: [1_000, 5_000],
      fix: fixAt(9_000),
    });

    const result = await service.getFix(OPTIONS);

    expect(result).toEqual({ status: "ok", fix: fixAt(1_000) });
    // A second subscription beside the live one is the duplicate producer the
    // driver boundary exists to prevent.
    expect(calls.getCurrentFix).toBe(0);
  });

  it("asks the driver when the session's fix is too old", async () => {
    const { service, calls } = harness({
      sessionFix: fixAt(1_000),
      nowSteps: [100_000, 100_000],
      fix: fixAt(100_000),
    });

    await service.getFix(OPTIONS);

    expect(calls.getCurrentFix).toBe(1);
  });

  it("distinguishes a driver that ran out of time from one that had nothing", async () => {
    // Two clock reads: one to set the deadline, one after the driver answered.
    const late = harness({ fix: null, nowSteps: [0, 60_000] });
    const empty = harness({ fix: null, nowSteps: [0, 1] });

    await expect(late.service.getFix(OPTIONS)).resolves.toEqual({ status: "timeout" });
    await expect(empty.service.getFix(OPTIONS)).resolves.toEqual({ status: "unavailable" });
  });

  it("starts no location stream of its own", async () => {
    const { service, calls } = harness({ fix: fixAt(1_000) });

    await service.getFix(OPTIONS);

    expect(calls.start).toBe(0);
  });
});
