import type { BoundingBox, DataSourceResult } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../windy.js", () => ({
  searchWindy: vi.fn(),
  getWindyDetail: vi.fn(),
  mapWindyToResult: vi.fn(),
  mapWindyToDetail: vi.fn(),
}));

vi.mock("../osm.js", () => ({
  searchOsmWebcams: vi.fn(),
  getOsmWebcamNode: vi.fn(),
  mapOsmToResult: vi.fn(),
  mapOsmToDetail: vi.fn(),
}));

vi.mock("../caltrans.js", () => ({
  searchCaltrans: vi.fn(),
  getCaltransDetail: vi.fn(),
  mapCaltransToResult: vi.fn(),
  mapCaltransToDetail: vi.fn(),
}));

vi.mock("../tfl.js", () => ({
  searchTfl: vi.fn(),
  getTflDetail: vi.fn(),
  mapTflToResult: vi.fn(),
  mapTflToDetail: vi.fn(),
}));

vi.mock("../dedup.js", () => ({
  deduplicateByCoordinates: vi.fn((items: unknown[]) => items),
}));

import {
  getCaltransDetail,
  mapCaltransToDetail,
  mapCaltransToResult,
  searchCaltrans,
} from "../caltrans.js";
import { deduplicateByCoordinates } from "../dedup.js";
import { getOsmWebcamNode, mapOsmToDetail, mapOsmToResult, searchOsmWebcams } from "../osm.js";
import { webcamProvider } from "../provider.js";
import { getTflDetail, mapTflToDetail, mapTflToResult, searchTfl } from "../tfl.js";
import { getWindyDetail, mapWindyToDetail, mapWindyToResult, searchWindy } from "../windy.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function makeBbox(): BoundingBox {
  return { south: 48.0, west: 11.0, north: 49.0, east: 12.0 };
}

function makeResult(id: string, source: string, variant: string): DataSourceResult {
  return {
    id,
    name: `Webcam ${id}`,
    coordinates: [11.5, 48.5],
    source,
    variant,
  };
}

describe("webcamProvider meta", () => {
  it("has id 'webcam'", () => {
    expect(webcamProvider.id).toBe("webcam");
  });

  it("has correct cache TTLs", () => {
    expect(webcamProvider.searchCacheTtl).toBe(3600);
    expect(webcamProvider.detailCacheTtl).toBe(300);
  });

  it("has minZoom 8", () => {
    expect(webcamProvider.meta.minZoom).toBe(8);
  });
});

describe("webcamProvider.search", () => {
  it("calls all 4 sources in parallel and combines results", async () => {
    const windyRaw = [{ id: "w1" }];
    const osmRaw = [{ id: "o1" }];
    const caltransRaw = [{ id: "c1" }];
    const tflRaw = [{ id: "t1" }];

    vi.mocked(searchWindy).mockResolvedValue(windyRaw as never);
    vi.mocked(searchOsmWebcams).mockResolvedValue(osmRaw as never);
    vi.mocked(searchCaltrans).mockResolvedValue(caltransRaw as never);
    vi.mocked(searchTfl).mockResolvedValue(tflRaw as never);

    vi.mocked(mapWindyToResult).mockReturnValue(makeResult("windy:1", "windy", "landscape"));
    vi.mocked(mapOsmToResult).mockReturnValue(makeResult("osm-webcam:1", "osm-webcam", "other"));
    vi.mocked(mapCaltransToResult).mockReturnValue(
      makeResult("caltrans:7:1", "caltrans", "traffic"),
    );
    vi.mocked(mapTflToResult).mockReturnValue(makeResult("tfl:1", "tfl", "traffic"));

    const results = await webcamProvider.search(makeBbox());

    expect(searchWindy).toHaveBeenCalledOnce();
    expect(searchOsmWebcams).toHaveBeenCalledOnce();
    expect(searchCaltrans).toHaveBeenCalledOnce();
    expect(searchTfl).toHaveBeenCalledOnce();
    expect(results).toHaveLength(4);
  });

  it("Windy is first in dedup order (highest priority)", async () => {
    vi.mocked(searchWindy).mockResolvedValue([{ id: "w1" }] as never);
    vi.mocked(searchOsmWebcams).mockResolvedValue([{ id: "o1" }] as never);
    vi.mocked(searchCaltrans).mockResolvedValue([]);
    vi.mocked(searchTfl).mockResolvedValue([]);

    vi.mocked(mapWindyToResult).mockReturnValue(makeResult("windy:1", "windy", "landscape"));
    vi.mocked(mapOsmToResult).mockReturnValue(makeResult("osm-webcam:1", "osm-webcam", "other"));

    await webcamProvider.search(makeBbox());

    const call = vi.mocked(deduplicateByCoordinates).mock.calls[0][0];
    expect(call[0].id).toBe("windy:1");
    expect(call[1].id).toBe("osm-webcam:1");
  });

  it("individual source failures do not break the search", async () => {
    vi.mocked(searchWindy).mockRejectedValue(new Error("Windy down"));
    vi.mocked(searchOsmWebcams).mockRejectedValue(new Error("OSM down"));
    vi.mocked(searchCaltrans).mockResolvedValue([{ id: "c1" }] as never);
    vi.mocked(searchTfl).mockResolvedValue([{ id: "t1" }] as never);

    vi.mocked(mapCaltransToResult).mockReturnValue(
      makeResult("caltrans:7:1", "caltrans", "traffic"),
    );
    vi.mocked(mapTflToResult).mockReturnValue(makeResult("tfl:1", "tfl", "traffic"));

    const results = await webcamProvider.search(makeBbox());
    expect(results).toHaveLength(2);
  });

  it("all sources fail returns empty array", async () => {
    vi.mocked(searchWindy).mockRejectedValue(new Error("down"));
    vi.mocked(searchOsmWebcams).mockRejectedValue(new Error("down"));
    vi.mocked(searchCaltrans).mockRejectedValue(new Error("down"));
    vi.mocked(searchTfl).mockRejectedValue(new Error("down"));
    vi.mocked(deduplicateByCoordinates).mockReturnValue([]);

    const results = await webcamProvider.search(makeBbox());
    expect(results).toEqual([]);
  });

  it("applies category filter server-side", async () => {
    vi.mocked(searchWindy).mockResolvedValue([]);
    vi.mocked(searchOsmWebcams).mockResolvedValue([]);
    vi.mocked(searchCaltrans).mockResolvedValue([]);
    vi.mocked(searchTfl).mockResolvedValue([]);

    const items = [
      makeResult("a", "windy", "landscape"),
      makeResult("b", "caltrans", "traffic"),
      makeResult("c", "windy", "city"),
    ];
    vi.mocked(deduplicateByCoordinates).mockReturnValue(items);

    const results = await webcamProvider.search(makeBbox(), { category: ["traffic"] });
    expect(results).toHaveLength(1);
    expect(results[0].variant).toBe("traffic");
  });
});

