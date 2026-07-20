import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWithTimeout } from "../../src/jobs/transitous/motis-probe.js";

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server?.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("fetchWithTimeout (node:http, bypassing undici)", () => {
  it("returns a standard Response for a 200 JSON body", async () => {
    const base = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
    const res = await fetchWithTimeout(`${base}/health`, 2000);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("retries a transient socket fault (server drops the connection) then succeeds", async () => {
    let n = 0;
    const base = await listen((_req, res) => {
      n++;
      if (n < 3) {
        res.socket?.destroy(); // abrupt close → ECONNRESET/socket hang up on the client
        return;
      }
      res.end("{}");
    });
    const res = await fetchWithTimeout(`${base}/plan`, 2000, 3);
    expect(res.status).toBe(200);
    expect(n).toBe(3);
  });

  it("times out (and does not retry) when the server never responds", async () => {
    const base = await listen(() => {
      /* intentionally never responds */
    });
    await expect(fetchWithTimeout(`${base}/plan`, 300, 3)).rejects.toThrow(/timed out/);
  });

  it("surfaces a non-2xx status without throwing", async () => {
    const base = await listen((_req, res) => {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    const res = await fetchWithTimeout(`${base}/health`, 2000);
    expect(res.status).toBe(400);
    expect(res.ok).toBe(false);
  });
});
