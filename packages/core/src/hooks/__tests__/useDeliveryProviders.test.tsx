import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { createQueryWrapper } from "../../test/queryWrapper";
import { useDeliveryProviderCatalog, useDeliveryProviders } from "../useDeliveryProviders";

describe("delivery provider hooks", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("does not request the worldwide catalog while country is unresolved", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ providers: [] });
    const { result } = renderHook(() => useDeliveryProviderCatalog(undefined), {
      wrapper: createQueryWrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolves restaurant-specific provider kinds only when enabled", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ providers: [] });
    const params = {
      name: "AKL",
      countryCode: "DE",
      city: "Aachen",
      lat: 50.77,
      lng: 6.08,
    };
    const { result, rerender } = renderHook(
      ({ enabled }) => useDeliveryProviders(params, enabled),
      { initialProps: { enabled: false }, wrapper: createQueryWrapper() },
    );
    expect(result.current.fetchStatus).toBe("idle");
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      "/api/integrations/food-delivery/resolve",
      expect.objectContaining({ v: "3", name: "AKL", country: "de", city: "Aachen" }),
    );
  });
});
