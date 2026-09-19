import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";
import { fetchJunctionLookups } from "./junctions";

const point = {
  lng: 6.6768,
  lat: 51.1789,
  bearing: 283,
  trace: [
    [6.68, 51.178],
    [6.6768, 51.1789],
  ] as [number, number][],
};

describe("fetchJunctionLookups", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("posts the points and returns the junctions", async () => {
    const post = vi
      .spyOn(apiClient, "post")
      .mockResolvedValue({ junctions: [{ index: 0, approach: [], ramps: [] }] } as never);
    const result = await fetchJunctionLookups([point]);
    expect(post).toHaveBeenCalledWith(API_ENDPOINTS.navigationJunctions, { points: [point] });
    expect(result).toEqual([{ index: 0, approach: [], ramps: [] }]);
  });

  it("answers null on any error, so a failed request is not mistaken for an empty answer", async () => {
    vi.spyOn(apiClient, "post").mockRejectedValue(new Error("offline"));
    expect(await fetchJunctionLookups([point])).toBeNull();
  });
});
