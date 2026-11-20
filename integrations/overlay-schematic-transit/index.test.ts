import { USER_AGENT } from "@openmapx/core";
import type { ResponseOptions, StreamHttpResponse } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  createRecordingReply,
  type FakeHttpResponder,
  fakeHttpClient,
  httpStatus,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { setup } from "./index.js";

function mvt(bytes = 64): StreamHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
    stream: new Blob([new Uint8Array(bytes)]).stream(),
  };
}

function setupWith(responder: FakeHttpResponder, config: Record<string, unknown> = {}) {
  const http = fakeHttpClient(responder);
  const ctx = createMockIntegrationContext({ http, config });
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/tiles/:network/:layout/:z/:x/:y");
  if (!route) throw new Error("tile route not registered");
  const call = async (params: Record<string, string>) => {
    const { reply, result } = createRecordingReply();
    await route.handler({ query: {}, params, body: undefined, clientKey: "c", headers: {} }, reply);
    return result;
  };
  return { http, route, call };
}

describe("overlay-schematic-transit tile proxy", () => {
  it("registers the tile route on the tile rate-limit tier", () => {
    expect(setupWith(() => mvt()).route.options?.rateLimitTier).toBe("tile");
  });

  it("proxies a valid tile with week-long caching headers and the application user agent", async () => {
    const { http, call } = setupWith(() => mvt());
    const result = await call({
      network: "subway-lightrail",
      layout: "octi",
      z: "11",
      x: "1100",
      y: "671",
    });

    expect(http.calls.map((c) => c.url)).toEqual([
      "https://loom.cs.uni-freiburg.de/tiles/subway-lightrail/octi/11/1100/671.mvt",
    ]);
    expect((http.calls[0]?.options as ResponseOptions).headers?.["User-Agent"]).toBe(USER_AGENT);
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("public, max-age=604800, s-maxage=604800");
    expect(result.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(result.contentType).toBe("application/octet-stream");
  });

  it.each([
    { name: "unknown network", params: { network: "bus", layout: "geo", z: "3", x: "1", y: "1" } },
    {
      name: "unsupported geo-octi layout",
      params: { network: "tram", layout: "geo-octi", z: "3", x: "1", y: "1" },
    },
    {
      name: "path traversal in z",
      params: { network: "tram", layout: "geo", z: "..", x: "1", y: "1" },
    },
    { name: "non-numeric x", params: { network: "tram", layout: "geo", z: "3", x: "a", y: "1" } },
    { name: "zoom above 22", params: { network: "tram", layout: "geo", z: "123", x: "1", y: "1" } },
    {
      name: "x outside the grid",
      params: { network: "tram", layout: "geo", z: "1", x: "2", y: "0" },
    },
  ])("rejects $name with 400 and no upstream request", async ({ params }) => {
    const { http, call } = setupWith(() => mvt());
    expect((await call(params)).status).toBe(400);
    expect(http.calls).toHaveLength(0);
  });

  it("maps upstream 404 (empty area) to a cacheable empty 204", async () => {
    const { call } = setupWith(() => httpStatus(404));
    const result = await call({ network: "tram", layout: "geo", z: "11", x: "300", y: "700" });
    expect(result.status).toBe(204);
    expect(result.headers["cache-control"]).toBe("public, max-age=86400");
    expect(result.body).toBeUndefined();
  });

  it("answers 502 for an upstream 500 or a failed request", async () => {
    const failed = setupWith(() => httpStatus(500));
    expect(
      (await failed.call({ network: "rail", layout: "geo", z: "3", x: "1", y: "1" })).status,
    ).toBe(502);
    const thrown = setupWith(() => {
      throw new Error("connect timeout");
    });
    expect(
      (await thrown.call({ network: "rail", layout: "geo", z: "3", x: "1", y: "1" })).status,
    ).toBe(502);
  });

  it("respects a configured tileBaseUrl override", async () => {
    const { http, call } = setupWith(() => mvt(), {
      tileBaseUrl: "https://loom.example.org/tiles/",
    });
    await call({ network: "rail", layout: "geo", z: "3", x: "1", y: "1" });
    expect(http.calls[0]?.url).toBe("https://loom.example.org/tiles/rail/geo/3/1/1.mvt");
  });
});
