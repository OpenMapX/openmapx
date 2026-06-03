import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { fetchSpeedLimit } from "./speedLimit";

describe("fetchSpeedLimit", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns the edge speedLimit for the last matched point", async () => {
    vi.spyOn(apiClient, "post").mockResolvedValue({
      geometry: [],
      mode: "driving",
      edges: [
        { length: 10, speedLimit: 30 },
        { length: 20, speedLimit: 50 },
      ],
      points: [
        { lat: 0, lng: 0, type: "matched", edgeIndex: 0 },
        { lat: 1, lng: 1, type: "matched", edgeIndex: 1 },
      ],
    } as never);
    const limit = await fetchSpeedLimit(
      [
        [13.3765, 52.5096],
        [13.377, 52.511],
      ],
      "driving",
    );
    expect(limit).toBe(50);
  });

  it("returns null when the matched edge has speedLimit <= 0", async () => {
    vi.spyOn(apiClient, "post").mockResolvedValue({
      geometry: [],
      mode: "driving",
      edges: [{ length: 10, speedLimit: 0 }],
      points: [{ lat: 0, lng: 0, type: "matched", edgeIndex: 0 }],
    } as never);
    const limit = await fetchSpeedLimit(
      [
        [13.3765, 52.5096],
        [13.377, 52.511],
      ],
      "driving",
    );
    expect(limit).toBeNull();
  });

  it("returns null when the matched edge has no speedLimit", async () => {
    vi.spyOn(apiClient, "post").mockResolvedValue({
      geometry: [],
      mode: "driving",
      edges: [{ length: 10 }],
      points: [{ lat: 0, lng: 0, type: "matched", edgeIndex: 0 }],
    } as never);
    const limit = await fetchSpeedLimit(
      [
        [13.3765, 52.5096],
        [13.377, 52.511],
      ],
      "driving",
    );
    expect(limit).toBeNull();
  });

  it("returns null when the last point has no edgeIndex", async () => {
    vi.spyOn(apiClient, "post").mockResolvedValue({
      geometry: [],
      mode: "driving",
      edges: [{ length: 10, speedLimit: 50 }],
      points: [{ lat: 0, lng: 0, type: "unmatched" }],
    } as never);
    const limit = await fetchSpeedLimit(
      [
        [13.3765, 52.5096],
        [13.377, 52.511],
      ],
      "driving",
    );
    expect(limit).toBeNull();
  });

  it("returns null for a trace with fewer than 2 points without calling the API", async () => {
    const spy = vi.spyOn(apiClient, "post");
    const limit = await fetchSpeedLimit([[13.3765, 52.5096]], "driving");
    expect(limit).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null when the request throws", async () => {
    vi.spyOn(apiClient, "post").mockRejectedValue(new Error("boom"));
    const limit = await fetchSpeedLimit(
      [
        [13.3765, 52.5096],
        [13.377, 52.511],
      ],
      "driving",
    );
    expect(limit).toBeNull();
  });
});
