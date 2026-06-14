import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../../api/client";
import { createQueryWrapper } from "../../../test/queryWrapper";
import { useStopTimetable } from "../useStopTimetable";

describe("useStopTimetable", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches the timetable for a stop on a given date", async () => {
    const envelope = {
      data: [{ tripId: "t1", line: "U2" }],
      attributions: [{ name: "MOTIS" }],
      freshness: undefined,
    };
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(envelope as never);

    const { result } = renderHook(() => useStopTimetable("ms:stop 1", "2026-06-14"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(envelope.data);
    expect(result.current.attributions).toEqual(envelope.attributions);
    expect(spy).toHaveBeenCalledWith("/api/integrations/transit/stops/ms%3Astop%201/timetable", {
      date: "2026-06-14",
    });
  });

  it("omits the date param when none is supplied", async () => {
    const spy = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: [], attributions: [] } as never);

    const { result } = renderHook(() => useStopTimetable("s1"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith("/api/integrations/transit/stops/s1/timetable", {});
  });

  it("does not fire when the stop id is null", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(() => useStopTimetable(null), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.attributions).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
