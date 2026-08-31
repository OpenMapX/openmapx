import { EMPTY_PROBE_STATE, type FeasibilityProbeState } from "../storage/feasibilityRepository";
import { handleFeasibilityBatch, type RawLocation } from "./handleFeasibilityBatch";

const NOW = 1_700_000_000_000;

/** In-memory stand-in for the SQLite repository, with a commit counter. */
function fakeRepository(initial: Partial<FeasibilityProbeState> = {}) {
  let state: FeasibilityProbeState = { ...EMPTY_PROBE_STATE, ...initial };
  let commits = 0;
  return {
    get state() {
      return state;
    },
    get commits() {
      return commits;
    },
    read: async () => state,
    commit: async (mutate: (current: FeasibilityProbeState) => FeasibilityProbeState) => {
      commits += 1;
      state = mutate(state);
      return state;
    },
  };
}

function fix(timestampMs: number, overrides: Partial<RawLocation["coords"]> = {}): RawLocation {
  return {
    timestamp: timestampMs,
    coords: { latitude: 50.11, longitude: 8.68, accuracy: 5, ...overrides },
  };
}

describe("handleFeasibilityBatch ordering and deduplication", () => {
  it("persists the canonical batch count and newest timestamp", async () => {
    const repository = fakeRepository();
    await handleFeasibilityBatch(
      {
        locations: [fix(NOW - 1_000), fix(NOW - 3_000), fix(NOW - 2_000), fix(NOW - 2_000)],
      },
      { repository, nowMs: NOW },
    );
    expect(repository.state.acceptedFixCount).toBe(3);
    expect(repository.state.rejectedFixCount).toBe(0);
    expect(repository.state.lastTimestampMs).toBe(NOW - 1_000);
  });

  it("commits exactly once per callback, not once per fix", async () => {
    const repository = fakeRepository();
    await handleFeasibilityBatch(
      { locations: [fix(NOW - 3_000), fix(NOW - 2_000), fix(NOW - 1_000)] },
      { repository, nowMs: NOW },
    );
    expect(repository.commits).toBe(1);
  });
});

describe("handleFeasibilityBatch rejection", () => {
  it("keeps processing the valid fixes in a partially invalid batch", async () => {
    const repository = fakeRepository();
    await handleFeasibilityBatch(
      { locations: [fix(NOW - 3_000, { latitude: 999 }), fix(NOW - 1_000)] },
      { repository, nowMs: NOW },
    );
    expect(repository.state.acceptedFixCount).toBe(1);
    expect(repository.state.rejectedFixCount).toBe(1);
  });

  it("still records the callback when every fix is rejected", async () => {
    const repository = fakeRepository();
    await handleFeasibilityBatch(
      { locations: [fix(NOW - 1_000, { accuracy: -5 })] },
      { repository, nowMs: NOW },
    );
    expect(repository.state.callbackCount).toBe(1);
  });
});

describe("handleFeasibilityBatch measurements", () => {
  it("records an accuracy bucket rather than the raw accuracy", async () => {
    const repository = fakeRepository();
    await handleFeasibilityBatch(
      { locations: [fix(NOW - 1_000, { accuracy: 27 })] },
      { repository, nowMs: NOW },
    );
    expect(repository.state.lastAccuracyBucket).toBe("fair");
    expect(JSON.stringify(repository.state)).not.toContain("27");
  });

  it("tracks the gap between callbacks and its maximum", async () => {
    const repository = fakeRepository();
    await handleFeasibilityBatch({ locations: [fix(NOW - 1_000)] }, { repository, nowMs: NOW });
    await handleFeasibilityBatch(
      { locations: [fix(NOW + 4_000)] },
      { repository, nowMs: NOW + 5_000 },
    );
    await handleFeasibilityBatch(
      { locations: [fix(NOW + 6_000)] },
      { repository, nowMs: NOW + 7_000 },
    );
    expect(repository.state.lastCallbackGapMs).toBe(2_000);
    expect(repository.state.maxCallbackGapMs).toBe(5_000);
  });

  it("never persists a coordinate", async () => {
    const repository = fakeRepository();
    await handleFeasibilityBatch(
      { locations: [fix(NOW - 1_000, { latitude: 52.520008, longitude: 13.404954 })] },
      { repository, nowMs: NOW },
    );
    const serialized = JSON.stringify(repository.state);
    expect(serialized).not.toContain("52.52");
    expect(serialized).not.toContain("13.40");
  });
});

describe("handleFeasibilityBatch failure handling", () => {
  it("persists a redacted error code from the task callback", async () => {
    const repository = fakeRepository();
    await handleFeasibilityBatch(
      { locations: [], errorCode: "E_LOCATION_UNAUTHORIZED" },
      { repository, nowMs: NOW },
    );
    expect(repository.state.lastErrorCode).toBe("E_LOCATION_UNAUTHORIZED");
  });

  it("truncates an unexpectedly long error code instead of storing it whole", async () => {
    const repository = fakeRepository();
    await handleFeasibilityBatch(
      { locations: [], errorCode: "E_".concat("X".repeat(500)) },
      { repository, nowMs: NOW },
    );
    expect((repository.state.lastErrorCode ?? "").length).toBeLessThanOrEqual(64);
  });

  it("never rejects, so a failing store cannot throw-loop the OS task", async () => {
    const repository = {
      read: async () => ({ ...EMPTY_PROBE_STATE }),
      commit: async () => {
        throw new Error("disk full");
      },
    };
    await expect(
      handleFeasibilityBatch({ locations: [fix(NOW - 1_000)] }, { repository, nowMs: NOW }),
    ).resolves.toEqual([]);
  });

  it("returns no effects for an empty callback", async () => {
    const repository = fakeRepository();
    await expect(
      handleFeasibilityBatch({ locations: [] }, { repository, nowMs: NOW }),
    ).resolves.toEqual([]);
  });
});

describe("handleFeasibilityBatch audio probe", () => {
  it("returns a speak intent only after the probe is armed and the state is committed", async () => {
    const repository = fakeRepository({ pendingAudioProbe: true });
    const effects = await handleFeasibilityBatch(
      { locations: [fix(NOW - 1_000)] },
      { repository, nowMs: NOW },
    );
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ kind: "speak", locale: "en" });
    // Cleared in the same transaction, so a crash before speaking loses the
    // prompt rather than repeating it on the next callback.
    expect(repository.state.pendingAudioProbe).toBe(false);
  });

  it("does not speak when the probe was never armed", async () => {
    const repository = fakeRepository();
    await expect(
      handleFeasibilityBatch({ locations: [fix(NOW - 1_000)] }, { repository, nowMs: NOW }),
    ).resolves.toEqual([]);
  });

  it("does not speak when the callback delivered no acceptable fix", async () => {
    const repository = fakeRepository({ pendingAudioProbe: true });
    await expect(
      handleFeasibilityBatch(
        { locations: [fix(NOW - 1_000, { accuracy: -1 })] },
        { repository, nowMs: NOW },
      ),
    ).resolves.toEqual([]);
    expect(repository.state.pendingAudioProbe).toBe(true);
  });

  it("uses a cue ID that is stable for the callback and carries no location", async () => {
    const repository = fakeRepository({ pendingAudioProbe: true, callbackCount: 41 });
    const [effect] = await handleFeasibilityBatch(
      { locations: [fix(NOW - 1_000)] },
      { repository, nowMs: NOW },
    );
    expect(effect).toMatchObject({ cueId: "probe:42" });
    expect(JSON.stringify(effect)).not.toContain("50.11");
  });
});
