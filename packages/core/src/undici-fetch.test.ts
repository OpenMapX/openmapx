import {
  FormData as StandaloneFormData,
  Headers as StandaloneHeaders,
  Request as StandaloneRequest,
  Response as StandaloneResponse,
  fetch as standaloneFetch,
} from "undici";
import { afterAll, describe, expect, it, vi } from "vitest";

const originalFetchGlobals = {
  fetch: globalThis.fetch,
  FormData: globalThis.FormData,
  Headers: globalThis.Headers,
  Request: globalThis.Request,
  Response: globalThis.Response,
};

afterAll(() => {
  Object.assign(globalThis, originalFetchGlobals);
});

describe("standalone Undici fetch runtime", () => {
  it("installs one coherent Fetch API implementation", async () => {
    vi.resetModules();
    await import("./undici-fetch");

    expect(globalThis.fetch).toBe(standaloneFetch);
    expect(globalThis.FormData).toBe(StandaloneFormData);
    expect(globalThis.Headers).toBe(StandaloneHeaders);
    expect(globalThis.Request).toBe(StandaloneRequest);
    expect(globalThis.Response).toBe(StandaloneResponse);

    const response = await globalThis.fetch(
      new globalThis.Request("data:application/json,%7B%22ok%22%3Atrue%7D"),
    );
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
