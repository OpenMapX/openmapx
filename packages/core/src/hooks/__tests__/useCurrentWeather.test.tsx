import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { createQueryWrapper } from "../../test/queryWrapper";
import { useCurrentWeather } from "../useCurrentWeather";

describe("useCurrentWeather", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches current weather for the given coordinates", async () => {
    const weather = { temperature: 21, condition: "clear" };
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(weather as never);

    const { result } = renderHook(() => useCurrentWeather(52.5, 13.4), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(weather);
    expect(spy).toHaveBeenCalledWith("/api/integrations/weather/current", {
      lat: "52.5",
      lng: "13.4",
    });
  });

  it("does not fire when lat or lng is null", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(() => useCurrentWeather(null, 13.4), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not fire when explicitly disabled", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(() => useCurrentWeather(52.5, 13.4, false), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });
});
