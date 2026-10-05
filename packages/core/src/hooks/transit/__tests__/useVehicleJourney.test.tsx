import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../../api/client";
import { createQueryWrapper } from "../../../test/queryWrapper";
import { useVehicleJourney } from "../useVehicleJourney";

describe("useVehicleJourney", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("does not share a cache entry between calls that differ only in fallback ids", async () => {
    const spy = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: { id: "t1" }, attributions: [] } as never);
    const wrapper = createQueryWrapper();

    const first = renderHook(() => useVehicleJourney("t1", ["a"]), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    const second = renderHook(() => useVehicleJourney("t1", ["b"]), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(spy).toHaveBeenCalledTimes(2);
  });
});
