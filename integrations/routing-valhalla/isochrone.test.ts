import { withRoutingContributors } from "@openmapx/integration-framework";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ValhallaFetch, valhallaHarness } from "./__tests__/valhalla-http.js";

const valhalla = valhallaHarness();
let answer: ReturnType<typeof vi.fn<ValhallaFetch>>;

beforeEach(() => {
  answer = vi.fn<ValhallaFetch>(async () => Response.json(makeIsochroneResponse([])));
  valhalla.answer = answer;
  valhalla.settings = { bidirectionalAlternates: true, url: "http://valhalla.internal:8002" };
});

function isochrone(...args: Parameters<NonNullable<typeof valhalla.service.getIsochrone>>) {
  const getIsochrone = valhalla.service.getIsochrone;
  if (!getIsochrone) throw new Error("Valhalla offers no isochrones");
  return getIsochrone.apply(valhalla.service, args);
}

function makePolygonFeature(contour: number, metric = "time") {
  return {
    type: "Feature" as const,
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [13.3, 52.5],
          [13.4, 52.5],
          [13.4, 52.6],
          [13.3, 52.6],
          [13.3, 52.5],
        ],
      ],
    },
    properties: { metric, contour, color: "#ff0000", opacity: 0.33 },
  };
}

function makeMultiPolygonFeature(contour: number) {
  return {
    type: "Feature" as const,
    geometry: {
      type: "MultiPolygon" as const,
      coordinates: [
        [
          [
            [13.3, 52.5],
            [13.35, 52.5],
            [13.35, 52.55],
            [13.3, 52.5],
          ],
        ],
        [
          [
            [13.4, 52.5],
            [13.45, 52.5],
            [13.45, 52.55],
            [13.4, 52.5],
          ],
        ],
      ],
    },
    properties: { metric: "time", contour },
  };
}

function makeIsochroneResponse(features: unknown[]) {
  return { type: "FeatureCollection", features };
}

function requestOf(index: number): { url: string; body: Record<string, unknown> } {
  const call = answer.mock.calls[index];
  if (!call) throw new Error(`no request ${index}`);
  return { url: call[0], body: JSON.parse(call[1].body) as Record<string, unknown> };
}

const origin: [number, number] = [13.388, 52.517];

describe("Valhalla isochrones", () => {
  it("returns empty contours without a request when no contour is asked for", async () => {
    const result = await isochrone(origin, "driving", []);
    expect(result).toMatchObject({ origin, mode: "driving", contours: [] });
    expect(answer).not.toHaveBeenCalled();
  });

  it("refuses more than 4 contours", async () => {
    await expect(isochrone(origin, "driving", [5, 10, 15, 20, 25])).rejects.toThrow(
      "Valhalla supports a maximum of 4 contours per request",
    );
  });

  it.each([
    ["driving", "auto", 15, 50],
    ["walking", "pedestrian", 30, 100],
    ["cycling", "bicycle", 31, 200],
  ] as const)(
    "serializes %s contours using %s costing",
    async (mode, costing, minutes, generalize) => {
      answer.mockResolvedValueOnce(Response.json(makeIsochroneResponse([makePolygonFeature(10)])));
      const result = await isochrone(origin, mode, [minutes]);
      const request = requestOf(0);
      expect(request.url).toBe("http://valhalla.internal:8002/isochrone");
      expect(request.body).toMatchObject({
        locations: [{ lon: 13.388, lat: 52.517 }],
        costing,
        contours: [{ time: minutes }],
        polygons: true,
        denoise: 1,
        generalize,
      });
      expect(result.origin).toEqual(origin);
      expect(result.mode).toBe(mode);
    },
  );

  it("asks for and returns contours in ascending time", async () => {
    answer.mockResolvedValueOnce(
      Response.json(
        makeIsochroneResponse([
          makePolygonFeature(30),
          makePolygonFeature(10),
          makePolygonFeature(20),
        ]),
      ),
    );
    const result = await isochrone(origin, "driving", [30, 10, 20]);
    expect(requestOf(0).body.contours).toEqual([{ time: 10 }, { time: 20 }, { time: 30 }]);
    expect(result.contours.map((contour) => contour.time)).toEqual([10, 20, 30]);
  });

  it("keeps only time contours", async () => {
    answer.mockResolvedValueOnce(
      Response.json(
        makeIsochroneResponse([
          makePolygonFeature(10, "time"),
          makePolygonFeature(5, "distance"),
          makePolygonFeature(20, "time"),
        ]),
      ),
    );
    const result = await isochrone(origin, "driving", [10, 20]);
    expect(result.contours.map((contour) => contour.time)).toEqual([10, 20]);
  });

  it("passes Polygon and MultiPolygon geometry through", async () => {
    const polygon = makePolygonFeature(15);
    const multi = makeMultiPolygonFeature(20);
    answer.mockResolvedValueOnce(Response.json(makeIsochroneResponse([polygon, multi])));
    const result = await isochrone(origin, "driving", [15, 20]);
    expect(result.contours.map((contour) => contour.geometry)).toEqual([
      polygon.geometry,
      multi.geometry,
    ]);
  });

  it("names the status and the engine's message on an HTTP error", async () => {
    answer.mockResolvedValueOnce(new Response("Invalid costing options", { status: 422 }));
    await expect(isochrone(origin, "driving", [10])).rejects.toThrow(
      "Valhalla isochrone error 422: Invalid costing options",
    );
  });

  it("sends the configured API key", async () => {
    valhalla.settings = { bidirectionalAlternates: true, apiKey: "test-stadia-key" };
    await isochrone(origin, "driving", [10]);
    expect(requestOf(0).url).toBe("https://api.stadiamaps.com/isochrone?api_key=test-stadia-key");
  });
});

it("credits each contour with the sources captured for the call", async () => {
  const credit = { sourceId: "valhalla", name: "Valhalla" };
  const credited = withRoutingContributors(valhalla.service, () => [credit]);
  const getIsochrone = credited.getIsochrone;
  if (!getIsochrone) throw new Error("the wrapper dropped isochrones");

  answer.mockResolvedValueOnce(Response.json(makeIsochroneResponse([makePolygonFeature(5)])));
  const result = await getIsochrone(origin, "driving", [5]);
  expect(result.contours[0]?.contributors).toEqual([credit]);
  expect(result.contributors).toEqual([credit]);
  expect(result.attributions).toEqual([credit]);
  expect(result.contours[0]?.contributors).not.toBe(result.attributions);

  answer.mockResolvedValueOnce(
    Response.json(makeIsochroneResponse([makePolygonFeature(5, "distance")])),
  );
  const empty = await getIsochrone(origin, "driving", [5]);
  expect(empty).toMatchObject({ contours: [], contributors: [], attributions: [] });
});

it("declares that its routes carry traffic proofs", () => {
  expect(valhalla.service.supportsTrafficProof).toBe(true);
});
