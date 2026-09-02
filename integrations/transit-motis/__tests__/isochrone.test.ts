import { TRANSIT_WALK_PROFILE } from "@openmapx/mobility-core/transit-reachability";
import { beforeEach, describe, expect, it, vi } from "vitest";

const oneToManyIntermodalPost = vi.fn();
vi.mock("@motis-project/motis-client", () => ({
  oneToAll: vi.fn(),
  oneToManyIntermodalPost: (...args: unknown[]) => oneToManyIntermodalPost(...args),
}));

const { sampleMotisTravelTimeField } = await import("../isochrone.js");

const INSTANCE = { client: {}, prefix: "ms:", provider: "ms" } as never;
const REQUEST = {
  origin: { lng: 13.4, lat: 52.5 },
  queryTime: "2026-09-01T08:00:00.000Z",
  direction: "depart-at" as const,
  thresholdsMinutes: [30],
  walkProfileId: TRANSIT_WALK_PROFILE.id,
  bbox: [13.38, 52.49, 13.42, 52.51] as [number, number, number, number],
};

/** Respond with a fixed duration for every destination in the batch. */
function respondWith(durationSeconds: number | null) {
  oneToManyIntermodalPost.mockImplementation(async ({ body }) => ({
    data: {
      street_durations: body.many.map(() => ({ duration: durationSeconds })),
      transit_durations: body.many.map(() => []),
    },
  }));
}

beforeEach(() => {
  oneToManyIntermodalPost.mockReset();
});

describe("sampleMotisTravelTimeField", () => {
  it("samples every lattice point and preserves lattice order", async () => {
    respondWith(120);
    const field = await sampleMotisTravelTimeField(INSTANCE, REQUEST, {
      maxBatchSize: 128,
      maxSamples: 64,
      deadlineMs: 60_000,
    });
    expect(field.values).toHaveLength(field.lattice.nx * field.lattice.ny);
    expect(field.values.every((value) => value === 120)).toBe(true);
  });

  it("splits into batches no larger than the advertised limit", async () => {
    respondWith(120);
    const field = await sampleMotisTravelTimeField(INSTANCE, REQUEST, {
      maxBatchSize: 16,
      maxSamples: 64,
      deadlineMs: 60_000,
    });
    for (const call of oneToManyIntermodalPost.mock.calls) {
      expect(call[0].body.many.length).toBeLessThanOrEqual(16);
    }
    expect(field.batchCount).toBe(oneToManyIntermodalPost.mock.calls.length);
    expect(field.batchCount).toBeGreaterThan(1);
  });

  it("never exceeds 128 even when the runtime advertises more", async () => {
    respondWith(120);
    await sampleMotisTravelTimeField(INSTANCE, REQUEST, {
      maxBatchSize: 4_096,
      maxSamples: 512,
      deadlineMs: 60_000,
    });
    for (const call of oneToManyIntermodalPost.mock.calls) {
      expect(call[0].body.many.length).toBeLessThanOrEqual(128);
    }
  });

  it("sends the shared walk profile, never client-chosen options", async () => {
    respondWith(120);
    await sampleMotisTravelTimeField(INSTANCE, REQUEST, {
      maxBatchSize: 128,
      maxSamples: 64,
      deadlineMs: 60_000,
    });
    const { body } = oneToManyIntermodalPost.mock.calls[0][0];
    expect(body.pedestrianProfile).toBe(TRANSIT_WALK_PROFILE.pedestrianProfile);
    expect(body.pedestrianSpeed).toBe(TRANSIT_WALK_PROFILE.speedMetresPerSecond);
    expect(body.maxPostTransitTime).toBe(TRANSIT_WALK_PROFILE.egressSeconds);
    expect(body.arriveBy).toBe(false);
  });

  it("records unreachable points as null rather than a sentinel", async () => {
    respondWith(null);
    const field = await sampleMotisTravelTimeField(INSTANCE, REQUEST, {
      maxBatchSize: 128,
      maxSamples: 64,
      deadlineMs: 60_000,
    });
    expect(field.values.every((value) => value === null)).toBe(true);
    expect(field.unreachableCount).toBe(field.values.length);
  });

  it("fails the whole sample when any batch fails, rather than returning a partial field", async () => {
    let call = 0;
    oneToManyIntermodalPost.mockImplementation(async ({ body }) => {
      call += 1;
      if (call === 2) throw new Error("upstream exploded");
      return {
        data: {
          street_durations: body.many.map(() => ({ duration: 120 })),
          transit_durations: body.many.map(() => []),
        },
      };
    });
    await expect(
      sampleMotisTravelTimeField(INSTANCE, REQUEST, {
        maxBatchSize: 16,
        maxSamples: 64,
        deadlineMs: 60_000,
      }),
    ).rejects.toThrow(/sampling failed/i);
  });

  it("fails when a response does not align with its batch", async () => {
    oneToManyIntermodalPost.mockResolvedValue({
      data: { street_durations: [{ duration: 1 }], transit_durations: [[]] },
    });
    await expect(
      sampleMotisTravelTimeField(INSTANCE, REQUEST, {
        maxBatchSize: 16,
        maxSamples: 64,
        deadlineMs: 60_000,
      }),
    ).rejects.toThrow(/align/i);
  });

  it("aborts when the caller's signal is already aborted", async () => {
    respondWith(120);
    await expect(
      sampleMotisTravelTimeField(
        INSTANCE,
        REQUEST,
        { maxBatchSize: 16, maxSamples: 64, deadlineMs: 60_000 },
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(oneToManyIntermodalPost).not.toHaveBeenCalled();
  });
});
