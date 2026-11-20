import type { ResponseOptions } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  createRecordingReply,
  fakeHttpClient,
  httpStatus,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { setup } from "./index.js";

function tileRoute(responder: Parameters<typeof fakeHttpClient>[0], config = {}) {
  const http = fakeHttpClient(responder);
  const ctx = createMockIntegrationContext({ http, config });
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/tiles/:z/:x/:y.png");
  if (!route) throw new Error("tile route not registered");
  const call = async (params: Record<string, string>) => {
    const { reply, result } = createRecordingReply();
    await route.handler({ query: {}, params, body: undefined, clientKey: "c", headers: {} }, reply);
    return result;
  };
  return { http, route, call };
}

const png = () => ({
  status: 200,
  headers: { "content-type": "image/png" },
  stream: new Blob([new Uint8Array([1])]).stream(),
});

describe("overlay-winter-sports tile route", () => {
  it("proxies a valid OpenSnowMap tile on the tile tier", async () => {
    const { http, route, call } = tileRoute(png);

    const result = await call({ z: "10", x: "533", y: "358" });

    expect(route.options?.rateLimitTier).toBe("tile");
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("public, max-age=604800, s-maxage=604800");
    expect(http.calls[0]?.url).toBe("https://tiles.opensnowmap.org/pistes/10/533/358.png");
    expect((http.calls[0]?.options as ResponseOptions).contentTypes).toContain("image/png");
  });

  it("uses a configured tile URL template", async () => {
    const { http, call } = tileRoute(png, { tileUrl: "https://snow.example/{z}/{x}/{y}.png" });
    await call({ z: "2", x: "1", y: "3" });
    expect(http.calls[0]?.url).toBe("https://snow.example/2/1/3.png");
  });

  it.each([
    ["a fractional coordinate", { z: "10", x: "533.5", y: "358" }],
    ["a zoom above 18", { z: "19", x: "0", y: "0" }],
    ["x outside the grid", { z: "1", x: "2", y: "0" }],
  ])("refuses %s without an upstream request", async (_label, params) => {
    const { http, call } = tileRoute(png);
    expect((await call(params)).status).toBe(400);
    expect(http.calls).toHaveLength(0);
  });

  it("maps upstream 404 to 404 and throttling to 502", async () => {
    expect((await tileRoute(() => httpStatus(404)).call({ z: "1", x: "0", y: "0" })).status).toBe(
      404,
    );
    expect((await tileRoute(() => httpStatus(429)).call({ z: "1", x: "0", y: "0" })).status).toBe(
      502,
    );
  });
});
