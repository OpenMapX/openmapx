import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureApiClient } from "../../api/client";
import { createQueryWrapper } from "../../test/queryWrapper";
import { useCapabilities } from "../useCapabilities";

afterEach(() => vi.unstubAllGlobals());

function response(body: unknown) {
  configureApiClient({ baseUrl: "https://api.example.test", credentials: "include" });
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("useCapabilities validated acquisition", () => {
  it("rejects a successful response missing required feature metadata", async () => {
    response({ services: {} });
    const { result } = renderHook(() => useCapabilities(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.osmContributionsEnabled).toBe(false);
  });

  it("reads service availability and the explicit feature bit through the transport", async () => {
    const fetch = response({
      services: {
        ready: { enabled: true, healthy: true, available: true, domains: ["routing"] },
        down: { enabled: true, healthy: false, available: false, domains: [] },
      },
      features: { osmContributions: true },
    });
    const { result } = renderHook(() => useCapabilities(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.isAvailable("ready")).toBe(true);
    expect(result.current.isAvailable("down")).toBe(false);
    expect(result.current.isAvailable("missing")).toBe(false);
    expect(result.current.isAvailable(undefined)).toBe(true);
    expect(result.current.osmContributionsEnabled).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.test/api/capabilities",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("keeps ordinary services optimistic while loading and the feature off", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { result } = renderHook(() => useCapabilities(), { wrapper: createQueryWrapper() });
    expect(result.current.isAvailable("ready")).toBe(true);
    expect(result.current.osmContributionsEnabled).toBe(false);
  });

  it("fails closed for a malformed feature value and for an HTTP failure", async () => {
    response({ services: {}, features: { osmContributions: "true" } });
    const malformed = renderHook(() => useCapabilities(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(malformed.result.current.isError).toBe(true));
    expect(malformed.result.current.osmContributionsEnabled).toBe(false);
    malformed.unmount();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
    const failed = renderHook(() => useCapabilities(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(failed.result.current.isError).toBe(true));
    expect(failed.result.current.osmContributionsEnabled).toBe(false);
  });
});
