import { fakeHttpClient, httpStatus } from "@openmapx/integration-framework/testing";
import type { MobilityHttpTransport } from "@openmapx/mobility-core/json-transport";
import { describe, expect, it } from "vitest";
import { createDeNwMobidromScooterClient } from "./de-nw-mobidrom-scooter-client.js";

const bbox = { west: 6.5, south: 50.7, east: 8, north: 51.8 };

const transport: MobilityHttpTransport = {
  userAgent: "OpenMapX/test",
  async fetchJson() {
    throw new Error("no discovery documents in this test");
  },
  async fetchText() {
    return "";
  },
  hostMatchesAllowlist: () => false,
  privateFeedHostAllowlist: () => [],
};

function http() {
  return fakeHttpClient((req) => {
    if (req.url.includes("openid-connect/token")) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ access_token: "token", expires_in: 300 }),
      };
    }
    if (req.url.includes("manifest.json")) return { data: { datasets: [] } };
    throw new Error(`unexpected request: ${req.url}`);
  });
}

describe("createDeNwMobidromScooterClient", () => {
  it("keeps OAuth credentials and token state with the client generation", async () => {
    const firstHttp = http();
    const secondHttp = http();
    const first = createDeNwMobidromScooterClient({
      clientId: "first-id",
      clientSecret: "first-secret",
      http: firstHttp,
      transport,
    });
    const second = createDeNwMobidromScooterClient({
      clientId: "second-id",
      clientSecret: "second-secret",
      http: secondHttp,
      transport,
    });

    await Promise.all([second(bbox), first(bbox)]);
    await first(bbox);

    const tokenBodies = (client: ReturnType<typeof http>) =>
      client.calls.filter((call) => call.method === "postText").map((call) => call.body);
    expect(tokenBodies(firstHttp)).toEqual([
      "grant_type=client_credentials&client_id=first-id&client_secret=first-secret",
    ]);
    expect(tokenBodies(secondHttp)).toEqual([
      "grant_type=client_credentials&client_id=second-id&client_secret=second-secret",
    ]);
  });

  it("never lets a redirect carry the client secret and sends the token only as a header", async () => {
    const client = http();
    await createDeNwMobidromScooterClient({ http: client, transport })(bbox);

    const [token, manifest] = client.calls;
    expect(token?.options).toMatchObject({ redirect: "error" });
    expect(manifest?.method).toBe("get");
    expect(manifest?.options?.headers?.Authorization).toBe("Bearer token");
  });

  it("answers nothing when the token endpoint refuses the client", async () => {
    const client = fakeHttpClient(() => httpStatus(401));
    const search = createDeNwMobidromScooterClient({ http: client, transport });
    await expect(search(bbox)).resolves.toEqual({ stations: [], vehicles: [] });
    expect(client.calls).toHaveLength(1);
  });
});
