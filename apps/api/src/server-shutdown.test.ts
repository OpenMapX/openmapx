import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { shutdownServer } from "./server-wiring.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function spyLog() {
  return { warn: vi.fn(), error: vi.fn() };
}

async function listening(configure: (app: FastifyInstance) => void) {
  const app = Fastify({ logger: false });
  configure(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, port: (app.server.address() as AddressInfo).port };
}

/** One GET on its own connection; resolves with the status, or null when the connection fails. */
function get(port: number, path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, agent: false, timeout: 2_000 },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? null));
        res.on("error", () => resolve(null));
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

/** Opens an event stream and resolves once its first chunk has arrived. */
function openStream(port: number, onEnd: () => void): Promise<IncomingMessage | number> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/stream", agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
        return;
      }
      res.once("data", () => resolve(res));
      res.on("close", onEnd);
      res.on("error", () => {});
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

function streamRoute(app: FastifyInstance, open: { count: number }) {
  app.get("/stream", async (_request, reply) => {
    reply.hijack();
    open.count += 1;
    reply.raw.on("close", () => {
      open.count -= 1;
    });
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    reply.raw.write("retry: 100\n\n");
  });
}

describe("shutdownServer", () => {
  it("runs the release step only after in-flight requests finish, and no request reaches it afterwards", async () => {
    const events: string[] = [];
    let released = false;
    let reachedAfterRelease = 0;
    let finishHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      finishHeld = resolve;
    });
    const { app, port } = await listening((server) => {
      server.get("/held", async () => {
        await held;
        events.push("held request finished");
        return { ok: true };
      });
      server.get("/integration", async () => {
        if (released) reachedAfterRelease += 1;
        return { ok: true };
      });
    });

    const inFlight = get(port, "/held");
    await vi.waitFor(() => expect(app.server.listening).toBe(true));
    await pause(50);

    const shutdown = shutdownServer(app, {
      graceMs: 5_000,
      forceMs: 5_000,
      log: spyLog(),
      afterClose: async () => {
        released = true;
        events.push("integrations removed");
      },
    });
    await pause(50);
    // Arrives while the held request keeps shutdown open: it is turned away
    // (or refused outright once the listener stopped) and never reaches a route.
    const during = await get(port, "/integration");
    expect([null, 503]).toContain(during);
    expect(events).toEqual([]);

    finishHeld();
    await shutdown;
    expect(await inFlight).toBe(200);
    expect(events).toEqual(["held request finished", "integrations removed"]);
    expect(await get(port, "/integration")).toBeNull();
    expect(reachedAfterRelease).toBe(0);
  });

  it("ends an open event stream at the deadline instead of waiting for it", async () => {
    const open = { count: 0 };
    const { app, port } = await listening((server) => streamRoute(server, open));
    let streamEnded = false;
    const stream = await openStream(port, () => {
      streamEnded = true;
    });
    expect(typeof stream).toBe("object");
    expect(open.count).toBe(1);

    const afterClose = vi.fn(async () => {});
    const log = spyLog();
    const startedAt = Date.now();
    await shutdownServer(app, { graceMs: 200, forceMs: 2_000, log, afterClose });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1_500);
    await vi.waitFor(() => expect(streamEnded).toBe(true));
    await vi.waitFor(() => expect(open.count).toBe(0));
    expect(afterClose).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("is not held open by a client that reconnects its stream while the server shuts down", async () => {
    const open = { count: 0 };
    const { app, port } = await listening((server) => streamRoute(server, open));
    let stopped = false;
    let reconnects = 0;
    const refused: Array<number> = [];
    const follow = async () => {
      while (!stopped) {
        const result = await openStream(port, () => {});
        if (typeof result === "number") {
          refused.push(result);
          await pause(10);
        } else {
          await new Promise<void>((resolve) => result.once("close", () => resolve()));
          reconnects += 1;
        }
      }
    };
    const following = follow();
    await vi.waitFor(() => expect(open.count).toBe(1));

    const startedAt = Date.now();
    await shutdownServer(app, {
      graceMs: 200,
      forceMs: 2_000,
      log: spyLog(),
      afterClose: async () => {},
    });
    const elapsed = Date.now() - startedAt;
    await vi.waitFor(() => expect(refused.length).toBeGreaterThan(0));
    stopped = true;
    await following;

    expect(elapsed).toBeLessThan(1_500);
    await vi.waitFor(() => expect(open.count).toBe(0));
    // Every attempt made after the stream was cut was refused: the listener is gone.
    for (const status of refused) expect(status).toBe(0);
    expect(refused.length).toBeGreaterThan(0);
    expect(reconnects).toBe(1);
  });

  it("goes on with shutdown when the listener close itself never finishes", async () => {
    const { app } = await listening((server) => {
      server.addHook("onClose", () => new Promise<void>(() => {}));
    });
    const afterClose = vi.fn(async () => {});
    const log = spyLog();
    const startedAt = Date.now();
    await shutdownServer(app, { graceMs: 100, forceMs: 150, log, afterClose });
    const elapsed = Date.now() - startedAt;
    app.server.close();

    expect(elapsed).toBeGreaterThanOrEqual(230);
    expect(elapsed).toBeLessThan(1_500);
    expect(afterClose).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/did not close/),
    );
  });

  it("still releases integrations when closing the server fails", async () => {
    const { app } = await listening((server) => {
      server.addHook("onClose", async () => {
        throw new Error("close hook failed");
      });
    });
    const afterClose = vi.fn(async () => {});
    const log = spyLog();
    await shutdownServer(app, { graceMs: 1_000, forceMs: 1_000, log, afterClose });
    app.server.close();

    expect(afterClose).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.anything(), "Closing the server failed");
  });
});
