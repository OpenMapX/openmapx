import { describe, expect, it, vi } from "vitest";
import { createRisClient, type RisHttp } from "../src/server/ris-client.js";

function createHttp() {
  const get = vi.fn();
  const post = vi.fn();
  const http: RisHttp = { get, post };
  return { get, post, http };
}

describe("RIS client", () => {
  it("requires both non-blank credentials", () => {
    const { http } = createHttp();

    expect(createRisClient({}, http).isConfigured()).toBe(false);
    expect(createRisClient({ clientId: "client" }, http).isConfigured()).toBe(false);
    expect(createRisClient({ apiKey: "key" }, http).isConfigured()).toBe(false);
    expect(createRisClient({ clientId: "  ", apiKey: "key" }, http).isConfigured()).toBe(false);
    expect(createRisClient({ clientId: "client", apiKey: "key" }, http).isConfigured()).toBe(true);
  });

  it("keeps credentials isolated between client instances", async () => {
    const { get, http } = createHttp();
    get.mockResolvedValue({ ok: true });
    const stationClient = createRisClient(
      { clientId: "station-client", apiKey: "station-key" },
      http,
    );
    const routingClient = createRisClient(
      { clientId: "routing-client", apiKey: "routing-key" },
      http,
    );

    await stationClient.get("stations", "/stop-places/1");
    await routingClient.get("routing", "/location/2");

    expect(get.mock.calls.map((call) => call[1]?.headers)).toEqual([
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
    const { get, http } = createHttp();
    get.mockResolvedValue({ stopPlaces: [] });
    const client = createRisClient({ clientId: "client", apiKey: "key" }, http);

    await client.get("stations", "/stop-places/by-position?latitude=50&longitude=6", 125);

    expect(get).toHaveBeenCalledWith(
      "https://apis.deutschebahn.com/db/apis/ris-stations/v1/stop-places/by-position?latitude=50&longitude=6",
      expect.objectContaining({ timeoutMs: 125 }),
    );
  });

  it("posts the body with RIS media headers", async () => {
    const { post, http } = createHttp();
    post.mockResolvedValue({ trips: [] });
    const client = createRisClient({ clientId: "client", apiKey: "key" }, http);

    await client.post("routing", "/multimodal", { origin: "A" }, 250);

    expect(post).toHaveBeenCalledWith(
      "https://apis.deutschebahn.com/db/apis/ris-routing/v2/multimodal",
      { origin: "A" },
      {
        timeoutMs: 250,
        headers: {
          "DB-Client-ID": "client",
          "DB-Api-Key": "key",
          Accept: "application/vnd.de.db.ris+json",
        },
      },
    );
  });

  it("reports the operation and keeps the upstream status on the cause", async () => {
    const { get, http } = createHttp();
    const upstream = Object.assign(new Error("HTTP 503 Service Unavailable"), { status: 503 });
    get.mockRejectedValue(upstream);
    const client = createRisClient({ clientId: "client", apiKey: "key" }, http);

    const failure = client.get("stations", "/stop-places/1");
    await expect(failure).rejects.toThrow(
      "RIS stations GET /stop-places/1 failed: HTTP 503 Service Unavailable",
    );
    await expect(failure).rejects.toMatchObject({ cause: upstream });
  });

  it("reports the operation when the host client rejects malformed JSON", async () => {
    const { get, http } = createHttp();
    const malformed = new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON");
    get.mockRejectedValue(malformed);
    const client = createRisClient({ clientId: "client", apiKey: "key" }, http);

    const failure = client.get("maps", "/journey-positions");
    await expect(failure).rejects.toThrow(
      "RIS maps GET /journey-positions failed: Unexpected token '<'",
    );
    await expect(failure).rejects.toMatchObject({ cause: malformed });
  });

  it("rejects requests before any request when credentials are incomplete", async () => {
    const { get, http } = createHttp();
    const client = createRisClient({ clientId: "client" }, http);

    await expect(client.get("stations", "/stop-places/1")).rejects.toThrow(
      "DB RIS credentials not configured",
    );
    expect(get).not.toHaveBeenCalled();
  });
});

describe("RIS client cancellation", () => {
  it.each(["get", "post"] as const)(
    "preserves caller cancellation for %s with positional timeout",
    async (method) => {
      const { get, post, http } = createHttp();
      const controller = new AbortController();
      const reason = new Error("provider cancelled");
      const pendingRequest = (options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      get.mockImplementation((_url, options) => pendingRequest(options));
      post.mockImplementation((_url, _body, options) => pendingRequest(options));
      const client = createRisClient({ clientId: "client", apiKey: "key" }, http);
      const pending =
        method === "get"
          ? client.get("stations", "/stop-places/1", 125, controller.signal)
          : client.post("routing", "/multimodal", {}, 250, controller.signal);
      const assertion = expect(pending).rejects.toBe(reason);
      controller.abort(reason);
      const options = method === "get" ? get.mock.calls[0]?.[1] : post.mock.calls[0]?.[2];
      expect(options?.timeoutMs).toBe(method === "get" ? 125 : 250);
      await assertion;
    },
  );
});
