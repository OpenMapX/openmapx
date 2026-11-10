import { TRANSIT_UNDO_WINDOW_MS } from "@openmapx/core/navigation";
import { groundSessionFixture } from "../storage/testing/sessionFixture";
import { ARRIVAL_CUE_GRACE_MS, locationReleaseAtMs } from "./arrival";
import { transitSessionFixture } from "./transit/testing/transitFixture";

const NOW = 1_700_000_500_000;

describe("locationReleaseAtMs", () => {
  it("keeps the stream for sessions that have not arrived", () => {
    expect(locationReleaseAtMs(groundSessionFixture({ status: "active" }))).toBeNull();
    expect(locationReleaseAtMs(transitSessionFixture({ status: "preparing" }))).toBeNull();
  });

  it("releases a road trip once its arrival announcement has had time to play", () => {
    const arrived = groundSessionFixture({ status: "arrived", updatedAtMs: NOW });
    expect(locationReleaseAtMs(arrived)).toBe(NOW + ARRIVAL_CUE_GRACE_MS);
  });

  it("keeps a transit arrival tracked until its last tap can no longer be undone", () => {
    const base = transitSessionFixture({ status: "arrived", updatedAtMs: NOW });
    const arrived = {
      ...base,
      payload: {
        ...base.payload,
        tickState: {
          ...base.payload.tickState,
          phase: "arrived" as const,
          lastAction: {
            type: "alight" as const,
            legIndex: 1,
            atMs: NOW,
            previous: {
              currentLegIndex: 1,
              phase: "riding" as const,
              currentWalkStepIndex: 0,
              stopCursor: 1,
              alongMeters: 0,
            },
          },
        },
      },
    };
    expect(locationReleaseAtMs(arrived)).toBe(NOW + TRANSIT_UNDO_WINDOW_MS + 1);
  });

  it("releases a transit arrival with nothing to undo after the announcement grace", () => {
    const arrived = transitSessionFixture({ status: "arrived", updatedAtMs: NOW });
    expect(locationReleaseAtMs(arrived)).toBe(NOW + ARRIVAL_CUE_GRACE_MS);
  });

  it("keeps the announcement grace when the last tap's undo window is already closing", () => {
    const base = transitSessionFixture({ status: "arrived", updatedAtMs: NOW });
    const arrived = {
      ...base,
      payload: {
        ...base.payload,
        tickState: {
          ...base.payload.tickState,
          phase: "arrived" as const,
          lastAction: {
            type: "board" as const,
            legIndex: 1,
            atMs: NOW - TRANSIT_UNDO_WINDOW_MS + 1_000,
            previous: {
              currentLegIndex: 0,
              phase: "walking" as const,
              currentWalkStepIndex: 0,
              stopCursor: 1,
              alongMeters: 0,
            },
          },
        },
      },
    };
    expect(locationReleaseAtMs(arrived)).toBe(NOW + ARRIVAL_CUE_GRACE_MS);
  });
});
