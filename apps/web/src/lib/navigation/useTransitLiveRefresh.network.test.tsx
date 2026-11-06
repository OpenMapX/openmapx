import { apiClient, useNavigationStore } from "@openmapx/core";
import { onlineManager } from "@tanstack/react-query";
import { act, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderHookWithQuery } from "@/test/query";
import { useTransitLiveRefresh } from "./useTransitLiveRefresh";

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  useNavigationStore.getState().stopNavigation();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("does not queue a paused token mutation that could resume after unmount", async () => {
  vi.useFakeTimers();
  const post = vi.spyOn(apiClient, "post");
  useNavigationStore.getState().startTransitNavigation({
    refreshToken: "unused",
    legs: [],
    duration: 0,
    startTime: "",
    endTime: "",
    transfers: 0,
    walkDistance: 0,
  });
  onlineManager.setOnline(false);
  const view = renderHookWithQuery(() => useTransitLiveRefresh(true));
  await act(async () => vi.advanceTimersByTime(30000));
  expect(
    view.queryClient
      .getMutationCache()
      .getAll()
      .some((m) => m.state.isPaused),
  ).toBe(false);
  view.unmount();
  await act(async () => onlineManager.setOnline(true));
  expect(post).not.toHaveBeenCalled();
  expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(false);
});
