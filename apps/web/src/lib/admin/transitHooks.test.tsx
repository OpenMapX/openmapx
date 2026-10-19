import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.example.test" }),
}));

import {
  useSyncTransit,
  useTransitFeeds,
  useTransitJobDetail,
  useTransitState,
} from "./transitHooks";

const clients: QueryClient[] = [];
function environment() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}
const state = {
  transitousRef: null,
  transitousLockedAt: null,
  transitousLockedBy: null,
  lastSyncAt: null,
  lastSyncStatus: null,
  currentJob: null,
  feedCount: 0,
  feeds: { byRegion: {}, byStatus: {} },
};
const job = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "transitous-sync",
  status: "running",
  startedAt: "2026-10-19T00:00:00.000Z",
  finishedAt: null,
  triggeredBy: "operator",
  idempotencyKey: null,
  metadata: { scope: ["de"] },
  stages: [],
};
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => {
    client.clear();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("transit administration acquisition", () => {
  it("rejects a malformed successful state instead of caching an asserted DTO", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
    const { client, wrapper } = environment();
    const { result } = renderHook(() => useTransitState(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(["admin", "transit", "state"])).toBeUndefined();
  });
  it("rejects a malformed accepted sync and does not invalidate successful state", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({}, { status: 202 }),
    );
    const { client, wrapper } = environment();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSyncTransit(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({})).rejects.toThrow();
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
  it("uses the API origin, cookies, query signal and existing state cache key", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, optionsValue) => {
      const options = optionsValue as RequestInit | undefined;
      expect(String(url)).toBe("https://api.example.test/api/data-manager/transit/state");
      expect(options?.credentials).toBe("include");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(options?.headers).has("authorization")).toBe(false);
      return Response.json(state);
    });
    const { client, wrapper } = environment();
    const { result } = renderHook(() => useTransitState(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(["admin", "transit", "state"])).toEqual(state);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains filter defaults, explicit pagination and the existing feed cache key", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("region")).toBe("de & west");
      expect(url.searchParams.get("status")).toBe("failed");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.get("offset")).toBe("0");
      return Response.json({ feeds: [], total: 0, limit: 100, offset: 0 });
    });
    const { client, wrapper } = environment();
    const { result } = renderHook(
      () => useTransitFeeds({ region: "de & west", status: "failed" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      client.getQueryData(["admin", "transit", "feeds", "de & west", "failed", 100, 0]),
    ).toMatchObject({ feeds: [], limit: 100, offset: 0 });
  });
  it("keeps null job details disabled and queries the selected job", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      expect(String(url)).toBe(
        "https://api.example.test/api/data-manager/transit/jobs/11111111-1111-4111-8111-111111111111",
      );
      return Response.json(job);
    });
    const { client, wrapper } = environment();
    const { result, rerender } = renderHook(
      ({ jobId }: { jobId: string | null }) => useTransitJobDetail(jobId),
      { wrapper, initialProps: { jobId: null as string | null } },
    );
    expect(fetch).not.toHaveBeenCalled();
    rerender({ jobId: "11111111-1111-4111-8111-111111111111" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      client.getQueryData([
        "admin",
        "transit",
        "jobs",
        "detail",
        "11111111-1111-4111-8111-111111111111",
      ]),
    ).toEqual(job);
  });
  it("invalidates state and jobs only for a validated accepted sync", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, initValue) => {
      const init = initValue as RequestInit | undefined;
      expect(JSON.parse(init?.body as string)).toEqual({
        countries: ["de"],
        idempotencyKey: "attempt-1",
      });
      return Response.json({ ok: true, jobId: "job-1", status: "started" }, { status: 202 });
    });
    const { client, wrapper } = environment();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSyncTransit(), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({ countries: ["de"], idempotencyKey: "attempt-1" }),
      ).resolves.toMatchObject({ jobId: "job-1" });
    });
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ["admin", "transit", "state"] }],
      [{ queryKey: ["admin", "transit", "jobs"] }],
    ]);
  });
  it("treats a checked sync conflict as an error without successful invalidation", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { ok: false, reason: "in-flight", existingJobId: "active-job" },
        { status: 409 },
      ),
    );
    const { client, wrapper } = environment();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSyncTransit(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({})).rejects.toMatchObject({ status: 409 });
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
  it("cancels the API request when its query observer unmounts", async () => {
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          signal = (options as RequestInit | undefined)?.signal;
          signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        }),
    );
    const { wrapper } = environment();
    const { unmount } = renderHook(() => useTransitState(), { wrapper });
    await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("polls running job details at five seconds and completed jobs at sixty seconds", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts++;
      return Response.json({ ...job, status: attempts === 1 ? "running" : "completed" });
    });
    const { client, wrapper } = environment();
    const { result } = renderHook(
      () => useTransitJobDetail("11111111-1111-4111-8111-111111111111"),
      { wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.isSuccess).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4990);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          client.getQueryData<{ status: string }>([
            "admin",
            "transit",
            "jobs",
            "detail",
            "11111111-1111-4111-8111-111111111111",
          ])?.status,
        ).toBe("completed"),
      );
    });
    expect(result.current.error).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
