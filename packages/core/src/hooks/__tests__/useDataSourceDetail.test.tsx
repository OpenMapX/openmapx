import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { Place } from "../../types/place";
import { useDataSourceMatch } from "../useDataSourceMatch";
import { useDataSourceDetail } from "../useDataSources";

const freshness = { fetchedAt: "2026-10-05T10:00:00.000Z", hasRealtimeData: false, isStale: false };

/** Item ids with a slash, colons and a URL fragment, as OpenConditions' feature ids carry them. */
const IDS = [
  "oc:feature:osm-parking:way/123",
  "oc:feature:be-vlg-gent-parking:https://stad.gent/nl/loop/mobiliteit-loop#Parkeerterreinen_Stad_Gent",
];

describe("data-source detail paths", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each(IDS)("useDataSourceDetail asks for %s as one encoded path segment", async (id) => {
    const get = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: null, attributions: [], freshness } as never);

    renderHook(() => useDataSourceDetail("parking", id), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(get).toHaveBeenCalled());
    const path = get.mock.calls[0]![0] as string;
    expect(path).toMatch(new RegExp(`/parking/detail/${encodeURIComponent(id)}$`));
    expect(decodeURIComponent(path.slice(path.indexOf("/detail/") + 8))).toBe(id);
  });

  it.each(IDS)("useDataSourceMatch asks for the matched %s encoded", async (id) => {
    const get = vi.spyOn(apiClient, "get").mockImplementation((async (path: string) =>
      path.endsWith("/search")
        ? {
            data: [{ id, name: "P", coordinates: [3.6864, 51.0254], source: "oc", variant: "x" }],
            attributions: [],
            freshness,
          }
        : { data: null, attributions: [], freshness }) as never);
    const place = {
      id: "osm:way/123",
      name: "P",
      coordinates: [3.6864, 51.0254],
      rawCategory: "amenity/parking",
    } as unknown as Place;

    renderHook(() => useDataSourceMatch(place), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(get.mock.calls[1]![0]).toMatch(new RegExp(`/parking/detail/${encodeURIComponent(id)}$`));
  });
});
