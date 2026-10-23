import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureApiClient } from "../api/client";
import { useCreateShare, useRevokeShare, useRotateShare, useShares } from "./useShares";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const headers = { "cache-control": "private, no-store", pragma: "no-cache", vary: "Cookie" };
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  configureApiClient({ baseUrl: "https://sharing.example", credentials: "include" });
});
afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});
it("rejects malformed owner success before publishing the query cache", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ shares: [{ id: "bad" }] }, { headers })),
  );
  const { result } = renderHook(() => useShares(), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(client.getQueryData(["shares"])).toBeUndefined();
});
it("returns the creation receipt and encodes opaque IDs for rotate/revoke", async () => {
  const token = "A".repeat(43),
    at = new Date().toISOString();
  const share = {
    id: "s",
    targetType: "list",
    targetId: "l",
    mode: "live",
    label: "Trip",
    createdAt: at,
    updatedAt: at,
    expiresAt: null,
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ id: "s", token, share }, { status: 201, headers }))
    .mockResolvedValueOnce(Response.json({ token }, { headers }))
    .mockResolvedValueOnce(Response.json({ ok: true }, { headers }));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(
    () => ({ create: useCreateShare(), rotate: useRotateShare(), revoke: useRevokeShare() }),
    { wrapper },
  );
  await act(async () => {
    expect(
      await result.current.create.mutateAsync({ targetType: "list", targetId: "l", mode: "live" }),
    ).toEqual({ id: "s", token, share });
    await result.current.rotate.mutateAsync("a / café");
    await result.current.revoke.mutateAsync("a / café");
  });
  expect(fetcher.mock.calls[1][0]).toBe(
    "https://sharing.example/api/shares/a%20%2F%20caf%C3%A9/rotate",
  );
  expect(fetcher.mock.calls[2][0]).toBe("https://sharing.example/api/shares/a%20%2F%20caf%C3%A9");
});
it("refreshes owner inventory after a mutation even when the initial read is still pending", async () => {
  let firstSignal: AbortSignal | null | undefined;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "DELETE") return Response.json({ ok: true }, { headers });
    if (!firstSignal) {
      firstSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    }
    return Response.json({ shares: [] }, { headers });
  });
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => ({ read: useShares(), revoke: useRevokeShare() }), {
    wrapper,
  });
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await act(async () => {
    await result.current.revoke.mutateAsync("removed");
  });
  await waitFor(() => expect(result.current.read.data).toEqual([]));
  expect(firstSignal?.aborted).toBe(true);
});
