import { afterEach, describe, expect, it, vi } from "vitest";
import { createRisClient } from "./ris-client";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RIS client", () => {
  it("keeps credentials isolated between client instances", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const stationClient = createRisClient({ clientId: "station-client", apiKey: "station-key" });
    const routingClient = createRisClient({ clientId: "routing-client", apiKey: "routing-key" });

    await stationClient.get("stations", "/stop-places/1");
    await routingClient.get("routing", "/location/2");

    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit).headers)).toEqual([
      {
        "DB-Client-ID": "station-client",
        "DB-Api-Key": "station-key",
        Accept: "application/vnd.de.db.ris+json",
      },
      {
        "DB-Client-ID": "routing-client",
        "DB-Api-Key": "routing-key",
        Accept: "application/vnd.de.db.ris+json",
      },
    ]);
  });

  it("rejects requests when either credential is absent", async () => {
    const client = createRisClient({ clientId: "client-only" });
    expect(client.isConfigured()).toBe(false);
    await expect(client.get("stations", "/stop-places/1")).rejects.toThrow(
      "DB RIS credentials not configured",
    );
  });

  it("posts JSON with RIS media headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ trips: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createRisClient({ clientId: "client", apiKey: "key" });

    await client.post("routing", "/multimodal", { origin: "A" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://apis.deutschebahn.com/db/apis/ris-routing/v2/multimodal",
      expect.objectContaining({
        method: "POST",
        body: '{"origin":"A"}',
        headers: {
          "DB-Client-ID": "client",
          "DB-Api-Key": "key",
          Accept: "application/vnd.de.db.ris+json",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("applies the caller timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }),
    );
    const client = createRisClient({ clientId: "client", apiKey: "key" });
    const request = client.get("stations", "/stop-places/1", 25);
    const rejection = expect(request).rejects.toThrow(/timeout/i);

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });

  it("reports the RIS operation for non-success responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unavailable", { status: 503, statusText: "Down" })),
    );
    const client = createRisClient({ clientId: "client", apiKey: "key" });

    await expect(client.get("stations", "/stop-places/1")).rejects.toThrow(
      "RIS stations GET /stop-places/1 failed: 503 Down",
    );
  });
});
