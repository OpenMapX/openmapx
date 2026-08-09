import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { useRideQuotes } from "../useRideQuotes";

const request = {
  pickup: [13.405, 52.52] as [number, number],
  dropoff: [13.377, 52.516] as [number, number],
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => vi.restoreAllMocks());

describe("useRideQuotes", () => {
  it("posts the flattened request with the provider ids", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ results: [] });
    renderHook(() => useRideQuotes({ request, providerIds: ["uber"], enabled: true }), { wrapper });
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0];
    expect(body).toMatchObject({ pickupLat: "52.52", providerIds: ["uber"] });
  });

  it("does not fetch when disabled", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ results: [] });
    renderHook(() => useRideQuotes({ request, providerIds: ["uber"], enabled: false }), {
      wrapper,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(post).not.toHaveBeenCalled();
  });

  it("does not fetch with an empty provider list", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ results: [] });
    renderHook(() => useRideQuotes({ request, providerIds: [], enabled: true }), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(post).not.toHaveBeenCalled();
  });

  it("exposes the earliest expiry across every returned quote", async () => {
    vi.spyOn(apiClient, "post").mockResolvedValue({
      results: [
        {
          providerId: "gofs-a",
          attributions: [],
          quotes: [
            {
              productId: "x",
              product: { id: "x", name: "X" },
              expiresAt: "2026-08-09T12:01:00.000Z",
            },
            {
              productId: "y",
              product: { id: "y", name: "Y" },
              expiresAt: "2026-08-09T12:00:30.000Z",
            },
          ],
        },
      ],
    });
    const { result } = renderHook(
      () => useRideQuotes({ request, providerIds: ["gofs-a"], enabled: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(result.current.expiresAt).toBe("2026-08-09T12:00:30.000Z");
  });

  it("reports no expiry when there are no quotes", async () => {
    vi.spyOn(apiClient, "post").mockResolvedValue({ results: [] });
    const { result } = renderHook(
      () => useRideQuotes({ request, providerIds: ["uber"], enabled: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.expiresAt).toBeNull();
  });
});
