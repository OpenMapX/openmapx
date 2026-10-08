import type { BoundingBox } from "@openmapx/core";
import type {
  Camera,
  CameraProvider,
  CameraQuery,
  CameraView,
  IntegrationContext,
} from "@openmapx/integration-framework";
import { describe, expect, test, vi } from "vitest";
import { createWebcamDataSource } from "../data-source.js";

/** A box a map at zoom 12 shows over Helsinki. */
const BBOX: BoundingBox = { west: 24.8, south: 60.12, east: 25.0, north: 60.24 };

function view(over: Partial<CameraView> = {}): CameraView {
  return {
    key: "0",
    imageUrl: "https://weathercam.digitraffic.fi/C0150200.jpg",
    status: "online",
    stale: false,
    ...over,
  };
}

function cam(over: Partial<Camera> & Pick<Camera, "id">): Camera {
  return {
    name: `Camera ${over.id}`,
    type: "traffic",
    coordinates: [24.9, 60.17],
    views: [view()],
    sources: ["src-a"],
    attributions: [{ sourceId: "src-a", name: "Source A" }],
    ...over,
  };
}

function provider(
  id: string,
  cameras: Camera[] | Error,
  over: Partial<CameraProvider> = {},
): CameraProvider {
  return {
    id,
    searchCameras: vi.fn(async () => {
      if (cameras instanceof Error) throw cameras;
      return { cameras };
    }),
    getCamera: vi.fn(async (cameraId: string) =>
      cameras instanceof Error ? null : (cameras.find((c) => c.id === cameraId) ?? null),
    ),
    ...over,
  };
}

type LogLine = { level: string; message: string };

/** A context over `providers`, read at every call, so a test may register or drop one later. */
function ctxWith(
  providers: CameraProvider[],
  opts: { disallowed?: string[]; lines?: LogLine[] } = {},
): IntegrationContext {
  const at =
    (level: string) =>
    (message: string): void => {
      opts.lines?.push({ level, message });
    };
  return {
    getIntegrationsByDomain: (domain: string) =>
      domain === "cameras"
        ? providers.map((p) => ({
            id: p.id,
            providers: new Map<string, CameraProvider[]>([["cameras", [p]]]),
          }))
        : [],
    getDisallowedSourceIds: opts.disallowed ? async () => new Set(opts.disallowed) : undefined,
    log: { warn: at("warn"), error: at("error"), info: at("info"), debug: at("debug") },
  } as unknown as IntegrationContext;
}

