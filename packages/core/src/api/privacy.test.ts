import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { requestPrivacyExport, withdrawPrivacyDataRequest } from "./privacy";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("privacy API client", () => {
  it("sends an idempotency key for a withdrawal without exposing a bearer token", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ id: "request-1" } as never);
    await withdrawPrivacyDataRequest("request/unsafe", 3);
    expect(post).toHaveBeenCalledWith(
      "/api/privacy/data-requests/request%2Funsafe/withdraw",
      { version: 3 },
      { headers: { "Idempotency-Key": expect.stringMatching(/^privacy-/) } },
    );
    expect(JSON.stringify(post.mock.calls[0])).not.toMatch(/token|secret|password/i);
  });

  it("posts the export with cookies and returns the raw response for streaming", async () => {
    const response = new Response("zip", { status: 200 });
    const fetch = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetch);
    expect(await requestPrivacyExport("access")).toBe(response);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/privacy\/export$/);
    expect(init).toMatchObject({ method: "POST", credentials: "include", cache: "no-store" });
    expect(JSON.parse(String(init.body))).toMatchObject({ kind: "access" });
  });
});
