import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../../api/client";
import { API_ENDPOINTS } from "../../../api/endpoints";
import { createQueryWrapper } from "../../../test/queryWrapper";
import { useStopSearch } from "../useStopSearch";

describe("useStopSearch", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("searches stops by name and unwraps the envelope", async () => {
    const envelope = {
      data: [{ id: "ms:s1", name: "Hauptbahnhof" }],
      attributions: [{ name: "MOTIS" }],
      freshness: undefined,
    };
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(envelope as never);

    const { result } = renderHook(() => useStopSearch("Haupt"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(envelope.data);
    expect(result.current.attributions).toEqual(envelope.attributions);
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.transitStopSearch, {
      q: "Haupt",
      limit: "3",
    });
  });

  it("does not fire for queries shorter than 2 characters", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(() => useStopSearch("H"), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.attributions).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
