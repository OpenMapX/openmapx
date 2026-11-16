import { Readable } from "node:stream";
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { COMPRESSIBLE_RESPONSE_TYPE, registerResponseCompression } from "../response-compression";

const big = {
  items: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `place-${i}`, kind: "poi" })),
};
const huge = {
  items: Array.from({ length: 7_500 }, (_, i) => ({
    id: i,
    name: `place-${i}`,
    kind: "poi",
    description: `A fairly descriptive text for entry number ${i}.`,
  })),
};
const small = { ok: true };
const bigText = "lorem ipsum dolor sit amet ".repeat(400);
const bigBuffer = Buffer.from(bigText);

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function makeApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await registerResponseCompression(instance);
  app = instance;
  return instance;
}

function contentEncoding(res: { headers: Record<string, unknown> }) {
  return res.headers["content-encoding"];
}

describe("registerResponseCompression", () => {
  it("gzips large JSON when gzip is accepted and varies on accept-encoding", async () => {
    const server = await makeApp();
    server.get("/big", async () => big);
    const res = await server.inject({
      method: "GET",
      url: "/big",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.statusCode).toBe(200);
    expect(contentEncoding(res)).toBe("gzip");
    expect(JSON.parse(gunzipSync(res.rawPayload).toString())).toEqual(big);
    expect(String(res.headers.vary).toLowerCase()).toContain("accept-encoding");
  });

  it("prefers brotli when the client offers it", async () => {
    const server = await makeApp();
    server.get("/big", async () => big);
    const res = await server.inject({
      method: "GET",
      url: "/big",
      headers: { "accept-encoding": "gzip, deflate, br" },
    });
    expect(contentEncoding(res)).toBe("br");
    expect(JSON.parse(brotliDecompressSync(res.rawPayload).toString())).toEqual(big);
  });

  it("compresses a very large JSON payload through the streamed path", async () => {
    const server = await makeApp();
    server.get("/huge", async () => huge);
    const res = await server.inject({
      method: "GET",
      url: "/huge",
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(contentEncoding(res)).toBe("br");
    expect(JSON.parse(brotliDecompressSync(res.rawPayload).toString())).toEqual(huge);
  });

  it("sends identity when no accept-encoding is present", async () => {
    const server = await makeApp();
    server.get("/big", async () => big);
    const res = await server.inject({ method: "GET", url: "/big" });
    expect(contentEncoding(res)).toBeUndefined();
    expect(JSON.parse(res.rawPayload.toString())).toEqual(big);
  });

  it("leaves payloads under the threshold uncompressed", async () => {
    const server = await makeApp();
    server.get("/small", async () => small);
    const res = await server.inject({
      method: "GET",
      url: "/small",
      headers: { "accept-encoding": "gzip" },
    });
    expect(contentEncoding(res)).toBeUndefined();
    expect(JSON.parse(res.rawPayload.toString())).toEqual(small);
  });

  it("compresses the application/*+json family", async () => {
    const server = await makeApp();
    const body = JSON.stringify(big);
    for (const type of [
      "application/geo+json",
      "application/problem+json",
      "application/vnd.test+json",
    ]) {
      server.get(`/typed/${type.split("/")[1]}`, async (_request, reply) =>
        reply.type(type).send(body),
      );
    }
    for (const type of [
      "application/geo+json",
      "application/problem+json",
      "application/vnd.test+json",
    ]) {
      const res = await server.inject({
        method: "GET",
        url: `/typed/${type.split("/")[1]}`,
        headers: { "accept-encoding": "gzip" },
      });
      expect(contentEncoding(res), type).toBe("gzip");
      expect(gunzipSync(res.rawPayload).toString(), type).toBe(body);
    }
  });

  it("never compresses non-JSON responses, untyped Buffers or untyped streams", async () => {
    const server = await makeApp();
    server.get("/png", async (_request, reply) => reply.type("image/png").send(bigBuffer));
    server.get("/untyped-buffer", async (_request, reply) => reply.send(bigBuffer));
    server.get("/zip-stream", async (_request, reply) =>
      reply.type("application/zip").send(Readable.from([bigBuffer])),
    );
    server.get("/untyped-stream", async (_request, reply) =>
      reply.send(Readable.from([bigBuffer])),
    );
    server.get("/text", async (_request, reply) => reply.type("text/plain").send(bigText));
    server.get("/csv", async (_request, reply) => reply.type("text/csv").send(bigText));
    server.get("/sse-typed", async (_request, reply) =>
      reply.type("text/event-stream").send(bigText),
    );

    for (const url of [
      "/png",
      "/untyped-buffer",
      "/zip-stream",
      "/untyped-stream",
      "/text",
      "/csv",
      "/sse-typed",
    ]) {
      const res = await server.inject({
        method: "GET",
        url,
        headers: { "accept-encoding": "gzip, br" },
      });
      // Soft assertions so a regression reports every affected type, not just the first.
      expect.soft(res.statusCode, url).toBe(200);
      expect.soft(contentEncoding(res), url).toBeUndefined();
      expect.soft(res.rawPayload.equals(bigBuffer), url).toBe(true);
    }
  });

  it("leaves hijacked SSE replies untouched", async () => {
    const server = await makeApp();
    const frames = Array.from({ length: 100 }, (_, i) => `data: {"tick":${i}}\n\n`).join("");
    server.get("/events", (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.write(frames);
      reply.raw.end();
    });
    const res = await server.inject({
      method: "GET",
      url: "/events",
      headers: { "accept-encoding": "gzip" },
    });
    expect(frames.length).toBeGreaterThan(1500);
    expect(contentEncoding(res)).toBeUndefined();
    expect(res.payload).toBe(frames);
  });

  it("does not double-encode a response that is already compressed", async () => {
    const server = await makeApp();
    const encoded = gzipSync(JSON.stringify(big));
    server.get("/pre-encoded", async (_request, reply) =>
      reply.header("content-encoding", "gzip").type("application/json").send(encoded),
    );
    const res = await server.inject({
      method: "GET",
      url: "/pre-encoded",
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(contentEncoding(res)).toBe("gzip");
    expect(res.rawPayload.equals(encoded)).toBe(true);
  });

  it("keeps the ETag and answers revalidation with an uncompressed 304", async () => {
    const server = await makeApp();
    const etag = '"rev1"';
    server.get("/etag", async (request, reply) => {
      reply.header("Cache-Control", "private, no-cache").header("ETag", etag);
      const raw = request.headers["if-none-match"];
      const validators = typeof raw === "string" ? raw.split(",") : (raw ?? []);
      if (
        validators.some((validator) => {
          const candidate = validator.trim();
          return candidate === "*" || candidate.replace(/^W\//, "") === etag;
        })
      )
        return reply.status(304).send();
      return big;
    });

    const fresh = await server.inject({
      method: "GET",
      url: "/etag",
      headers: { "accept-encoding": "gzip" },
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.headers.etag).toBe(etag);
    expect(contentEncoding(fresh)).toBe("gzip");

    const notModified = await server.inject({
      method: "GET",
      url: "/etag",
      headers: { "accept-encoding": "gzip", "if-none-match": etag },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.rawPayload.length).toBe(0);
    expect(contentEncoding(notModified)).toBeUndefined();

    const weak = await server.inject({
      method: "GET",
      url: "/etag",
      headers: { "accept-encoding": "gzip", "if-none-match": `W/${etag}` },
    });
    expect(weak.statusCode).toBe(304);
  });

  it("never compresses HEAD responses", async () => {
    const server = await makeApp();
    server.get("/big", async () => big);
    // Fastify's auto-exposed HEAD route empties the payload before the plugin
    // sees it; an explicitly declared HEAD route does not, so only the veto
    // keeps that one uncompressed.
    server.route({ method: ["GET", "HEAD"], url: "/explicit-head", handler: async () => big });
    for (const url of ["/big", "/explicit-head"]) {
      const res = await server.inject({
        method: "HEAD",
        url,
        headers: { "accept-encoding": "gzip" },
      });
      expect.soft(res.statusCode, url).toBe(200);
      expect.soft(contentEncoding(res), url).toBeUndefined();
    }
    // inject() returns an explicit HEAD handler's body (node:http drops it on
    // the wire), so the empty-payload check only applies to the exposed route.
    const exposed = await server.inject({
      method: "HEAD",
      url: "/big",
      headers: { "accept-encoding": "gzip" },
    });
    expect(exposed.rawPayload.length).toBe(0);
  });

  it("does not enable request decompression", async () => {
    const withHelper = await makeApp();
    const without = Fastify();
    const echo = async (request: { body: unknown }) => ({ body: request.body });
    withHelper.post("/echo", echo);
    without.post("/echo", echo);
    const request = {
      method: "POST" as const,
      url: "/echo",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      payload: gzipSync(JSON.stringify(big)),
    };
    try {
      const a = await withHelper.inject(request);
      const b = await without.inject(request);
      expect(a.statusCode).toBe(b.statusCode);
      // Neither inflates the gzipped body into the parsed JSON.
      expect(a.statusCode).not.toBe(200);
      expect(b.statusCode).not.toBe(200);
    } finally {
      await without.close();
    }
  });

  it("covers routes registered in encapsulated child contexts", async () => {
    const server = await makeApp();
    await server.register(
      async (child) => {
        child.get("/child", async () => big);
      },
      { prefix: "/api" },
    );
    const res = await server.inject({
      method: "GET",
      url: "/api/child",
      headers: { "accept-encoding": "gzip" },
    });
    expect(contentEncoding(res)).toBe("gzip");
    expect(JSON.parse(gunzipSync(res.rawPayload).toString())).toEqual(big);
  });

  it("matches only the JSON media-type family", () => {
    for (const type of [
      "application/json",
      "application/json; charset=utf-8",
      "application/geo+json",
      "APPLICATION/JSON",
    ]) {
      expect(COMPRESSIBLE_RESPONSE_TYPE.test(type), type).toBe(true);
    }
    for (const type of [
      "application/jsonx",
      "text/json",
      "application/xml",
      "application/octet-stream",
      "text/event-stream",
    ]) {
      expect(COMPRESSIBLE_RESPONSE_TYPE.test(type), type).toBe(false);
    }
  });
});
