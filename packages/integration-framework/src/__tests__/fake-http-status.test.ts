import { FetchJsonHttpError } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { fakeHttpClient, httpStatus } from "../testing";

const responseOptions = { maxBytes: 1_024, contentTypes: ["application/json"] } as const;

describe("fakeHttpClient httpStatus", () => {
  it("makes get and post reject with the host's structured status error", async () => {
    const http = fakeHttpClient({
      "/quota": httpStatus(429, { "Retry-After": "30" }),
      "/down": httpStatus(503),
    });

    const quota = await http.get("https://x.test/quota").catch((error: unknown) => error);
    expect(quota).toBeInstanceOf(FetchJsonHttpError);
    expect(quota).toMatchObject({ status: 429, retryAfterMs: 30_000 });
    await expect(http.post("https://x.test/down", {})).rejects.toMatchObject({ status: 503 });
  });

  it("returns the status with an empty body from the response methods", async () => {
    const http = fakeHttpClient(() => httpStatus(404, { ETag: '"a"' }));

    await expect(http.getResponse("https://x.test/a", responseOptions)).resolves.toEqual({
      status: 404,
      headers: { etag: '"a"' },
      body: "",
    });
    await expect(http.getText("https://x.test/a", responseOptions)).resolves.toMatchObject({
      status: 404,
    });
    const bytes = await http.getBytes("https://x.test/a", responseOptions);
    expect(bytes).toMatchObject({ status: 404 });
    expect(bytes.bytes.byteLength).toBe(0);
    const stream = await http.getStream("https://x.test/a", responseOptions);
    expect(stream.status).toBe(404);
    expect(await new Response(stream.stream).arrayBuffer()).toHaveProperty("byteLength", 0);
  });
});