describe("webcamProvider.getDetail", () => {
  it("windy prefix calls getWindyDetail", async () => {
    const raw = { id: "windy:123", name: "Test" };
    const detail = {
      id: "windy:123",
      sources: ["windy"],
      name: "Test",
      coordinates: [11, 48] as [number, number],
      sections: [],
    };
    vi.mocked(getWindyDetail).mockResolvedValue(raw as never);
    vi.mocked(mapWindyToDetail).mockReturnValue(detail);

    const result = await webcamProvider.getDetail("windy:123");
    expect(getWindyDetail).toHaveBeenCalledWith("123");
    expect(result).toBe(detail);
  });

  it("osm-webcam prefix calls getOsmWebcamNode", async () => {
    const raw = { id: "osm-webcam:456" };
    const detail = {
      id: "osm-webcam:456",
      sources: ["osm-webcam"],
      name: "OSM",
      coordinates: [11, 48] as [number, number],
      sections: [],
    };
    vi.mocked(getOsmWebcamNode).mockResolvedValue(raw as never);
    vi.mocked(mapOsmToDetail).mockReturnValue(detail);

    const result = await webcamProvider.getDetail("osm-webcam:456");
    expect(getOsmWebcamNode).toHaveBeenCalledWith(456);
    expect(result).toBe(detail);
  });

  it("caltrans prefix calls getCaltransDetail with district and index", async () => {
    const raw = { id: "caltrans:7:42" };
    const detail = {
      id: "caltrans:7:42",
      sources: ["caltrans"],
      name: "Test",
      coordinates: [-118, 34] as [number, number],
      sections: [],
    };
    vi.mocked(getCaltransDetail).mockResolvedValue(raw as never);
    vi.mocked(mapCaltransToDetail).mockReturnValue(detail);

    const result = await webcamProvider.getDetail("caltrans:7:42");
    expect(getCaltransDetail).toHaveBeenCalledWith("7", "42");
    expect(result).toBe(detail);
  });

  it("tfl prefix calls getTflDetail", async () => {
    const raw = { id: "tfl:JamCams_00001" };
    const detail = {
      id: "tfl:JamCams_00001",
      sources: ["tfl"],
      name: "TfL",
      coordinates: [-0.1, 51.5] as [number, number],
      sections: [],
    };
    vi.mocked(getTflDetail).mockResolvedValue(raw as never);
    vi.mocked(mapTflToDetail).mockReturnValue(detail);

    const result = await webcamProvider.getDetail("tfl:JamCams_00001");
    expect(getTflDetail).toHaveBeenCalledWith("JamCams_00001");
    expect(result).toBe(detail);
  });

  it("unknown prefix returns null", async () => {
    const result = await webcamProvider.getDetail("unknown:123");
    expect(result).toBeNull();
  });
});