describe("webcam orchestrator", () => {
  test("search merges providers, survives one failing, and passes a partial reason through", async () => {
    const lines: LogLine[] = [];
    const a = provider("a", [cam({ id: "a:1" }), cam({ id: "a:2" })]);
    const source = createWebcamDataSource(
      ctxWith(
        [
          a,
          provider("b", new Error("upstream down")),
          provider("c", [], {
            searchCameras: vi.fn(async () => ({
              cameras: [cam({ id: "c:1", sources: ["src-c"] })],
              partial: "area" as const,
            })),
          }),
        ],
        { lines },
      ),
    );

    const result = await source.search(BBOX);

    expect(result.data.map((r) => r.id)).toEqual(["a:1", "a:2", "c:1"]);
    expect(result.data.map((r) => r.source)).toEqual(["src-a", "src-a", "src-c"]);
    expect(result.partial).toBe("area");
    expect(a.searchCameras).toHaveBeenCalledWith([24.8, 60.12, 25.0, 60.24], expect.any(Object));
    expect(source.id).toBe("webcam");
    expect(source.searchCacheTtl).toBe(60);
    expect(source.detailCacheTtl).toBe(30);
    expect(source.attribution).toEqual([]);
    expect(lines.filter((l) => l.level === "warn")[0]?.message).toMatch(
      /\[webcam\].*b.*upstream down/,
    );

    const onlyFailing = await createWebcamDataSource(
      ctxWith([provider("a", [cam({ id: "a:1" })]), provider("b", new Error("down"))]),
    ).search(BBOX);
    expect(onlyFailing.partial).toBe("unavailable");

    const complete = await createWebcamDataSource(
      ctxWith([provider("a", [cam({ id: "a:1" })])]),
    ).search(BBOX);
    expect(complete.partial).toBeUndefined();
  });

  test("providers whose coverage misses the box are not asked", async () => {
    const far = provider("far", [cam({ id: "far:1" })], { coverage: { bbox: [2, 48, 3, 49] } });
    const near = provider("near", [cam({ id: "near:1" })], {
      coverage: { bbox: [24, 59.5, 26, 61] },
    });

    const result = await createWebcamDataSource(ctxWith([far, near])).search(BBOX);

    expect(far.searchCameras).not.toHaveBeenCalled();
    expect(result.data.map((r) => r.id)).toEqual(["near:1"]);
  });

  test("the data-use policy's disallowed sources are excluded, also inside a camera's members", async () => {
    const a = provider("a", [
      cam({ id: "a:ok", sources: ["src-a"] }),
      cam({ id: "a:blocked", sources: ["windy-cameras"] }),
      cam({ id: "a:merged", sources: ["src-a", "windy-cameras"] }),
    ]);
    const source = createWebcamDataSource(ctxWith([a], { disallowed: ["windy-cameras"] }));

    const result = await source.search(BBOX);

    expect(result.data.map((r) => r.id)).toEqual(["a:ok"]);
    const query = vi.mocked(a.searchCameras).mock.calls[0][1] as CameraQuery;
    expect(query.excludedSourceIds).toEqual(["windy-cameras"]);

    expect((await source.getDetail("a:merged")).data).toBeNull();
    expect(a.getCamera).toHaveBeenCalledWith("a:merged", { excludedSourceIds: ["windy-cameras"] });
  });

  test("a box wider than the minimum zoom shows is answered empty, asking no provider", async () => {
    const p = provider("a", [cam({ id: "a:1" })]);
    const source = createWebcamDataSource(ctxWith([p]));

    const country = await source.search({ west: 19.0, south: 59.0, east: 32.0, north: 70.0 });
    expect(country.data).toEqual([]);
    expect(p.searchCameras).not.toHaveBeenCalled();

    const near = await source.search(BBOX);
    expect(near.data.map((r) => r.id)).toEqual(["a:1"]);
  });

  test("with no provider the search is empty, without errors, and isAvailable is false", async () => {
    const lines: LogLine[] = [];
    const providers: CameraProvider[] = [];
    const source = createWebcamDataSource(ctxWith(providers, { lines }));

    expect(source.isAvailable?.()).toBe(false);
    const result = await source.search(BBOX);
    expect(result.data).toEqual([]);
    expect(result.attributions).toEqual([]);
    expect(result.partial).toBeUndefined();
    const miss = await source.getDetail("a:1");
    expect(miss.data).toBeNull();
    expect(miss.attributions).toEqual([]);
    expect(lines.filter((l) => l.level === "warn" || l.level === "error")).toEqual([]);

    providers.push(provider("a", []));
    expect(source.isAvailable?.()).toBe(true);
  });

  test("getDetail asks the provider that holds the camera; a miss is null", async () => {
    const a = provider("a", [cam({ id: "a:1" })]);
    const b = provider("b", [
      cam({
        id: "b:7",
        name: "Kehä I",
        detailUrl: "https://www.digitraffic.fi/kelikamerat/C01502",
        sources: ["src-b"],
        attributions: [{ sourceId: "src-b", name: "Source B" }],
      }),
    ]);
    const source = createWebcamDataSource(ctxWith([a, b]));

    const detail = await source.getDetail("b:7");

    expect(detail.data?.id).toBe("b:7");
    expect(detail.data?.sources).toEqual(["src-b"]);
    expect(detail.data?.website).toBe("https://www.digitraffic.fi/kelikamerat/C01502");
    expect(detail.attributions).toEqual([{ sourceId: "src-b", name: "Source B" }]);
    expect(b.getCamera).toHaveBeenCalledWith("b:7", { excludedSourceIds: [] });
    expect(b.searchCameras).not.toHaveBeenCalled();

    const miss = await source.getDetail("nowhere:1");
    expect(miss.data).toBeNull();
    expect(miss.attributions).toEqual([]);
  });

  test("the search's attributions are every contributing credit, once", async () => {
    const source = createWebcamDataSource(
      ctxWith([
        provider("a", [cam({ id: "a:1" }), cam({ id: "a:2" })]),
        provider("c", [
          cam({
            id: "c:1",
            sources: ["src-c"],
            attributions: [{ sourceId: "src-c", name: "Trafikverket", spdxLicense: "CC0-1.0" }],
          }),
        ]),
      ]),
    );

    const result = await source.search(BBOX);

    expect(result.attributions.map((a) => a.sourceId)).toEqual(["src-a", "src-c"]);
    expect(result.data[2].attributions).toEqual([
      { text: "Trafikverket", url: "", license: "CC0-1.0" },
    ]);
  });

  test("the category filter keeps the selected camera types and is passed on as a hint", async () => {
    const a = provider("a", [
      cam({ id: "t", type: "traffic" }),
      cam({ id: "w", type: "weather" }),
      cam({ id: "b", type: "beach" }),
    ]);
    const source = createWebcamDataSource(ctxWith([a]));
    const ids = async (filters: Record<string, unknown>) =>
      (await source.search(BBOX, filters)).data.map((r) => r.id);

    expect(await ids({ category: ["traffic", "beach"] })).toEqual(["t", "b"]);
    expect(vi.mocked(a.searchCameras).mock.calls[0][1]).toEqual(
      expect.objectContaining({ types: ["traffic", "beach"] }),
    );
    expect(await ids({ category: "weather" })).toEqual(["w"]);
    expect(await ids({})).toEqual(["t", "w", "b"]);
  });

  test("the meta keeps the zoom, the six type colours, the dimming and the icon", async () => {
    const source = createWebcamDataSource(ctxWith([]));

    expect(source.meta.minZoom).toBe(8);
    expect(source.meta.placeCategory).toBe("Webcam");
    expect(source.meta.placeCategoryRaw).toBe("webcam");
    expect(source.meta.osmFilters).toBeUndefined();
    expect(source.meta.markerStyle.variantColors).toEqual({
      landscape: "#4CAF50",
      traffic: "#FF9800",
      city: "#2196F3",
      weather: "#9C27B0",
      beach: "#00BCD4",
      other: "#9E9E9E",
    });
    expect(source.meta.markerStyle.defaultColor).toBe("#9E9E9E");
    expect(source.meta.markerStyle.inactiveOpacity).toBe(0.4);
    expect(source.meta.markerStyle.iconPath).toBe(
      "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z",
    );
  });

  test("the only filter is the server-side category of the six camera types", async () => {
    const filters = await createWebcamDataSource(ctxWith([])).getFilters();

    expect(
      filters.map((f) => [f.id, f.type, f.clientSide ?? false, f.options?.map((o) => o.id)]),
    ).toEqual([
      [
        "category",
        "multi-select",
        false,
        ["landscape", "traffic", "city", "weather", "beach", "other"],
      ],
    ]);
    expect(filters[0].label).toBe("Category");
  });

  test("a camera whose every view is offline is listed, dimmed", async () => {
    const source = createWebcamDataSource(
      ctxWith([
        provider("a", [
          cam({
            id: "down",
            views: [view({ status: "offline" }), view({ key: "1", stale: true })],
          }),
        ]),
      ]),
    );

    const [result] = (await source.search(BBOX)).data;

    expect(result.id).toBe("down");
    expect(result.status).toBe("non-operational");
  });
});
