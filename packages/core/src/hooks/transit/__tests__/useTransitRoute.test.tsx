import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../../api/client";
import { createQueryWrapper } from "../../../test/queryWrapper";
import { useTransitRoute } from "../useTransitRoute";

describe("useTransitRoute", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("unwraps the mobility envelope into data/attributions/freshness", async () => {
    const envelope = {
      data: { id: "r1", shortName: "U6" },
      attributions: [{ name: "MOTIS" }],
      freshness: { fetchedAt: "2026-06-14T00:00:00Z" },
    };
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(envelope as never);

    const { result } = renderHook(() => useTransitRoute("ms:route 1"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(envelope.data);
    expect(result.current.attributions).toEqual(envelope.attributions);
    expect(result.current.freshness).toEqual(envelope.freshness);
    expect(spy).toHaveBeenCalledWith("/api/integrations/transit/routes/ms%3Aroute%201");
  });

  it("exposes empty attributions and undefined data before fetch", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(() => useTransitRoute(null), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
    expect(result.current.attributions).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
