import type { BoundingBox, DataSourceResult } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../us-ca-caltrans.js", () => ({
  searchCaltrans: vi.fn(),
  getCaltransDetail: vi.fn(),
  mapCaltransToResult: vi.fn(),
  mapCaltransToDetail: vi.fn(),
}));

vi.mock("../gb-eng-tfl.js", () => ({
  searchTfl: vi.fn(),
  getTflDetail: vi.fn(),
  mapTflToResult: vi.fn(),
  mapTflToDetail: vi.fn(),
}));

vi.mock("../us-nps.js", () => ({
  searchNps: vi.fn(),
  getNpsDetail: vi.fn(),
  mapNpsToResult: vi.fn(),
  mapNpsToDetail: vi.fn(),
}));

vi.mock("../us-state-sources.js", () => ({
  searchUsStateSources: vi.fn(),
  getUsStateSourceDetail: vi.fn(),
  mapUsStateSourceToResult: vi.fn(),
  mapUsStateSourceToDetail: vi.fn(),
  getUsStateSourceIds: vi.fn(() => [
    { id: "us-ny-511", label: "New York" },
    { id: "us-or-tripcheck", label: "Oregon" },
  ]),
}));

vi.mock("../camera-sources.js", () => ({
  searchCameraSources: vi.fn(),
  getCameraSourceDetail: vi.fn(),
  mapCameraSourceToResult: vi.fn(),
  mapCameraSourceToDetail: vi.fn(),
  getCameraSourceIds: vi.fn(() => [{ id: "fi-digitraffic-webcam", label: "Finland Digitraffic" }]),
}));

vi.mock("../dedup.js", () => ({
  deduplicateByCoordinates: vi.fn((items: unknown[]) => items),
}));

import {
  getCameraSourceDetail,
  mapCameraSourceToDetail,
  mapCameraSourceToResult,
  searchCameraSources,
} from "../camera-sources.js";
import { deduplicateByCoordinates } from "../dedup.js";
import { getTflDetail, mapTflToDetail, mapTflToResult, searchTfl } from "../gb-eng-tfl.js";
import { getOsmWebcamNode, mapOsmToDetail, mapOsmToResult, searchOsmWebcams } from "../osm.js";
import { setManifestDataSources, webcamProvider } from "../provider.js";
import {
  getCaltransDetail,
  mapCaltransToDetail,
  mapCaltransToResult,
  searchCaltrans,
} from "../us-ca-caltrans.js";
import { getNpsDetail, mapNpsToDetail, mapNpsToResult, searchNps } from "../us-nps.js";
import {
  getUsStateSourceDetail,
  mapUsStateSourceToDetail,
  mapUsStateSourceToResult,
  searchUsStateSources,
} from "../us-state-sources.js";
import { getWindyDetail, mapWindyToDetail, mapWindyToResult, searchWindy } from "../windy.js";

