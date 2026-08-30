import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeHttpClient } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { createOpenAQClient, OpenAQClientError } from "./openaq-client.js";
import { MemoryUpstreamRuntime } from "./test-helpers.js";

const fixtureDir = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(`${fixtureDir}${name}`, "utf8"));
const signal = new AbortController().signal;

function client(responder: Parameters<typeof fakeHttpClient>[0]) {
  const http = fakeHttpClient(responder);
  const runtime = new MemoryUpstreamRuntime();
  return {
    client: createOpenAQClient({ http, upstreamRuntime: runtime, apiKey: "redacted" }),
    http,
    runtime,
  };
}

describe("OpenAQ v3 client", () => {
  it("builds fixed-origin location queries and paginates within a hard cap", async () => {
    const { client: openaq, http } = client((request) =>
      request.url.includes("page=1")
        ? fixture("locations-page-1.json")
        : fixture("locations-page-2.json"),
    );

    const result = await openaq.listLocations(
      { bbox: [-107, 35, -106, 36], pollutants: ["pm25"], maxPages: 2, pageSize: 2 },
      signal,
    );

    expect(result.items.map((item) => item.id)).toEqual([2178, 3001, 3002]);
    expect(result.truncated).toBe(false);
    expect(http.calls).toHaveLength(2);
    const url = new URL(http.calls[0].url);
    expect(url.origin).toBe("https://api.openaq.org");
    expect(url.pathname).toBe("/v3/locations");
    expect(url.searchParams.get("bbox")).toBe("-107,35,-106,36");
    expect(url.searchParams.get("parameters_id")).toBe("2");
    expect(url.searchParams.get("monitor")).toBe("true");
    expect(url.searchParams.get("mobile")).toBe("false");
  });

  it("marks a full final page as truncated instead of silently assuming completion", async () => {
    const { client: openaq } = client(() => fixture("locations-page-1.json"));
    const result = await openaq.listLocations(
      { bbox: [-107, 35, -106, 36], pollutants: ["pm25"], maxPages: 1, pageSize: 2 },
      signal,
    );
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("sorts latest discovery per sensor without trusting response order", async () => {
    const { client: openaq } = client(() => fixture("latest.json"));
    const latest = await openaq.getLatest(2178, signal);
    expect(latest.items.map((item) => item.sensorsId)).toEqual([3919, 3920]);
    expect(latest.items.find((item) => item.sensorsId === 3920)?.value).toBe(9.75);
  });

  it("sorts and validates hourly intervals and flags invalid samples", async () => {
    const { client: openaq } = client(() => fixture("sensor-hours.json"));
    const hours = await openaq.getSensorHours(
      3920,
      { from: "2026-08-30T08:00:00Z", to: "2026-08-30T11:00:00Z", maxSamples: 24 },
      signal,
    );
    expect(hours.items.map((item) => item.period?.datetimeTo?.utc)).toEqual([
      "2026-08-30T09:00:00Z",
      "2026-08-30T10:00:00Z",
      "2026-08-30T11:00:00Z",
    ]);
    expect(hours.items[0].flagInfo.hasFlags).toBe(true);
  });

  it("retains license permissions and the official terms URL", async () => {
    const { client: openaq } = client(() => fixture("license.json"));
    const licenses = await openaq.listLicenses(signal);
    expect(licenses.items[0]).toMatchObject({
      id: 41,
      commercialUseAllowed: true,
      attributionRequired: true,
      sourceUrl: "https://creativecommons.org/licenses/by/4.0/",
    });
  });

  it("normalizes safe-reader failures for non-JSON and oversized bodies", async () => {
    for (const message of ["unexpected content type", "exceeds 2097152 bytes"]) {
      const http = fakeHttpClient(() => {
        throw new Error(message);
      });
      const openaq = createOpenAQClient({
        http,
        upstreamRuntime: new MemoryUpstreamRuntime(),
        apiKey: "redacted",
      });
      await expect(
        openaq.listLocations({ bbox: [-1, -1, 1, 1], pollutants: ["pm25"] }, signal),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("distinguishes transport failures from invalid response bodies", async () => {
    const http = fakeHttpClient(() => {
      throw new Error("fetch failed");
    });
    const openaq = createOpenAQClient({
      http,
      upstreamRuntime: new MemoryUpstreamRuntime(),
      apiKey: "redacted",
    });
    await expect(
      openaq.listLocations({ bbox: [-1, -1, 1, 1], pollutants: ["pm25"] }, signal),
    ).rejects.toMatchObject({ code: "upstream_failure" });
  });

  it("rejects spatial queries outside WGS84 bounds before dispatch", async () => {
    const { client: openaq, http } = client(() => fixture("locations-page-2.json"));
    await expect(
      openaq.listLocations({ bbox: [-181, -1, 1, 1], pollutants: ["pm25"] }, signal),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      openaq.listLocations({ point: { latitude: 91, longitude: 0, radiusMeters: 1_000 } }, signal),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(http.calls).toHaveLength(0);
  });

  it("propagates cancellation before consuming quota or dispatching", async () => {
    const { client: openaq, http, runtime } = client(() => fixture("locations-page-2.json"));
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    await expect(
      openaq.listLocations({ bbox: [-1, -1, 1, 1], pollutants: ["pm25"] }, controller.signal),
    ).rejects.toThrow("caller cancelled");
    expect(http.calls).toHaveLength(0);
    expect(runtime.quotaCalls).toHaveLength(0);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "quota_exhausted"],
    [500, "upstream_failure"],
  ] as const)("normalizes HTTP %s as %s", async (status, code) => {
    const { client: openaq } = client(() => ({
      status,
      headers: { "retry-after": "30" },
      body: {},
    }));
    await expect(
      openaq.listLocations({ bbox: [-1, -1, 1, 1], pollutants: ["pm25"] }, signal),
    ).rejects.toMatchObject({ code });
  });

  it("rejects malformed successful payloads", async () => {
    const { client: openaq } = client(() => ({ results: [{ id: "not-an-integer" }] }));
    await expect(
      openaq.listLocations({ bbox: [-1, -1, 1, 1], pollutants: ["pm25"] }, signal),
    ).rejects.toBeInstanceOf(OpenAQClientError);
  });

  it("passes cancellation and bounded response options to framework HTTP", async () => {
    const controller = new AbortController();
    const { client: openaq, http } = client(() => fixture("locations-page-2.json"));
    await openaq.listLocations({ bbox: [-1, -1, 1, 1], pollutants: ["pm25"] }, controller.signal);
    expect(http.calls[0].options).toMatchObject({
      signal: controller.signal,
      maxBytes: expect.any(Number),
      contentTypes: ["application/json"],
      redirect: "error",
    });
    expect(http.calls[0].options?.responseHeaders).toEqual(
      expect.arrayContaining(["retry-after", "x-ratelimit-reset", "x-ratelimit-remaining"]),
    );
  });
});
