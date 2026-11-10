import { TRANSIT_UNDO_WINDOW_MS } from "@openmapx/core/navigation";
import { groundSessionFixture } from "../storage/testing/sessionFixture";
import { locationReleaseAtMs } from "./arrival";
import { transitSessionFixture } from "./transit/testing/transitFixture";

const NOW = 1_700_000_500_000;

describe("locationReleaseAtMs", () => {
  it("keeps the stream for sessions that have not arrived", () => {
    expect(locationReleaseAtMs(groundSessionFixture({ status: "active" }))).toBeNull();
    expect(locationReleaseAtMs(transitSessionFixture({ status: "preparing" }))).toBeNull();
  });

  it("releases a road trip at its arrival", () => {
    const arrived = groundSessionFixture({ status: "arrived", updatedAtMs: NOW });
    expect(locationReleaseAtMs(arrived)).toBe(NOW);
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

  it("releases a transit arrival at once when there is nothing to undo", () => {
    const arrived = transitSessionFixture({ status: "arrived", updatedAtMs: NOW });
    expect(locationReleaseAtMs(arrived)).toBe(NOW);
  });
});
