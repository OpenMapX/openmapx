import { describe, expect, it } from "vitest";
import { fetchTrafficPolicy } from "../jobs/traffic/policy.js";

describe("traffic policy client", () => {
  it("rejects expired, non-authoritative and malformed leases", async () => {
    for (const body of [
      {},
      { schemaVersion: 1, authoritative: false },
      {
        schemaVersion: 1,
        authoritative: true,
        revision: "v1",
        validUntil: "2000-01-01T00:00:00Z",
        disallowedSourceIds: [],
      },
    ]) {
      await expect(
        fetchTrafficPolicy({
          baseUrl: "http://app-api:3001",
          token: "test",
          fetch: async () => new Response(JSON.stringify(body)),
        }),
      ).rejects.toThrow();
    }
  });
  it("uses service authentication, bounded leases and disallowed original source IDs", async () => {
    let sent: RequestInit | undefined;
    const policy = await fetchTrafficPolicy({
      baseUrl: "http://app-api:3001",
      token: "test",
      fetch: async (_url, init) => {
        sent = init;
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            authoritative: true,
            revision: "v1",
            evaluatedAt: new Date().toISOString(),
            validUntil: new Date(Date.now() + 120_000).toISOString(),
            disallowedSourceIds: ["us-wzdx"],
          }),
        );
      },
    });
    expect(policy.disallowedSourceIds).toEqual(["us-wzdx"]);
    expect(sent?.redirect).toBe("error");
    expect(sent?.headers).toEqual({ Authorization: "Bearer test" });
  });
});
