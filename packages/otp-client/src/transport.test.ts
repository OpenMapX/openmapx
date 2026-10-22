import type { HttpResponse } from "@openmapx/integration-framework";
import { fakeHttpClient } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOtpClient } from "./index";

function fixture(body: unknown = { data: { __typename: "QueryType" } }) {
  const generation = new AbortController();
  let allowed = true;
  const http = fakeHttpClient(() => body);
  const policy = vi.fn(async () => allowed);
  return {
    http,
    generation,
    policy,
    deny: () => {
      allowed = false;
    },
    client: createOtpClient({
      http,
      endpoint: "http://otp.fixture:8080/",
      signal: generation.signal,
      isSourceAllowed: policy,
    }),
  };
}
afterEach(() => vi.useRealTimers());
describe("OTP generated SDK host transport", () => {
  it("uses the host bounded JSON POST and generated result validator, without a REST preflight", async () => {
    const f = fixture();
    expect(await f.client.sdk.OtpReadiness()).toEqual({ __typename: "QueryType" });
    expect(f.http.calls).toHaveLength(1);
    expect(f.http.calls[0]).toMatchObject({
      method: "postResponse",
      url: "http://otp.fixture:8080/otp/gtfs/v1",
      options: {
        timeoutMs: 10000,
        maxBytes: 4 * 1024 * 1024,
        redirect: "error",
        contentTypes: ["application/json", "application/graphql-response+json"],
      },
    });
    expect(f.http.calls[0].body).toMatchObject({
      query: expect.stringContaining("query OtpReadiness"),
    });
  });
  it.each([
    { data: { __typename: "Wrong" } },
    { data: null },
    {},
    { data: { __typename: "QueryType" }, errors: [{ message: "private provider details" }] },
    { data: { __typename: "QueryType" }, errors: [] },
  ])("rejects malformed or errored envelopes without reflecting details: %j", async (body) => {
    const f = fixture(body);
    await expect(f.client.sdk.OtpReadiness()).rejects.toThrow(/^OTP /);
  });
  it("rejects status errors and sanitizes thrown transport errors", async () => {
    const f = fixture();
    vi.spyOn(f.http, "postResponse").mockResolvedValue({
      status: 401,
      headers: {},
      body: { secret: "private" },
    });
    await expect(f.client.sdk.OtpReadiness()).rejects.toThrow("OTP HTTP request failed");
    vi.spyOn(f.http, "postResponse").mockRejectedValue(new Error("secret"));
    await expect(f.client.sdk.OtpReadiness()).rejects.toThrow("OTP upstream unavailable");
  });
  it("checks policy before network and rejects a policy change before publication", async () => {
    const f = fixture();
    f.deny();
    await expect(f.client.sdk.OtpReadiness()).rejects.toThrow("OTP source denied");
    expect(f.http.calls).toHaveLength(0);
    const g = fixture();
    vi.spyOn(g.http, "postResponse").mockImplementation(async () => {
      g.deny();
      return { status: 200, headers: {}, body: { data: { __typename: "QueryType" } } };
    });
    await expect(g.client.sdk.OtpReadiness()).rejects.toThrow("OTP source denied");
  });
  it("settles on shutdown even if HTTP ignores cancellation; late success cannot publish", async () => {
    const f = fixture();
    let finish!: (value: HttpResponse<unknown>) => void;
    vi.spyOn(f.http, "postResponse").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.client.sdk.OtpReadiness();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    f.generation.abort();
    await expect(pending).rejects.toThrow("OTP request cancelled");
    finish({ status: 200, headers: {}, body: { data: { __typename: "QueryType" } } });
  });
  it("bounds a policy promise that never settles", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.policy.mockImplementation(() => new Promise(() => {}));
    const assertion = expect(f.client.sdk.OtpReadiness()).rejects.toThrow("OTP request timed out");
    await vi.advanceTimersByTimeAsync(10001);
    await assertion;
    expect(f.http.calls).toHaveLength(0);
  });
  it.each([
    "file:///etc",
    "https://user:password@example.com",
    "https://example.com/?token=secret",
    "https://example.com/#frag",
  ])("rejects unsafe configuration: %s", (endpoint) => {
    expect(() =>
      createOtpClient({
        http: fakeHttpClient(),
        endpoint,
        signal: new AbortController().signal,
        isSourceAllowed: async () => true,
      }),
    ).toThrow("OTP invalid configuration");
  });
});
