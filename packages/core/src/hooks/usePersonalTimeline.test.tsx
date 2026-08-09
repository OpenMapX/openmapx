import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { ApiError, apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import {
  PERSONAL_TIMELINE_QUERY_KEY,
  type PersonalTimelineApiError,
  useConnectTimeline,
  useDisconnectTimeline,
  usePersonalTimelineDay,
  useTestTimelineConnection,
  useTimelineConnection,
} from "./usePersonalTimeline";

function wrapperWith(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => vi.restoreAllMocks());

describe("personal timeline hooks", () => {
  it("uses a stable connection key and fetches safe connection metadata", async () => {
    const client = queryClient();
    const response = { connected: false, connection: null };
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(response as never);

    const { result } = renderHook(() => useTimelineConnection(), {
      wrapper: wrapperWith(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(response);
    expect(get).toHaveBeenCalledWith(API_ENDPOINTS.timelineConnection);
    expect(
      client.getQueryCache().find({ queryKey: [...PERSONAL_TIMELINE_QUERY_KEY, "connection"] }),
    ).toBeDefined();
  });

  it("gates day reads and uses the exact in-memory day key and lifetimes", async () => {
    const client = queryClient();
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ version: 1 } as never);
    const { result, rerender } = renderHook(
      ({ enabled }) => usePersonalTimelineDay("2026-08-09", enabled),
      { wrapper: wrapperWith(client), initialProps: { enabled: false } },
    );

    expectTypeOf(result.current.error).toEqualTypeOf<PersonalTimelineApiError | null>();

    expect(result.current.fetchStatus).toBe("idle");
    expect(get).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const query = client.getQueryCache().find({
      queryKey: [...PERSONAL_TIMELINE_QUERY_KEY, "day", "2026-08-09"],
    });
    expect(query).toBeDefined();
    expect(query?.observers[0]?.options.staleTime).toBe(30_000);
    expect(query?.gcTime).toBe(300_000);
    expect(get).toHaveBeenCalledWith(`${API_ENDPOINTS.timelineDay}/2026-08-09`);
  });

  it.each([
    { status: 503, code: "TIMELINE_UPSTREAM_UNAVAILABLE", first: true, second: false },
    { status: 401, code: "UNAUTHORIZED", first: false, second: false },
    { status: 404, code: "TIMELINE_NOT_CONNECTED", first: false, second: false },
    { status: 409, code: "TIMELINE_MANAGED_DISABLED", first: false, second: false },
    { status: 422, code: "TIMELINE_CREDENTIAL_INVALID", first: false, second: false },
    { status: 429, code: "TIMELINE_RATE_LIMITED", first: false, second: false },
  ])("uses the typed retry policy for $status/$code", ({ status, code, first, second }) => {
    const client = queryClient();
    renderHook(() => usePersonalTimelineDay("2026-08-09", false), {
      wrapper: wrapperWith(client),
    });
    const query = client.getQueryCache().find({
      queryKey: [...PERSONAL_TIMELINE_QUERY_KEY, "day", "2026-08-09"],
    });
    const retry = query?.options.retry;
    expect(typeof retry).toBe("function");
    const error = new ApiError("safe", status, code, null);

    expect((retry as (failureCount: number, error: Error) => boolean)(0, error)).toBe(first);
    expect((retry as (failureCount: number, error: Error) => boolean)(1, error)).toBe(second);
  });

  it("invalidates all connection/day queries after connect and test", async () => {
    const client = queryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
    vi.spyOn(apiClient, "put").mockResolvedValue({ connected: true } as never);
    vi.spyOn(apiClient, "post").mockResolvedValue({ connected: true } as never);
    const connect = renderHook(() => useConnectTimeline(), { wrapper: wrapperWith(client) });
    const testConnection = renderHook(() => useTestTimelineConnection(), {
      wrapper: wrapperWith(client),
    });

    await act(async () => {
      await connect.result.current.mutateAsync({ mode: "managed", apiKey: "fixture-key" });
      await testConnection.result.current.mutateAsync();
    });

    expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: PERSONAL_TIMELINE_QUERY_KEY });
    expect(invalidate).toHaveBeenNthCalledWith(2, { queryKey: PERSONAL_TIMELINE_QUERY_KEY });
  });

  it("removes all personal timeline data from memory after disconnect", async () => {
    const client = queryClient();
    client.setQueryData([...PERSONAL_TIMELINE_QUERY_KEY, "day", "2026-08-09"], {
      private: true,
    });
    vi.spyOn(apiClient, "delete").mockResolvedValue({ ok: true } as never);
    const remove = vi.spyOn(client, "removeQueries");
    const { result } = renderHook(() => useDisconnectTimeline(), { wrapper: wrapperWith(client) });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(remove).toHaveBeenCalledWith({ queryKey: PERSONAL_TIMELINE_QUERY_KEY });
    expect(
      client.getQueryData([...PERSONAL_TIMELINE_QUERY_KEY, "day", "2026-08-09"]),
    ).toBeUndefined();
  });
});
