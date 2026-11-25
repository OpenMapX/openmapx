import { MOBILE_PROTOCOL_MAX } from "@openmapx/core/navigation";
import {
  ApiClientError,
  ApiRequestAbortedError,
  fetchDirections,
} from "@openmapx/core/navigation/api";
import { createNativeApiClient, isUpdateRequired } from "./nativeApiClient";

describe("createNativeApiClient", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("calls the compiled origin without cookies and names the mobile protocol", async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ routes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchDirections(
      {
        waypoints: [
          [13.4, 52.5],
          [13.38, 52.51],
        ],
      },
      createNativeApiClient("https://openmapx.com"),
    );

    const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0] ?? [];
    expect(new URL(url ?? "").origin).toBe("https://openmapx.com");
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).get("X-OpenMapX-Mobile-Protocol")).toBe(
      String(MOBILE_PROTOCOL_MAX),
    );
  });
});

describe("isUpdateRequired", () => {
  it("recognises the API's refusal of an unsupported protocol", () => {
    expect(
      isUpdateRequired(new ApiClientError(426, { code: "MOBILE_PROTOCOL_UNSUPPORTED" }, null)),
    ).toBe(true);
  });

  it.each([
    new ApiClientError(400, null, null),
    new ApiClientError(503, null, 30),
    new ApiRequestAbortedError("timeout"),
    new TypeError("Network request failed"),
    null,
  ])("leaves other failures to their own handling (%p)", (error) => {
    expect(isUpdateRequired(error)).toBe(false);
  });
});
