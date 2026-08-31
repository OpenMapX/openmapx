import { afterEach, describe, expect, it, vi } from "vitest";
import { createMotisInstance } from "../src/server/motis-client.js";

function jsonResponse(value: unknown): Response {
  return Response.json(value);
}

describe("createMotisInstance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs independent clients with their own endpoint and identity", async () => {
    const local = createMotisInstance({
      baseUrl: "https://local.example",
      prefix: "ms:",
      provider: "ms",
    });
    const hosted = createMotisInstance({
      baseUrl: "https://hosted.example",
      prefix: "mo:",
      provider: "mo",
      userAgent: "OpenMapX Test",
    });
    const urls: string[] = [];
    const capture = (input: Request): Promise<Response> => {
      urls.push(input.url);
      return Promise.resolve(jsonResponse({}));
    };

    const localRequest = local.client.get({
      url: "/api/v1/status",
      fetch: capture as typeof fetch,
    });
    await Promise.all([localRequest]);
    const hostedRequest = hosted.client.get({
      url: "/api/v1/status",
      fetch: capture as typeof fetch,
    });
    await Promise.all([hostedRequest]);

    expect(local.client).not.toBe(hosted.client);
    expect(local).toMatchObject({ prefix: "ms:", provider: "ms" });
    expect(hosted).toMatchObject({ prefix: "mo:", provider: "mo" });
    expect(urls).toEqual([
      "https://local.example/api/v1/status",
      "https://hosted.example/api/v1/status",
    ]);
  });

  it("serializes array query parameters as one comma-joined value", async () => {
    const instance = createMotisInstance({
      baseUrl: "https://motis.example",
      prefix: "ms:",
      provider: "ms",
    });
    let capturedUrl = "";

    const request = instance.client.get({
      url: "/api/v1/plan",
      query: { transitModes: ["REGIONAL_RAIL", "TRAM", "BUS"] },
      fetch: ((input: Request) => {
        capturedUrl = input.url;
        return Promise.resolve(jsonResponse({ itineraries: [] }));
      }) as typeof fetch,
    });
    await Promise.all([request]);

    expect(capturedUrl).toContain("transitModes=REGIONAL_RAIL,TRAM,BUS");
    expect(capturedUrl.match(/transitModes=/g)).toHaveLength(1);
  });

  it("composes caller cancellation with the request timeout", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const caller = new AbortController();
    const instance = createMotisInstance({
      baseUrl: "https://motis.example",
      prefix: "ms:",
      provider: "ms",
      timeoutMs: 50,
    });
    let requestSignal: AbortSignal | undefined;

    const request = instance.client.get({
      url: "/api/v1/status",
      signal: caller.signal,
      fetch: ((input: Request) => {
        requestSignal = input.signal;
        caller.abort();
        return Promise.resolve(jsonResponse({}));
      }) as typeof fetch,
    });
    await Promise.all([request]);

    expect(AbortSignal.timeout).toHaveBeenCalledWith(50);
    expect(requestSignal).not.toBe(caller.signal);
    expect(requestSignal?.aborted).toBe(true);
  });
});
