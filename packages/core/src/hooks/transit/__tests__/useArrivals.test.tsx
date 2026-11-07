import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../../api/client";
import { createQueryWrapper } from "../../../test/queryWrapper";
import { useArrivals } from "../useArrivals";
import { useDepartures } from "../useDepartures";

describe.each([
  ["arrivals", useArrivals],
  ["departures", useDepartures],
] as const)("%s stop board", (board, useBoard) => {
  beforeEach(() => vi.restoreAllMocks());
  it("waits for a stop, then fetches the default and selected windows with attribution", async () => {
    const envelope = {
      data: [{ tripId: "t1", line: "S7" }],
      attributions: [{ sourceId: "motis", name: "MOTIS" }],
      freshness: undefined,
    };
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(envelope as never);
    const { result, rerender } = renderHook(
      ({ stop, minutes }: { stop: string | null; minutes?: number }) => useBoard(stop, minutes),
      {
        initialProps: { stop: null, minutes: undefined } as {
          stop: string | null;
          minutes?: number;
        },
        wrapper: createQueryWrapper(),
      },
    );
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.attributions).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    rerender({ stop: "ms:stop 1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenLastCalledWith(`/api/integrations/transit/stops/ms%3Astop%201/${board}`, {
      minutes: "60",
    });
    expect(result.current.data).toEqual([
      { tripId: "t1", line: "S7", contributors: envelope.attributions },
    ]);
    expect(result.current.attributions).toEqual(envelope.attributions);
    rerender({ stop: "ms:stop 1", minutes: 30 });
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith(
        `/api/integrations/transit/stops/ms%3Astop%201/${board}`,
        { minutes: "30" },
      ),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
