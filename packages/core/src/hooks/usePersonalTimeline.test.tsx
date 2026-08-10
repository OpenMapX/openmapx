import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { ApiClientError, apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { PersonalTimelineApiError } from "../api/personalTimeline";
import { usePersonalTimelineStore } from "../stores/personalTimelineStore";
import {
  PERSONAL_TIMELINE_QUERY_KEY,
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

afterEach(() => {
  onlineManager.setOnline(true);
  usePersonalTimelineStore.getState().resetForSession();
  vi.restoreAllMocks();
});

describe("personal timeline hooks", () => {
  it("uses a stable connection key and fetches safe connection metadata", async () => {
    const client = queryClient();
    const response = { connected: false, connection: null };
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(response as never);

    const { result } = renderHook(() => useTimelineConnection("user-a"), {
      wrapper: wrapperWith(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(response);
    expect(get).toHaveBeenCalledWith(API_ENDPOINTS.timelineConnection);
    expect(
      client
        .getQueryCache()
        .find({ queryKey: [...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "connection"] }),
    ).toBeDefined();
  });

  it("gates day reads and uses the exact in-memory day key and lifetimes", async () => {
    const client = queryClient();
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ version: 1 } as never);
    const { result, rerender } = renderHook(
      ({ enabled }) => usePersonalTimelineDay("user-a", "2026-08-09", enabled),
      { wrapper: wrapperWith(client), initialProps: { enabled: false } },
    );

    expectTypeOf(result.current.error).toEqualTypeOf<PersonalTimelineApiError | null>();

    expect(result.current.fetchStatus).toBe("idle");
    expect(get).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const query = client.getQueryCache().find({
      queryKey: [...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "day", "2026-08-09"],
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
  ] as const)(
    "uses the typed retry policy for $status/$code",
    ({ status, code, first, second }) => {
      const client = queryClient();
      renderHook(() => usePersonalTimelineDay("user-a", "2026-08-09", false), {
        wrapper: wrapperWith(client),
      });
      const query = client.getQueryCache().find({
        queryKey: [...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "day", "2026-08-09"],
      });
      const retry = query?.options.retry;
      expect(typeof retry).toBe("function");
      const error = new PersonalTimelineApiError(
        status,
        code === "UNAUTHORIZED" ? null : code,
        null,
      );

      expect((retry as (failureCount: number, error: Error) => boolean)(0, error)).toBe(first);
      expect((retry as (failureCount: number, error: Error) => boolean)(1, error)).toBe(second);
    },
  );

  it("invalidates all connection/day queries after connect and test", async () => {
    const client = queryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
    vi.spyOn(apiClient, "put").mockResolvedValue({ connected: true } as never);
    vi.spyOn(apiClient, "post").mockResolvedValue({ connected: true } as never);
    const connect = renderHook(() => useConnectTimeline("user-a"), {
      wrapper: wrapperWith(client),
    });
    const testConnection = renderHook(() => useTestTimelineConnection("user-a"), {
      wrapper: wrapperWith(client),
    });

    await act(async () => {
      await connect.result.current.mutateAsync({ mode: "managed", apiKey: "fixture-key" });
      await testConnection.result.current.mutateAsync();
    });

    const ownerRoot = [...PERSONAL_TIMELINE_QUERY_KEY, "user-a"];
    expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: ownerRoot });
    expect(invalidate).toHaveBeenNthCalledWith(2, { queryKey: ownerRoot });
    expect(
      client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.options),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mutationKey: [...ownerRoot, "connect"], networkMode: "always" }),
        expect.objectContaining({ mutationKey: [...ownerRoot, "test"], networkMode: "always" }),
      ]),
    );
  });

  it("removes only the settled owner's personal timeline query data after disconnect", async () => {
    const client = queryClient();
    client.setQueryData([...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "day", "2026-08-09"], {
      private: true,
    });
    vi.spyOn(apiClient, "delete").mockResolvedValue({ ok: true } as never);
    const remove = vi.spyOn(client, "removeQueries");
    const { result } = renderHook(() => useDisconnectTimeline("user-a"), {
      wrapper: wrapperWith(client),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(remove).toHaveBeenCalledWith({
      queryKey: [...PERSONAL_TIMELINE_QUERY_KEY, "user-a"],
    });
    expect(
      client.getQueryData([...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "day", "2026-08-09"]),
    ).toBeUndefined();
    expect(client.getMutationCache().getAll()[0]?.options).toMatchObject({
      mutationKey: [...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "disconnect"],
      networkMode: "always",
    });
  });

  it("does not let a late user-A disconnect clear user-B panel state", async () => {
    const client = queryClient();
    let resolveDisconnect!: (value: { ok: true }) => void;
    vi.spyOn(apiClient, "delete").mockImplementation(
      () => new Promise((resolve) => (resolveDisconnect = resolve)) as never,
    );
    const { result } = renderHook(() => useDisconnectTimeline("user-a"), {
      wrapper: wrapperWith(client),
    });

    let pending!: Promise<{ ok: true }>;
    act(() => {
      pending = result.current.mutateAsync();
    });
    await waitFor(() => expect(resolveDisconnect).toBeDefined());
    act(() => {
      usePersonalTimelineStore.getState().setSelectedDate("2026-08-10");
      usePersonalTimelineStore.getState().selectEntry("user-b-entry");
      resolveDisconnect({ ok: true });
    });
    await act(async () => pending);

    expect(usePersonalTimelineStore.getState()).toMatchObject({
      selectedDate: "2026-08-10",
      selectedEntryId: "user-b-entry",
    });
  });

  it("starts connect immediately while offline so credentials are never queued for resume", async () => {
    const client = queryClient();
    onlineManager.setOnline(false);
    const put = vi.spyOn(apiClient, "put").mockRejectedValue(new ApiClientError(0, null, null));
    const { result } = renderHook(() => useConnectTimeline("user-a"), {
      wrapper: wrapperWith(client),
    });

    await act(async () => {
      await result.current
        .mutateAsync({ mode: "managed", apiKey: "must-not-queue" })
        .catch(() => undefined);
    });

    expect(put).toHaveBeenCalledTimes(1);
    expect(client.getMutationCache().getAll()[0]?.state.isPaused).toBe(false);
  });

  it("removes settled connect variables from the mutation cache when the observer resets", async () => {
    const client = queryClient();
    vi.spyOn(apiClient, "put").mockResolvedValue({ connected: true } as never);
    const { result } = renderHook(() => useConnectTimeline("user-a"), {
      wrapper: wrapperWith(client),
    });

    await act(async () => {
      await result.current.mutateAsync({ mode: "managed", apiKey: "must-not-remain" });
    });
    expect(JSON.stringify(client.getMutationCache().getAll())).toContain("must-not-remain");

    act(() => result.current.reset());

    expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain("must-not-remain");
    expect(
      client.getMutationCache().findAll({ mutationKey: PERSONAL_TIMELINE_QUERY_KEY, exact: false }),
    ).toEqual([]);
  });

  it("never exposes user A connection or day data to user B before cache cleanup", () => {
    const client = queryClient();
    const userAConnection = { connected: true, connection: { displayName: "Alice" } };
    const userADay = { version: 1, date: "2026-08-09", entries: [{ id: "private-a" }] };
    client.setQueryData([...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "connection"], userAConnection);
    client.setQueryData([...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "day", "2026-08-09"], userADay);

    const connection = renderHook(() => useTimelineConnection("user-b"), {
      wrapper: wrapperWith(client),
    });
    const day = renderHook(() => usePersonalTimelineDay("user-b", "2026-08-09", false), {
      wrapper: wrapperWith(client),
    });

    expect(connection.result.current.data).toBeUndefined();
    expect(day.result.current.data).toBeUndefined();
    expect(client.getQueryData([...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "connection"])).toBe(
      userAConnection,
    );
    expect(
      client.getQueryData([...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "day", "2026-08-09"]),
    ).toBe(userADay);
  });
});
