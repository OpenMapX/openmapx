import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../../api/client";
import { createQueryWrapper } from "../../../test/queryWrapper";
import { useArrivals } from "../useArrivals";

describe("useArrivals", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches arrivals for a stop and forwards the minutes window", async () => {
    const envelope = {
      data: [{ tripId: "t1", line: "S7" }],
      attributions: [{ name: "MOTIS" }],
      freshness: undefined,
    };
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(envelope as never);

    const { result } = renderHook(() => useArrivals("ms:stop 1", 30), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(envelope.data);
    expect(result.current.attributions).toEqual(envelope.attributions);
    expect(spy).toHaveBeenCalledWith("/api/integrations/transit/stops/ms%3Astop%201/arrivals", {
      minutes: "30",
    });
  });

  it("defaults the minutes window to 60", async () => {
    const spy = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: [], attributions: [] } as never);

    const { result } = renderHook(() => useArrivals("s1"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith("/api/integrations/transit/stops/s1/arrivals", {
      minutes: "60",
    });
  });

  it("does not fire when the stop id is null", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(() => useArrivals(null), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.attributions).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