// Mirror the manifest dataSources the host loads at runtime so the provider's
// attribution lookup has something to map `source` prefixes against.
beforeEach(() => {
  vi.mocked(searchCameraSources).mockResolvedValue([]);
  vi.mocked(getCameraSourceDetail).mockResolvedValue(null);
  setManifestDataSources([
    {
      sourceId: "windy",
      name: "Windy Webcams",
      url: "https://www.windy.com/webcams",
      license: "test",
      providerCountry: "CZ",
      providerPrivacyUrl: "https://example.com/privacy",
    },
    {
      sourceId: "osm",
      name: "OpenStreetMap",
      url: "https://www.openstreetmap.org/",
      license: "ODbL 1.0",
      providerCountry: "UK",
      providerPrivacyUrl: "https://osmfoundation.org/wiki/Privacy_Policy",
    },
    {
      sourceId: "us-ca-caltrans",
      name: "Caltrans",
      url: "https://dot.ca.gov/",
      license: "test",
      providerCountry: "US",
      providerPrivacyUrl: "https://example.com/privacy",
    },
    {
      sourceId: "gb-eng-tfl",
      name: "TfL",
      url: "https://tfl.gov.uk/",
      license: "test",
      providerCountry: "UK",
      providerPrivacyUrl: "https://example.com/privacy",
    },
    {
      sourceId: "us-nps",
      name: "NPS",
      url: "https://www.nps.gov/",
      license: "test",
      providerCountry: "US",
      providerPrivacyUrl: "https://example.com/privacy",
    },
    {
      sourceId: "us-ny-511",
      name: "DOT NY",
      url: "https://example.com",
      license: "test",
      providerCountry: "US",
      providerPrivacyUrl: "https://example.com/privacy",
    },
  ]);
});

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
  it("calls all source groups in parallel and combines results", async () => {
    const windyRaw = [{ id: "w1" }];
    const osmRaw = [{ id: "o1" }];
    const caltransRaw = [{ id: "c1" }];
    const tflRaw = [{ id: "t1" }];
    const npsRaw = [{ id: "n1" }];
    const usStateRaw = [{ id: "d1" }];
    const cameraSourceRaw = [{ id: "i1" }];

    vi.mocked(searchWindy).mockResolvedValue(windyRaw as never);
    vi.mocked(searchOsmWebcams).mockResolvedValue(osmRaw as never);
    vi.mocked(searchCaltrans).mockResolvedValue(caltransRaw as never);
    vi.mocked(searchTfl).mockResolvedValue(tflRaw as never);
    vi.mocked(searchNps).mockResolvedValue(npsRaw as never);
    vi.mocked(searchUsStateSources).mockResolvedValue(usStateRaw as never);
    vi.mocked(searchCameraSources).mockResolvedValue(cameraSourceRaw as never);

    vi.mocked(mapWindyToResult).mockReturnValue(makeResult("windy:1", "windy", "landscape"));
    vi.mocked(mapOsmToResult).mockReturnValue(makeResult("osm-webcam:1", "osm", "other"));
    vi.mocked(mapCaltransToResult).mockReturnValue(
      makeResult("us-ca-caltrans:7:1", "us-ca-caltrans", "traffic"),
    );
    vi.mocked(mapTflToResult).mockReturnValue(makeResult("gb-eng-tfl:1", "gb-eng-tfl", "traffic"));
    vi.mocked(mapNpsToResult).mockReturnValue(makeResult("us-nps:1", "us-nps", "landscape"));
    vi.mocked(mapUsStateSourceToResult).mockReturnValue(
      makeResult("us-ny-511:1", "us-ny-511", "traffic"),
    );
    vi.mocked(mapCameraSourceToResult).mockReturnValue(
      makeResult("fi-digitraffic-webcam:1", "fi-digitraffic-webcam", "traffic"),
    );

    const envelope = await webcamProvider.search(makeBbox());
    const results = envelope.data;

    expect(searchWindy).toHaveBeenCalledOnce();
    expect(searchOsmWebcams).toHaveBeenCalledOnce();
    expect(searchCaltrans).toHaveBeenCalledOnce();
    expect(searchTfl).toHaveBeenCalledOnce();
    expect(searchNps).toHaveBeenCalledOnce();
    expect(searchUsStateSources).toHaveBeenCalledOnce();
    expect(searchCameraSources).toHaveBeenCalledOnce();
    expect(results).toHaveLength(7);
    expect(envelope.attributions.length).toBeGreaterThan(0);
    expect(envelope.attributions[0].sourceId).toBe("windy");
    expect(envelope.freshness.fetchedAt).toBeTruthy();
  });

  it("Windy is first in dedup order (highest priority), OSM is last", async () => {
    vi.mocked(searchWindy).mockResolvedValue([{ id: "w1" }] as never);
    vi.mocked(searchOsmWebcams).mockResolvedValue([{ id: "o1" }] as never);
    vi.mocked(searchCaltrans).mockResolvedValue([]);
    vi.mocked(searchTfl).mockResolvedValue([]);
    vi.mocked(searchNps).mockResolvedValue([]);
    vi.mocked(searchUsStateSources).mockResolvedValue([]);

    vi.mocked(mapWindyToResult).mockReturnValue(makeResult("windy:1", "windy", "landscape"));
    vi.mocked(mapOsmToResult).mockReturnValue(makeResult("osm-webcam:1", "osm", "other"));

    await webcamProvider.search(makeBbox());

    const call = vi.mocked(deduplicateByCoordinates).mock.calls[0][0];
    expect(call[0].id).toBe("windy:1");
    expect(call[call.length - 1].id).toBe("osm-webcam:1");
  });

  it("individual source failures do not break the search", async () => {
    vi.mocked(searchWindy).mockRejectedValue(new Error("Windy down"));
    vi.mocked(searchOsmWebcams).mockRejectedValue(new Error("OSM down"));
    vi.mocked(searchCaltrans).mockResolvedValue([{ id: "c1" }] as never);
    vi.mocked(searchTfl).mockResolvedValue([{ id: "t1" }] as never);
    vi.mocked(searchNps).mockRejectedValue(new Error("NPS down"));
    vi.mocked(searchUsStateSources).mockRejectedValue(new Error("DOT down"));

    vi.mocked(mapCaltransToResult).mockReturnValue(
      makeResult("us-ca-caltrans:7:1", "us-ca-caltrans", "traffic"),
    );
    vi.mocked(mapTflToResult).mockReturnValue(makeResult("gb-eng-tfl:1", "gb-eng-tfl", "traffic"));

    const results = (await webcamProvider.search(makeBbox())).data;
    expect(results).toHaveLength(2);
  });

  it("all sources fail returns empty array", async () => {
    vi.mocked(searchWindy).mockRejectedValue(new Error("down"));
    vi.mocked(searchOsmWebcams).mockRejectedValue(new Error("down"));
    vi.mocked(searchCaltrans).mockRejectedValue(new Error("down"));
    vi.mocked(searchTfl).mockRejectedValue(new Error("down"));
    vi.mocked(searchNps).mockRejectedValue(new Error("down"));
    vi.mocked(searchUsStateSources).mockRejectedValue(new Error("down"));
    vi.mocked(searchCameraSources).mockRejectedValue(new Error("down"));
    vi.mocked(deduplicateByCoordinates).mockReturnValue([]);

    const results = (await webcamProvider.search(makeBbox())).data;
    expect(results).toEqual([]);
  });

  it("applies category filter server-side", async () => {
    vi.mocked(searchWindy).mockResolvedValue([]);
    vi.mocked(searchOsmWebcams).mockResolvedValue([]);
    vi.mocked(searchCaltrans).mockResolvedValue([]);
    vi.mocked(searchTfl).mockResolvedValue([]);
    vi.mocked(searchNps).mockResolvedValue([]);
    vi.mocked(searchUsStateSources).mockResolvedValue([]);

    const items = [
      makeResult("a", "windy", "landscape"),
      makeResult("b", "us-ca-caltrans", "traffic"),
      makeResult("c", "windy", "city"),
    ];
    vi.mocked(deduplicateByCoordinates).mockReturnValue(items);

    const results = (await webcamProvider.search(makeBbox(), { category: ["traffic"] })).data;
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

    const envelope = await webcamProvider.getDetail("windy:123");
    expect(getWindyDetail).toHaveBeenCalledWith("123");
    expect(envelope.data).toBe(detail);
    expect(envelope.attributions.length).toBeGreaterThan(0);
    expect(envelope.attributions[0].sourceId).toBe("windy");
    expect(envelope.freshness.fetchedAt).toBeTruthy();
  });

  it("osm-webcam prefix calls getOsmWebcamNode", async () => {
    const raw = { id: "osm-webcam:456" };
    const detail = {
      id: "osm-webcam:456",
      sources: ["osm"],
      name: "OSM",
      coordinates: [11, 48] as [number, number],
      sections: [],
    };
    vi.mocked(getOsmWebcamNode).mockResolvedValue(raw as never);
    vi.mocked(mapOsmToDetail).mockReturnValue(detail);

    const result = (await webcamProvider.getDetail("osm-webcam:456")).data;
    expect(getOsmWebcamNode).toHaveBeenCalledWith(456);
    expect(result).toBe(detail);
  });

  it("caltrans prefix calls getCaltransDetail with district and index", async () => {
    const raw = { id: "us-ca-caltrans:7:42" };
    const detail = {
      id: "us-ca-caltrans:7:42",
      sources: ["us-ca-caltrans"],
      name: "Test",
      coordinates: [-118, 34] as [number, number],
      sections: [],
    };
    vi.mocked(getCaltransDetail).mockResolvedValue(raw as never);
    vi.mocked(mapCaltransToDetail).mockReturnValue(detail);

    const result = (await webcamProvider.getDetail("us-ca-caltrans:7:42")).data;
    expect(getCaltransDetail).toHaveBeenCalledWith("7", "42");
    expect(result).toBe(detail);
  });

  it("tfl prefix calls getTflDetail", async () => {
    const raw = { id: "gb-eng-tfl:JamCams_00001" };
    const detail = {
      id: "gb-eng-tfl:JamCams_00001",
      sources: ["gb-eng-tfl"],
      name: "TfL",
      coordinates: [-0.1, 51.5] as [number, number],
      sections: [],
    };
    vi.mocked(getTflDetail).mockResolvedValue(raw as never);
    vi.mocked(mapTflToDetail).mockReturnValue(detail);

    const result = (await webcamProvider.getDetail("gb-eng-tfl:JamCams_00001")).data;
    expect(getTflDetail).toHaveBeenCalledWith("JamCams_00001");
    expect(result).toBe(detail);
  });

  it("nps prefix calls getNpsDetail", async () => {
    const raw = { id: "us-nps:ABC-123" };
    const detail = {
      id: "us-nps:ABC-123",
      sources: ["us-nps"],
      name: "Yellowstone",
      coordinates: [-110, 44] as [number, number],
      sections: [],
    };
    vi.mocked(getNpsDetail).mockResolvedValue(raw as never);
    vi.mocked(mapNpsToDetail).mockReturnValue(detail);

    const result = (await webcamProvider.getDetail("us-nps:ABC-123")).data;
    expect(getNpsDetail).toHaveBeenCalledWith("ABC-123");
    expect(result).toBe(detail);
  });

  it("US state source prefix calls getUsStateSourceDetail", async () => {
    const raw = { id: "us-ny-511:Skyline-123" };
    const detail = {
      id: "us-ny-511:Skyline-123",
      sources: ["us-ny-511"],
      name: "I-87 at Exit 5",
      coordinates: [-73.8, 41.0] as [number, number],
      sections: [],
    };
    vi.mocked(getUsStateSourceDetail).mockResolvedValue(raw as never);
    vi.mocked(mapUsStateSourceToDetail).mockReturnValue(detail);

    const result = (await webcamProvider.getDetail("us-ny-511:Skyline-123")).data;
    expect(getUsStateSourceDetail).toHaveBeenCalledWith("us-ny-511:Skyline-123");
    expect(result).toBe(detail);
  });

  it("registered camera-source prefix dispatches to its adapter", async () => {
    const raw = { id: "fi-digitraffic-webcam:C01503" };
    const detail = {
      id: "fi-digitraffic-webcam:C01503",
      sources: ["fi-digitraffic-webcam"],
      name: "Inkoo",
      coordinates: [24, 60] as [number, number],
      sections: [],
    };
    vi.mocked(getCameraSourceDetail).mockResolvedValue(raw as never);
    vi.mocked(mapCameraSourceToDetail).mockReturnValue(detail);

    const result = (await webcamProvider.getDetail("fi-digitraffic-webcam:C01503")).data;
    expect(getCameraSourceDetail).toHaveBeenCalledWith("fi-digitraffic-webcam:C01503");
    expect(result).toBe(detail);
  });

  it("unknown prefix returns null", async () => {
    const result = (await webcamProvider.getDetail("unknown:123")).data;
    expect(result).toBeNull();
  });
});
