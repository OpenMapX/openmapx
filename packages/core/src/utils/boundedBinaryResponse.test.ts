import { describe, expect, it } from "vitest";
import { createBoundedBinaryProxyStream, readBoundedBinaryResponse } from "./boundedBinaryResponse";

function response(body: string, headers: Record<string, string> = {}) {
  return new Response(body, { headers: { "Content-Type": "image/png", ...headers } });
}

describe("bounded binary responses", () => {
  it("rejects an oversized declared length before exposing a stream", () => {
    expect(() =>
      createBoundedBinaryProxyStream(response("x", { "Content-Length": "100" }), {
        maxBytes: 10,
        allowedContentTypes: ["image/png"],
      }),
    ).toThrow(/too large/i);
  });

  it("streams an allowed body without buffering it in the helper", async () => {
    const { body, contentType } = createBoundedBinaryProxyStream(response("tile"), {
      maxBytes: 10,
      allowedContentTypes: ["image/png"],
    });
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("tile");
    expect(contentType).toBe("image/png");
  });

  it("destroys the stream when actual bytes exceed the ceiling", async () => {
    const { body } = createBoundedBinaryProxyStream(response("x".repeat(100)), {
      maxBytes: 10,
      allowedContentTypes: ["image/png"],
    });
    await expect(
      (async () => {
        for await (const _chunk of body) {
          // consume to trigger the streaming ceiling
        }
      })(),
    ).rejects.toThrow(/too large/i);
  });

  it("cancels the upstream body when the streaming ceiling is exceeded", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(20));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { body } = createBoundedBinaryProxyStream(
      new Response(upstream, { headers: { "Content-Type": "image/png" } }),
      { maxBytes: 10, allowedContentTypes: ["image/png"] },
    );
    await expect(
      (async () => {
        for await (const _chunk of body) {
          // consume to trigger the streaming ceiling
        }
      })(),
    ).rejects.toThrow(/too large/i);
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelled).toBe(true);
  });

  it("cancels the upstream body when the downstream consumer disconnects", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { body } = createBoundedBinaryProxyStream(
      new Response(upstream, { headers: { "Content-Type": "image/png" } }),
      { maxBytes: 1_024, allowedContentTypes: ["image/png"] },
    );

    await new Promise<void>((resolve) => {
      body.once("data", () => body.destroy());
      body.once("close", resolve);
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(cancelled).toBe(true);
  });

  it("rejects MIME confusion and supports bounded buffering for cache/import consumers", async () => {
    expect(() =>
      createBoundedBinaryProxyStream(
        new Response("html", { headers: { "Content-Type": "text/html" } }),
        {
          maxBytes: 10,
          allowedContentTypes: ["image/png"],
        },
      ),
    ).toThrow(/content type/i);
    await expect(
      readBoundedBinaryResponse(response("cached"), {
        maxBytes: 10,
        allowedContentTypes: ["image/png"],
      }),
    ).resolves.toMatchObject({ data: Buffer.from("cached"), contentType: "image/png" });
  });
});
