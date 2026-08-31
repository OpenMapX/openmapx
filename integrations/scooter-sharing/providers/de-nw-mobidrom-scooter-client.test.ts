import type { MobilityHttpTransport } from "@openmapx/mobility-core/json-transport";
import { describe, expect, it } from "vitest";
import { createDeNwMobidromScooterClient } from "./de-nw-mobidrom-scooter-client.js";

const bbox = { west: 6.5, south: 50.7, east: 8, north: 51.8 };

function transport(tokenBodies: string[]): MobilityHttpTransport {
  return {
    userAgent: "OpenMapX/test",
    async fetchJson<T>(url, options) {
      if (url.includes("openid-connect/token")) {
        tokenBodies.push(options?.body ?? "");
        return { access_token: "token", expires_in: 300 } as T;
      }
      if (url.includes("manifest.json")) {
        return { data: { datasets: [] } } as T;
      }
      throw new Error(`unexpected request: ${url}`);
    },
    async fetchText() {
      return "";
    },
    hostMatchesAllowlist: () => false,
    privateFeedHostAllowlist: () => [],
  };
}

describe("createDeNwMobidromScooterClient", () => {
  it("keeps OAuth credentials and token state with the client generation", async () => {
    const firstTokenBodies: string[] = [];
    const secondTokenBodies: string[] = [];
    const first = createDeNwMobidromScooterClient({
      clientId: "first-id",
      clientSecret: "first-secret",
      transport: transport(firstTokenBodies),
    });
    const second = createDeNwMobidromScooterClient({
      clientId: "second-id",
      clientSecret: "second-secret",
      transport: transport(secondTokenBodies),
    });

    await Promise.all([second(bbox), first(bbox)]);
    await first(bbox);

    expect(firstTokenBodies).toEqual([
      "grant_type=client_credentials&client_id=first-id&client_secret=first-secret",
    ]);
    expect(secondTokenBodies).toEqual([
      "grant_type=client_credentials&client_id=second-id&client_secret=second-secret",
    ]);
  });
});
