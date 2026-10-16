import { describe, expect, it, vi } from "vitest";
import { apiClient } from "../api/client";
import { fetchDirections } from "../api/directions";
import { directionsQueryKey } from "../hooks/useDirections";
import { configureStorage, getStorage } from "../platform/storage";
import { useDirectionsStore } from "../stores/directionsStore";

describe("cycling preferences across client sessions", () => {
  it("persists preferences across closing and hydration", () => {
    const previous = getStorage(),
      values = new Map<string, string>();
    configureStorage({
      getString: (k) => values.get(k) ?? null,
      setString: (k, v) => {
        values.set(k, v);
      },
      remove: (k) => {
        values.delete(k);
      },
    });
    const s = useDirectionsStore.getState();
    s.setBikeProfile("gravel");
    s.setBikeHillPreference("avoid");
    s.setBikePreferQuietRoads(true);
    s.close();
    s.hydrateRoutePrefs();
    expect(useDirectionsStore.getState()).toMatchObject({
      bikeProfile: "gravel",
      bikeHillPreference: "avoid",
      bikePreferQuietRoads: true,
    });
    s.setBikeProfile("trekking");
    s.setBikeHillPreference("default");
    s.setBikePreferQuietRoads(false);
    configureStorage(previous);
  });
  it("keys cycling preferences but isolates driving", () => {
    const base = {
      waypoints: [
        [6, 50],
        [7, 51],
      ] as [number, number][],
      lang: "en",
    };
    expect(directionsQueryKey({ ...base, mode: "cycling", bikeProfile: "road" })).not.toEqual(
      directionsQueryKey({ ...base, mode: "cycling", bikeProfile: "mountain" }),
    );
    expect(directionsQueryKey({ ...base, mode: "driving", bikeProfile: "road" })).toEqual(
      directionsQueryKey({ ...base, mode: "driving", bikeProfile: "mountain" }),
    );
  });
  it("serializes bike fields on cycling requests only", async () => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ routes: [] } as never);
    await fetchDirections({
      waypoints: [
        [6, 50],
        [7, 51],
      ],
      mode: "cycling",
      bikeProfile: "road",
      bikePreferQuietRoads: true,
    });
    expect(get).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ bikeProfile: "road", bikePreferQuietRoads: "true" }),
      {},
    );
    await fetchDirections({
      waypoints: [
        [6, 50],
        [7, 51],
      ],
      mode: "driving",
      bikeProfile: "road",
    });
    expect(get.mock.calls.at(-1)?.[1]).not.toHaveProperty("bikeProfile");
    get.mockRestore();
  });
});
