import type { FakeHttpRequest } from "@openmapx/integration-framework/testing";
import {
  createFencedMemoryCache,
  createMockIntegrationContext,
  createRecordingReply,
  fakeHttpClient,
  httpStatus,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { setup } from "./index.js";

const CAPABILITIES_XML = `<?xml version="1.0"?>
<Capabilities><Contents>
  <Layer>
    <Identifier>MODIS_Terra_CorrectedReflectance_TrueColor</Identifier>
    <Dimension><Default>2026-11-19</Default><Value>2000-02-24/2026-11-19/P1D</Value></Dimension>
    <Style><LegendURL role="horizontal" href="https://gibs.test/legends/truecolor_H.svg"/></Style>
  </Layer>
  <Layer><Identifier>Unrelated_Layer</Identifier></Layer>
</Contents></Capabilities>`;

function satellite(responder: (req: FakeHttpRequest) => unknown) {
  const http = fakeHttpClient(responder);
  const ctx = createMockIntegrationContext({ http, cache: createFencedMemoryCache() });
  setup(ctx);
  const call = async (path: string, params: Record<string, string>) => {
    const route = ctx.registered.routes.find((r) => r.path === path);
    if (!route) throw new Error(`route ${path} not registered`);
    const { reply, result } = createRecordingReply();
    await route.handler({ query: {}, params, body: undefined, clientKey: "c", headers: {} }, reply);
    return { result, route };
  };
  const upstream = () => http.calls.filter((c) => c.method !== "getText");
  return { http, call, upstream };
}

const image = (contentType: string) => () => ({
  status: 200,
  headers: { "content-type": contentType },
  stream: new Blob([new Uint8Array([1])]).stream(),
});

describe("overlay-satellite capabilities", () => {
  it("reads the bounded GetCapabilities document through the host client", async () => {
    const { http, call } = satellite((req) =>
      req.method === "getText" ? { status: 200, headers: {}, body: CAPABILITIES_XML } : null,
    );

    const { result } = await call("/capabilities", {});

    expect(result.body).toEqual({
      trueColor: {
        defaultDate: "2026-11-19",
        startDate: "2000-02-24",
        legend: "truecolor_H.png",
      },
    });
    const request = http.calls.find((c) => c.method === "getText");
    expect(request?.options).toMatchObject({
      contentTypes: ["text/xml", "application/xml"],
      maxBytes: 24 * 1024 * 1024,
    });
  });

  it("answers 502 when GIBS fails", async () => {
    const { call } = satellite(() => httpStatus(503));
    expect((await call("/capabilities", {})).result.status).toBe(502);
  });
});

describe("overlay-satellite tile route", () => {
  it("builds the WMTS URL with z/y/x order on the tile tier", async () => {
    const { call, upstream } = satellite(image("image/jpeg"));

    const { result, route } = await call("/tiles/:layerId/:date/:z/:y/:x", {
      layerId: "trueColor",
      date: "2020-01-02",
      z: "3",
      y: "2",
      x: "5",
    });

    expect(route.options?.rateLimitTier).toBe("tile");
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("image/jpeg");
    expect(result.headers["cache-control"]).toBe("public, max-age=86400, s-maxage=86400");
    expect(upstream()[0]?.url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2020-01-02/GoogleMapsCompatible_Level9/3/2/5.jpg",
    );
  });

  it("caches today's tiles for an hour", async () => {
    const { call } = satellite(image("image/jpeg"));
    const today = new Date().toISOString().slice(0, 10);
    const { result } = await call("/tiles/:layerId/:date/:z/:y/:x", {
      layerId: "trueColor",
      date: today,
      z: "1",
      y: "0",
      x: "0",
    });
    expect(result.headers["cache-control"]).toBe("public, max-age=3600, s-maxage=3600");
  });

  it.each([
    ["an unknown layer", { layerId: "nope", date: "2020-01-02", z: "1", y: "0", x: "0" }],
    ["a malformed date", { layerId: "trueColor", date: "2020-1-2", z: "1", y: "0", x: "0" }],
    [
      "a zoom above the layer's matrix",
      { layerId: "trueColor", date: "2020-01-02", z: "10", y: "0", x: "0" },
    ],
    [
      "an encoded slash in x",
      { layerId: "trueColor", date: "2020-01-02", z: "1", y: "0", x: "..%2F..%2Fx" },
    ],
    [
      "a decoded traversal in y",
      { layerId: "trueColor", date: "2020-01-02", z: "1", y: "../x", x: "0" },
    ],
    ["x outside the grid", { layerId: "trueColor", date: "2020-01-02", z: "1", y: "0", x: "2" }],
  ])("refuses %s without an upstream request", async (_label, params) => {
    const { call, upstream } = satellite(image("image/png"));
    expect((await call("/tiles/:layerId/:date/:z/:y/:x", params)).result.status).toBe(400);
    expect(upstream()).toHaveLength(0);
  });

  it("does not relay a GIBS 403 to the browser", async () => {
    const { call } = satellite(() => httpStatus(403));
    const { result } = await call("/tiles/:layerId/:date/:z/:y/:x", {
      layerId: "trueColor",
      date: "2020-01-02",
      z: "1",
      y: "0",
      x: "0",
    });
    expect(result.status).toBe(502);
  });
});

describe("overlay-satellite legend route", () => {
  it("proxies a PNG legend and refuses other filenames", async () => {
    const { call, upstream } = satellite(image("image/png"));

    const ok = await call("/legends/:filename", { filename: "truecolor_H.png" });
    const refused = await call("/legends/:filename", { filename: "../secret.png" });

    expect(ok.result.status).toBe(200);
    expect(upstream().map((c) => c.url)).toEqual([
      "https://gibs.earthdata.nasa.gov/legends/truecolor_H.png",
    ]);
    expect(refused.result.status).toBe(400);
  });
});
