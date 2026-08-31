import { describe, expect, it, vi } from "vitest";
import type { MobilityHttpTransport } from "../src/json-transport.js";
import { createRisClient } from "../src/server/ris-client.js";

function createTransport() {
  const fetchJson = vi.fn();
  const transport: MobilityHttpTransport = {
    userAgent: "OpenMapX/test",
    fetchJson: fetchJson as MobilityHttpTransport["fetchJson"],
    fetchText: vi.fn(),
    hostMatchesAllowlist: vi.fn(),
    privateFeedHostAllowlist: vi.fn(() => []),
  };
  return { fetchJson, transport };
}

describe("RIS client", () => {
  it("requires both non-blank credentials", () => {
    const { transport } = createTransport();

    expect(createRisClient({}, transport).isConfigured()).toBe(false);
    expect(createRisClient({ clientId: "client" }, transport).isConfigured()).toBe(false);
    expect(createRisClient({ apiKey: "key" }, transport).isConfigured()).toBe(false);
    expect(createRisClient({ clientId: "  ", apiKey: "key" }, transport).isConfigured()).toBe(
      false,
    );
    expect(createRisClient({ clientId: "client", apiKey: "key" }, transport).isConfigured()).toBe(
      true,
    );
  });

  it("keeps credentials isolated between client instances", async () => {
    const { fetchJson, transport } = createTransport();
    fetchJson.mockResolvedValue({ ok: true });
    const stationClient = createRisClient(
      { clientId: "station-client", apiKey: "station-key" },
      transport,
    );
    const routingClient = createRisClient(
      { clientId: "routing-client", apiKey: "routing-key" },
      transport,
    );

    await stationClient.get("stations", "/stop-places/1");
    await routingClient.get("routing", "/location/2");

    expect(fetchJson.mock.calls.map((call) => call[1]?.headers)).toEqual([
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

  it("constructs GET URLs and forwards the caller timeout", async () => {
    const { fetchJson, transport } = createTransport();
    fetchJson.mockResolvedValue({ stopPlaces: [] });
    const client = createRisClient({ clientId: "client", apiKey: "key" }, transport);

    await client.get("stations", "/stop-places/by-position?latitude=50&longitude=6", 125);

    expect(fetchJson).toHaveBeenCalledWith(
      "https://apis.deutschebahn.com/db/apis/ris-stations/v1/stop-places/by-position?latitude=50&longitude=6",
      expect.objectContaining({
        method: "GET",
        timeoutMs: 125,
        allowedRedirectOrigin: "https://apis.deutschebahn.com",
      }),
    );
  });

  it("posts a serialized body with RIS media headers", async () => {
    const { fetchJson, transport } = createTransport();
    fetchJson.mockResolvedValue({ trips: [] });
    const client = createRisClient({ clientId: "client", apiKey: "key" }, transport);

    await client.post("routing", "/multimodal", { origin: "A" }, 250);

    expect(fetchJson).toHaveBeenCalledWith(
      "https://apis.deutschebahn.com/db/apis/ris-routing/v2/multimodal",
      {
        method: "POST",
        body: '{"origin":"A"}',
        timeoutMs: 250,
        allowedRedirectOrigin: "https://apis.deutschebahn.com",
        headers: {
          "DB-Client-ID": "client",
          "DB-Api-Key": "key",
          Accept: "application/vnd.de.db.ris+json",
          "Content-Type": "application/json",
        },
      },
    );
  });

  it("reports the operation when the transport rejects malformed JSON", async () => {
    const { fetchJson, transport } = createTransport();
    fetchJson.mockRejectedValue(new SyntaxError("Unexpected token"));
    const client = createRisClient({ clientId: "client", apiKey: "key" }, transport);

    await expect(client.get("maps", "/journey-positions")).rejects.toThrow(
      "RIS maps GET /journey-positions failed: Unexpected token",
    );
  });

  it("reports the operation when the transport rejects a non-success response", async () => {
    const { fetchJson, transport } = createTransport();
    fetchJson.mockRejectedValue(
      new Error(
        "Request failed: HTTP 503 for https://apis.deutschebahn.com/db/apis/ris-stations/v1/stop-places/1",
      ),
    );
    const client = createRisClient({ clientId: "client", apiKey: "key" }, transport);

    await expect(client.get("stations", "/stop-places/1")).rejects.toThrow(
      "RIS stations GET /stop-places/1 failed: Request failed: HTTP 503",
    );
  });

  it("rejects requests before transport use when credentials are incomplete", async () => {
    const { fetchJson, transport } = createTransport();
    const client = createRisClient({ clientId: "client" }, transport);

    await expect(client.get("stations", "/stop-places/1")).rejects.toThrow(
      "DB RIS credentials not configured",
    );
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
