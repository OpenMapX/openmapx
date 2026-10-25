import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { uniformErrorHandler } from "../../server-wiring.js";

const getFlowTile = vi.hoisted(() => vi.fn());

vi.mock("../../services/traffic.factory.js", () => ({
  getTrafficProvider: () => ({ getFlowTile }),
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { trafficRoute } = await import("../traffic.js");
  app = Fastify({ logger: false });
  app.setErrorHandler(uniformErrorHandler);
  await app.register(trafficRoute);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  getFlowTile.mockReset();
});

describe("GET /traffic/flow/:z/:x/:y.png", () => {
  it.each([
    ["x outside the zoom world", "/traffic/flow/2/4/0.png"],
    ["y outside the zoom world", "/traffic/flow/2/0/4.png"],
    ["zoom above TomTom's ceiling", "/traffic/flow/23/0/0.png"],
  ])("rejects %s before provider acquisition", async (_label, url) => {
    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(400);
    expect(getFlowTile).not.toHaveBeenCalled();
  });

  it("streams the exact zoom-22 maximum tile and passes caller cancellation", async () => {
    getFlowTile.mockResolvedValue({
      body: Readable.from([Buffer.from([1, 2, 3])]),
      cacheControl: "public, max-age=45",
      contentType: "image/png",
    });

    const response = await app.inject({
      method: "GET",
      url: "/traffic/flow/22/4194303/4194303.png",
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    expect(response.headers["cache-control"]).toBe("public, max-age=45");
    expect(getFlowTile).toHaveBeenCalledWith(22, 4_194_303, 4_194_303, expect.any(AbortSignal));
  });

  it("aborts provider acquisition when a real client socket disconnects", async () => {
    if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    let providerAborted = false;
    getFlowTile.mockImplementation(
      async (_z: number, _x: number, _y: number, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              providerAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const request = get(`http://127.0.0.1:${address.port}/traffic/flow/2/1/1.png`);
    request.on("error", () => {});
    await vi.waitFor(() => expect(getFlowTile).toHaveBeenCalledOnce());

    request.destroy();

    await vi.waitFor(() => expect(providerAborted).toBe(true));
  });

  it("returns a fixed no-store 502 when the provider stream fails before sending bytes", async () => {
    getFlowTile.mockResolvedValue({
      body: new Readable({
        read() {
          this.destroy(new Error("private provider stream detail"));
        },
      }),
      cacheControl: "public, max-age=30, s-maxage=30",
      contentType: "image/png",
    });

    const response = await app.inject({
      method: "GET",
      url: "/traffic/flow/2/1/1.png",
    });

    expect(response.statusCode).toBe(502);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ error: "Internal Server Error" });
    expect(response.body).not.toContain("private provider stream detail");
  });

  it("cancels a stalled provider stream when the client disconnects after the first chunk", async () => {
    let destroyed = false;
    let callerSignal: AbortSignal | undefined;
    let sent = false;
    const providerBody = new Readable({
      read() {
        if (sent) return;
        sent = true;
        this.push(Buffer.from([1]));
      },
      destroy(error, callback) {
        destroyed = true;
        callback(error);
      },
    });
    getFlowTile.mockImplementation(
      async (_z: number, _x: number, _y: number, signal: AbortSignal) => {
        callerSignal = signal;
        return {
          body: providerBody,
          cacheControl: "public, max-age=30, s-maxage=30",
          contentType: "image/png",
        };
      },
    );
    if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;

    await new Promise<void>((resolve, reject) => {
      const request = get(`http://127.0.0.1:${address.port}/traffic/flow/2/1/1.png`, (response) => {
        response.once("data", () => {
          response.destroy();
          request.destroy();
          resolve();
        });
        response.on("error", () => {});
      });
      request.on("error", reject);
    });

    await vi.waitFor(() => {
      expect(callerSignal?.aborted).toBe(true);
      expect(destroyed).toBe(true);
    });
  });
});
