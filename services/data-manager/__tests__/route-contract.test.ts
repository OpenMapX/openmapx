import swagger from "@fastify/swagger";
import { createDataManagerTransport, link as linkDatasets } from "@openmapx/core/data-manager-sdk";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerAuth } from "../src/auth";
import {
  registerDataManagerRoute,
  validateDataManagerResponseHeaders,
} from "../src/route-contract";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const app = () => {
  const instance = Fastify({ exposeHeadRoutes: false });
  apps.push(instance);
  return instance;
};
describe("data-manager producer contract metadata", () => {
  it("preserves native413and415 error envelopes through the real generated link operation", async () => {
    const instance = Fastify({ bodyLimit: 128, exposeHeadRoutes: false });
    const baseline = Fastify({ bodyLimit: 128, exposeHeadRoutes: false });
    apps.push(instance, baseline);
    registerAuth(instance, "secret");
    let calls = 0;
    registerDataManagerRoute(instance, "link", () => {
      calls++;
      return { ok: true, linked: 0, skipped: 0, pruned: 0 };
    });
    baseline.post("/link", async () => ({ ok: true }));
    const transport = createDataManagerTransport({
      baseUrl: "https://data-manager.test",
      authToken: "secret",
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        const response = await instance.inject({
          method: "POST",
          url: url.pathname,
          headers: Object.fromEntries(new Headers(init?.headers)),
          payload: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: Object.fromEntries(
            Object.entries(response.headers)
              .filter(([, value]) => value !== undefined)
              .map(([name, value]) => [
                name,
                Array.isArray(value) ? value.join(", ") : String(value),
              ]),
          ),
        });
      },
    });
    const oversizedBody = {
      plan: [
        { source: "x".repeat(100), target: "target", consumerService: "consumer", dataType: "osm" },
      ],
    };
    const media = await baseline.inject({
      method: "POST",
      url: "/link",
      headers: { "content-type": "application/xml" },
      payload: "<request/>",
    });
    const oversized = await baseline.inject({
      method: "POST",
      url: "/link",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(oversizedBody),
    });
    expect(media.statusCode).toBe(415);
    expect(oversized.statusCode).toBe(413);
    await expect(
      linkDatasets({ plan: [] }, { transport, headers: { "Content-Type": "application/xml" } }),
    ).resolves.toMatchObject({ status: 415, data: media.json() });
    await expect(linkDatasets(oversizedBody, { transport })).resolves.toMatchObject({
      status: 413,
      data: oversized.json(),
    });
    expect(calls).toBe(0);
  });
  it("rejects missing mandatory response metadata and retains extra valid headers", async () => {
    const invalid = app();
    registerDataManagerRoute(invalid, "getOfflineGlyph", (_request, reply) =>
      reply.type("application/x-protobuf").send(Buffer.from("pbf")),
    );
    expect((await invalid.inject("/offline/packages/glyphs/v1/Noto/0-255.pbf")).statusCode).toBe(
      500,
    );
    const valid = app();
    registerDataManagerRoute(valid, "getOfflineGlyph", (_request, reply) =>
      reply
        .headers({
          "content-type": "application/x-protobuf",
          "content-length": "3",
          "cache-control": "public, max-age=31536000, immutable",
          "x-extra": "retained",
        })
        .send(Buffer.from("pbf")),
    );
    const response = await valid.inject("/offline/packages/glyphs/v1/Noto/0-255.pbf");
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-extra"]).toBe("retained");
    expect(response.body).toBe("pbf");
  });
  it("keeps all explicit HEAD statuses bodyless including request and framework errors", async () => {
    for (const status of [200, 404, 500]) {
      const instance = app();
      registerDataManagerRoute(instance, "headOfflinePackageArchive", (_request, reply) => {
        if (status === 200)
          return reply
            .headers({
              "content-type": "application/vnd.pmtiles",
              "content-length": "100",
              "cache-control": "public, max-age=31536000, immutable",
              etag: `sha256-${"a".repeat(64)}`,
              "accept-ranges": "bytes",
            })
            .send();
        if (status === 500) throw new Error("failed");
        return reply.code(404).send({ error: "not found" });
      });
      const response = await instance.inject({
        method: "HEAD",
        url: `/offline/packages/omp2-${"a".repeat(64)}/archive`,
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).toBe("");
    }
  });
  it("describes explicit HEAD responses as bodyless in actual OpenAPI3.1", async () => {
    const instance = app();
    await instance.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: { title: "HEAD", version: "1" },
        components: {
          securitySchemes: {
            serviceBearer: { type: "http", scheme: "bearer" },
            serviceToken: { type: "apiKey", in: "header", name: "x-data-manager-token" },
          },
        },
      },
      exposeHeadRoutes: true,
    });
    registerDataManagerRoute(instance, "headOfflinePackageArchive", (_request, reply) =>
      reply.code(404).send(),
    );
    await instance.ready();
    const document = instance.swagger();
    const responses = document.paths?.["/offline/packages/{packageId}/archive"]?.head?.responses;
    expect(responses).toBeDefined();
    for (const response of Object.values(responses ?? {}))
      expect(response).not.toHaveProperty("content");
  });
  it("keeps HEAD auth and request-validation failures bodyless", async () => {
    const instance = app();
    registerAuth(instance, "secret");
    registerDataManagerRoute(instance, "headOfflinePackageArchive", () => {
      throw new Error("handler must not run");
    });
    const unauthorized = await instance.inject({
      method: "HEAD",
      url: "/offline/packages/bad/archive",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.body).toBe("");
    const invalid = await instance.inject({
      method: "HEAD",
      url: "/offline/packages/bad/archive",
      headers: { authorization: "Bearer secret" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toBe("");
  });
  it("validates hijacked stream metadata before ownership leaves Fastify", () => {
    expect(() =>
      validateDataManagerResponseHeaders("downloadOsm", 200, {
        "content-type": "application/x-ndjson",
      }),
    ).toThrow(/response/);
    expect(() =>
      validateDataManagerResponseHeaders("downloadOsm", 200, {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        extra: "retained",
      }),
    ).not.toThrow();
  });
  it("exports globally resolvable reusable JSON schema refs and response headers to Swagger", async () => {
    const instance = app();
    await instance.register(swagger, {
      openapi: {
        info: { title: "Test", version: "1" },
        components: {
          securitySchemes: {
            serviceBearer: { type: "http", scheme: "bearer" },
            serviceToken: { type: "apiKey", in: "header", name: "x-data-manager-token" },
          },
        },
      },
      refResolver: { buildLocalReference: (json) => String(json.$id) },
    });
    registerDataManagerRoute(instance, "getCoverageEvidence", (_request, reply) =>
      reply
        .code(503)
        .headers({ "cache-control": "private, no-store", pragma: "no-cache" })
        .send({ error: "unavailable" }),
    );
    registerDataManagerRoute(instance, "getTransitSources", () => ({
      sources: [],
      total: 0,
      limit: 100,
      offset: 0,
    }));
    await instance.ready();
    const document = instance.swagger();
    const response = document.paths?.["/coverage/evidence"]?.get?.responses?.["200"];
    expect(response).toHaveProperty("headers.cache-control.schema.const", "private, no-store");
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('"$ref":"#/definitions/');
    expect(serialized).not.toContain('"$ref":"#/$defs/');
    const refs = [...serialized.matchAll(/"\$ref":"([^"#]*#[^"]*)"/g)].map((match) => match[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/^#\/components\/schemas\//);
      const name = ref?.split("/").at(-1);
      expect("components" in document ? document.components?.schemas : undefined).toHaveProperty(
        name ?? "missing",
      );
    }
  });
});
