import { apiClient } from "@openmapx/core";
import { waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap } from "@/test";
import { renderHookWithQuery } from "@/test/query";

let fake: FakeMap;
const MAP_REF = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: MAP_REF, mapReady: true }),
}));

import { useMapCenterWeather } from "./useMapCenterWeather";

const getMock = vi.spyOn(apiClient, "get");

beforeEach(() => {
  fake = createFakeMap({ zoom: 10 });
  getMock.mockReset();
  getMock.mockResolvedValue({
    current: { temperature: 10, weatherCode: 3, cloudCover: 90, isDay: true, time: "" },
    source: "test",
    contributors: [],
  });
});

it("shares one query between two callers at the same centre", async () => {
  const { result } = renderHookWithQuery(() => ({
    widget: useMapCenterWeather({ enabled: true }),
    lighting: useMapCenterWeather({ enabled: true }),
  }));
  await waitFor(() => expect(result.current.lighting.data).toBeDefined());
  expect(result.current.widget.data).toBe(result.current.lighting.data);
  expect(getMock).toHaveBeenCalledTimes(1);
});

it("does not query while disabled", async () => {
  const { result } = renderHookWithQuery(() => useMapCenterWeather({ enabled: false }));
  await Promise.resolve();
  expect(result.current.data).toBeUndefined();
  expect(getMock).not.toHaveBeenCalled();
});
