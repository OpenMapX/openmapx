import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import { useAutocomplete } from "../useAutocomplete";

describe("useAutocomplete", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches suggestions for a query of length >= 2", async () => {
    const suggestions = [{ name: "Fulda", placeId: "p1" }];
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(suggestions as never);

    const { result } = renderHook(() => useAutocomplete("Fu", "de"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(suggestions);
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.autocomplete, { q: "Fu", lang: "de" });
  });

  it("omits lang when not provided", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue([] as never);

    const { result } = renderHook(() => useAutocomplete("Fu"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.autocomplete, { q: "Fu" });
  });

  it("does not fire for a single-character query", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue([] as never);

    const { result } = renderHook(() => useAutocomplete("F"), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });
});
