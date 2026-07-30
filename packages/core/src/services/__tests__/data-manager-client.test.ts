import { describe, expect, it } from "vitest";
import { DataManagerClient } from "../data-manager-client";

describe("DataManagerClient transit source lifecycle", () => {
  it("starts transactional syncs and source mutations through lifecycle endpoints", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new DataManagerClient({
      baseUrl: "https://data-manager.test",
      authToken: "secret",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ jobId: "job-1", sourceId: "de-test", status: "started" });
      },
    });

    await client.syncTransit({ countries: ["de"] });
    await client.addTransitSource({
      region: "de",
      name: "Test transit",
      url: "https://example.com/test.zip",
      license: { spdxIdentifier: "CC-BY-4.0", attribution: "Test Transit" },
    });
    await client.removeTransitSource("de-test");
    await client.enableTransitSource("de-test");

    expect(requests).toEqual([
      {
        url: "https://data-manager.test/transit/sync",
        method: "POST",
        body: { countries: ["de"] },
      },
      {
        url: "https://data-manager.test/transit/sources",
        method: "POST",
        body: {
          region: "de",
          name: "Test transit",
          url: "https://example.com/test.zip",
          license: { spdxIdentifier: "CC-BY-4.0", attribution: "Test Transit" },
        },
      },
      {
        url: "https://data-manager.test/transit/sources/de-test",
        method: "DELETE",
        body: {},
      },
      {
        url: "https://data-manager.test/transit/sources/de-test/enable",
        method: "POST",
        body: {},
      },
    ]);
  });

  it("surfaces a single-flight conflict reason", async () => {
    const client = new DataManagerClient({
      baseUrl: "https://data-manager.test",
      fetch: async () =>
        Response.json({ error: "sync already running", reason: "job-active" }, { status: 409 }),
    });

    await expect(client.syncTransit()).rejects.toThrow("sync already running");
  });
});
