import { useDirectionsStore } from "@openmapx/core";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createTestQueryClient, renderHook, waitFor } from "@/test";
import { useReleaseUnavailablePin } from "./useRouteRecovery";

const routing = (available: boolean) => ({
  enabled: true,
  healthy: available,
  available,
  domains: ["routing"],
  modes: ["driving"],
});

let answer: () => Promise<Response>;

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
    if (url.pathname === "/api/capabilities") return answer();
    return Response.json({ error: "Not found" }, { status: 404 });
  });
  act(() => useDirectionsStore.getState().setRoutingProvider("routing-acme"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => useDirectionsStore.getState().close());
});

function mount(seed?: Record<string, ReturnType<typeof routing>>) {
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  if (seed)
    client.setQueryData(["capabilities"], {
      services: seed,
      features: { osmContributions: false },
    });
  const released = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(() => useReleaseUnavailablePin("routing-acme", released), { wrapper });
  return released;
}

it("keeps the pin while the capabilities have not answered", async () => {
  let respond: (response: Response) => void = () => {};
  answer = () => new Promise((resolve) => (respond = resolve));
  const released = mount();

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(released).not.toHaveBeenCalled();
  expect(useDirectionsStore.getState().routingProvider).toBe("routing-acme");
  respond(Response.json({ services: {}, features: { osmContributions: false } }));
  await waitFor(() => expect(released).toHaveBeenCalledTimes(1));
});

it("keeps the pin when the capabilities failed", async () => {
  answer = async () => Response.json({ error: "Unavailable" }, { status: 503 });
  const released = mount();

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(released).not.toHaveBeenCalled();
  expect(useDirectionsStore.getState().routingProvider).toBe("routing-acme");
});

it("asks again after the pinned request failed and releases an engine the answer drops", async () => {
  // Cached from before the engine left, and still fresh.
  answer = async () => Response.json({ services: {}, features: { osmContributions: false } });
  const released = mount({ "routing-acme": routing(true) });

  await waitFor(() => expect(released).toHaveBeenCalledTimes(1));
  expect(useDirectionsStore.getState().routingProvider).toBeNull();
});
