import type { IntegrationContext, ResponseOptions } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  createRecordingReply,
  fakeHttpClient,
  httpStatus,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { setup } from "../index";
import manifest from "../manifest.json";

function tileRoute(accessToken: string, responder: Parameters<typeof fakeHttpClient>[0]) {
  const http = fakeHttpClient(responder);
  const warnings: string[] = [];
  const ctx = createMockIntegrationContext({
    manifest: structuredClone(manifest) as IntegrationContext["manifest"],
    config: { accessToken },
    http,
    log: {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (message: string) => warnings.push(message),
    },
  });
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/tiles/:z/:x/:y");
  if (!route) throw new Error("tile route not registered");
  const call = async (params: Record<string, string>) => {
    const { reply, result } = createRecordingReply();
    await route.handler({ query: {}, params, body: undefined, clientKey: "c", headers: {} }, reply);
    return result;
  };
  return { http, route, call, warnings };
}

const mvt = () => ({
  status: 200,
  headers: { "content-type": "application/x-protobuf" },
  stream: new Blob([new Uint8Array([1, 2])]).stream(),
});

describe("street-level-imagery-mapillary tile route", () => {
  it("streams a vector tile with the token in the query on the tile tier", async () => {
    const { http, route, call } = tileRoute("TOKEN", mvt);

    const result = await call({ z: "14", x: "8529", y: "5449" });

    expect(route.options?.rateLimitTier).toBe("tile");
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/x-protobuf");
    expect(result.headers["cache-control"]).toBe("public, max-age=86400, s-maxage=86400");
    expect(http.calls[0]?.url).toBe(
      "https://tiles.mapillary.com/maps/vtp/mly1_public/2/14/8529/5449?access_token=TOKEN",
    );
    const options = http.calls[0]?.options as ResponseOptions;
    expect(options.timeoutMs).toBe(25_000);
    expect(options.maxBytes).toBe(2 * 1024 * 1024);
  });

  it("answers 503 without a token and never calls the upstream", async () => {
    const { http, call } = tileRoute("", mvt);
    expect((await call({ z: "1", x: "0", y: "0" })).status).toBe(503);
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    ["a zoom above the coverage layer", { z: "15", x: "0", y: "0" }],
    ["a non-numeric zoom", { z: "1; DROP", x: "1", y: "1" }],
    ["y outside the grid", { z: "2", x: "0", y: "4" }],
  ])("refuses %s", async (_label, params) => {
    const { http, call } = tileRoute("TOKEN", mvt);
    expect((await call(params)).status).toBe(400);
    expect(http.calls).toHaveLength(0);
  });

  it("answers 502 for a rejected token and keeps the token out of the log", async () => {
    const { call, warnings } = tileRoute("TOKEN", () => httpStatus(403));
    const result = await call({ z: "1", x: "0", y: "0" });
    expect(result.status).toBe(502);
    expect(warnings.join("\n")).not.toContain("TOKEN");
  });
});
