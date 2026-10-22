import { fakeHttpClient } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { createOtpClient } from "./index";

function fixture() {
  const http = fakeHttpClient(() => ({ data: { __typename: "QueryType" } }));
  const controller = new AbortController();
  const headers = { "subscription-key": "original" };
  const beforeRequest = vi.fn(async () => {});
  const afterResponse = vi.fn(async () => {});
  const options = {
    http,
    signal: controller.signal,
    endpoint: "https://fixture.test",
    isSourceAllowed: async () => true,
    headers,
    beforeRequest,
    afterResponse,
  };
  return { http, controller, headers, beforeRequest, afterResponse, options };
}
describe("bounded optional OTP transport hooks", () => {
  it("captures headers and runs admission and observation around exactly one host request", async () => {
    const f = fixture();
    const c = createOtpClient(f.options);
    f.headers["subscription-key"] = "changed";
    await c.sdk.OtpReadiness();
    expect(f.beforeRequest).toHaveBeenCalledTimes(1);
    expect(f.afterResponse).toHaveBeenCalledTimes(1);
    expect(f.http.calls[0].options?.headers).toMatchObject({ "subscription-key": "original" });
  });
  it("fails before network when admission rejects and sanitizes store errors", async () => {
    const f = fixture();
    f.beforeRequest.mockRejectedValue(new Error("private"));
    await expect(createOtpClient(f.options).sdk.OtpReadiness()).rejects.toThrow(
      "OTP upstream unavailable",
    );
    expect(f.http.calls).toHaveLength(0);
  });
  it("settles cancellation during uncooperative admission without later network", async () => {
    const f = fixture();
    let finish!: () => void;
    f.beforeRequest.mockImplementation(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    const pending = createOtpClient(f.options).sdk.OtpReadiness();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    f.controller.abort();
    await expect(pending).rejects.toThrow("OTP request cancelled");
    finish();
    await new Promise((r) => setImmediate(r));
    expect(f.http.calls).toHaveLength(0);
  });
  it("observes 429 before status rejection and propagates observation-store failure safely", async () => {
    const f = fixture();
    vi.spyOn(f.http, "postResponse").mockResolvedValue({
      status: 429,
      headers: { "retry-after": "10" },
      body: {},
    });
    f.afterResponse.mockRejectedValue(new Error("private"));
    await expect(createOtpClient(f.options).sdk.OtpReadiness()).rejects.toThrow(
      "OTP upstream unavailable",
    );
    expect(f.afterResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429 }),
      expect.any(AbortSignal),
    );
  });
});
