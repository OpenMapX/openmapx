import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getSession, prepareSubjectExport } = vi.hoisted(() => ({
  getSession: vi.fn(),
  prepareSubjectExport: vi.fn(),
}));

vi.mock("../../auth.js", () => ({ auth: { api: { getSession } } }));
vi.mock("../../db/index.js", () => ({ db: {} }));
vi.mock("../../utils/require-auth.js", () => ({
  requireAuthHook: vi.fn(async (request: { headers: Record<string, unknown>; userId?: string }) => {
    request.userId = String(request.headers["x-test-user"]);
  }),
  getUserId: (request: { userId?: string }) => request.userId,
}));
vi.mock("../../privacy/session-assurance.js", () => ({ hasFreshAssurance: async () => true }));
vi.mock("../../privacy/request-service.js", () => ({ PrivacyRequestService: class {} }));
vi.mock("../../privacy/subject-export.js", () => ({ prepareSubjectExport }));

import { createPrivacyExportAdmission } from "../../privacy/export-admission.js";
import { privacyRequestsRoute } from "../privacy-requests.js";

const PAYLOAD = { locale: "en", timeZone: "UTC" };

/** An export that writes its first bytes and then waits until told to finish.
 * Like the real one, it rejects once the response goes away. */
function heldExport() {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const prepared = {
    filename: "openmapx-data-export.zip",
    async write(sink: Writable) {
      if (sink.destroyed) throw new Error("sink closed");
      const closed = new Promise<never>((_resolve, reject) =>
        sink.once("close", () => reject(new Error("sink closed"))),
      );
      closed.catch(() => undefined);
      sink.write("PK");
      await Promise.race([gate, closed]);
      sink.end();
    },
    dispose: vi.fn(async () => {}),
  };
  return { prepared, finish };
}

function instantExport() {
  return {
    filename: "openmapx-data-export.zip",
    async write(sink: Writable) {
      sink.end("PK");
    },
    dispose: async () => {},
  };
}

function fakeService() {
  return {
    beginSelfServiceExport: vi.fn(async (input: { userId: string }) => ({
      id: `request-${input.userId}`,
      userId: input.userId,
    })),
    finishExport: vi.fn(async () => ({})),
    recordExportFailure: vi.fn(async () => {}),
  };
}

let app: FastifyInstance | undefined;

/** An export far larger than any socket buffer, written with backpressure;
 * it rejects once the response goes away, like the real archive writer. */
function endlessExport() {
  const chunk = Buffer.alloc(64 * 1024, 1);
  return {
    filename: "openmapx-data-export.zip",
    dispose: vi.fn(async () => {}),
    write: (sink: Writable) =>
      new Promise<void>((_resolve, reject) => {
        let stopped = false;
        sink.once("close", () => {
          stopped = true;
          reject(new Error("sink closed"));
        });
        const next = () => {
          if (stopped) return;
          if (sink.write(chunk)) setImmediate(next);
          else sink.once("drain", next);
        };
        next();
      }),
  };
}

async function exportApp(
  maxConcurrent?: number,
  exportStreamLimits?: { idleMs?: number; totalMs?: number },
) {
  const service = fakeService();
  app = Fastify();
  await app.register(privacyRequestsRoute, {
    prefix: "/api",
    // The route only calls the export methods on the service.
    service: service as never,
    exportAdmission: createPrivacyExportAdmission(maxConcurrent),
    ...(exportStreamLimits ? { exportStreamLimits } : {}),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, service, port: (app.server.address() as AddressInfo).port };
}

function inject(user: string) {
  return (app as FastifyInstance).inject({
    method: "POST",
    url: "/api/privacy/export",
    headers: { "x-test-user": user },
    payload: PAYLOAD,
  });
}

/** Start an export over a real socket; resolves once the first bytes arrive. */
function startStreaming(port: number, user: string, onSent?: () => void) {
  const outgoing = httpRequest({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/api/privacy/export",
    headers: { "content-type": "application/json", "x-test-user": user },
  });
  outgoing.on("error", () => undefined);
  const firstBytes = new Promise<{ status: number; rest: Promise<string>; abort: () => void }>(
    (resolve) => {
      outgoing.on("response", (incoming) => {
        incoming.on("error", () => undefined);
        let text = "";
        const rest = new Promise<string>((done) => {
          incoming.on("end", () => done(text));
        });
        incoming.once("data", (chunk: Buffer) => {
          text += chunk.toString();
          incoming.on("data", (more: Buffer) => {
            text += more.toString();
          });
          resolve({
            status: incoming.statusCode ?? 0,
            rest,
            abort: () => {
              incoming.destroy();
              outgoing.destroy();
            },
          });
        });
      });
    },
  );
  outgoing.end(JSON.stringify(PAYLOAD), onSent);
  return { firstBytes, outgoing };
}

getSession.mockImplementation(async ({ headers }: { headers: Headers }) => {
  const id = headers.get("x-test-user");
  return { user: { id, twoFactorEnabled: false }, session: { id: `session-${id}` } };
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  prepareSubjectExport.mockReset();
});

describe("POST /api/privacy/export admission", () => {
  it("refuses a second export for the same account while the first is streaming, then accepts a retry", async () => {
    const { service, port } = await exportApp();
    const held = heldExport();
    prepareSubjectExport.mockResolvedValueOnce(held.prepared);
    const first = await startStreaming(port, "alice").firstBytes;
    expect(first.status).toBe(200);

    const second = await inject("alice");
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "Conflict", code: "EXPORT_IN_PROGRESS" });
    expect(service.beginSelfServiceExport).toHaveBeenCalledTimes(1);
    expect(service.recordExportFailure).not.toHaveBeenCalled();

    held.finish();
    expect(await first.rest).toBe("PK");
    await vi.waitFor(() => expect(service.finishExport).toHaveBeenCalledTimes(1));

    prepareSubjectExport.mockResolvedValueOnce(instantExport());
    await vi.waitFor(async () => expect((await inject("alice")).statusCode).toBe(200));
  });

  it("does not block another account", async () => {
    const { port } = await exportApp();
    const held = heldExport();
    prepareSubjectExport.mockResolvedValueOnce(held.prepared);
    const alice = await startStreaming(port, "alice").firstBytes;
    prepareSubjectExport.mockResolvedValueOnce(instantExport());
    expect((await inject("bob")).statusCode).toBe(200);
    held.finish();
    await alice.rest;
  });

  it("asks for a later retry once the process ceiling is reached", async () => {
    const { service, port } = await exportApp(1);
    const held = heldExport();
    prepareSubjectExport.mockResolvedValueOnce(held.prepared);
    const alice = await startStreaming(port, "alice").firstBytes;
    const bob = await inject("bob");
    expect(bob.statusCode).toBe(503);
    expect(bob.json()).toEqual({
      error: "Service Unavailable",
      code: "PRIVACY_SERVICE_UNAVAILABLE",
    });
    expect(service.beginSelfServiceExport).toHaveBeenCalledTimes(1);
    held.finish();
    await alice.rest;
  });

  it("frees the slot after preparation fails", async () => {
    const { service } = await exportApp();
    prepareSubjectExport.mockRejectedValueOnce(new Error("source down"));
    const failed = await inject("alice");
    expect(failed.statusCode).toBe(503);
    expect(service.recordExportFailure).toHaveBeenCalledWith(
      "request-alice",
      "export-preparation-failed",
    );

    prepareSubjectExport.mockResolvedValueOnce(instantExport());
    expect((await inject("alice")).statusCode).toBe(200);
  });

  it("frees the slot after the client aborts the download", async () => {
    const { service, port } = await exportApp();
    const held = heldExport();
    prepareSubjectExport.mockResolvedValueOnce(held.prepared);
    const first = await startStreaming(port, "alice").firstBytes;
    first.abort();
    await vi.waitFor(() =>
      expect(service.recordExportFailure).toHaveBeenCalledWith(
        "request-alice",
        "export-interrupted",
      ),
    );
    expect(service.finishExport).not.toHaveBeenCalled();
    expect(held.prepared.dispose).toHaveBeenCalled();

    prepareSubjectExport.mockResolvedValueOnce(instantExport());
    await vi.waitFor(async () => expect((await inject("alice")).statusCode).toBe(200));
  });

  it("ends a download whose client stops reading and frees the slot", async () => {
    const { service, port } = await exportApp(undefined, { idleMs: 200 });
    const stalled = endlessExport();
    prepareSubjectExport.mockResolvedValueOnce(stalled);
    const { outgoing } = startStreaming(port, "alice");
    let incoming: import("node:http").IncomingMessage | undefined;
    outgoing.once("response", (response) => {
      incoming = response;
      // The client keeps the connection open but never reads past this point.
      response.once("data", () => response.pause());
    });
    await vi.waitFor(
      () =>
        expect(service.recordExportFailure).toHaveBeenCalledWith(
          "request-alice",
          "export-interrupted",
        ),
      { timeout: 10_000 },
    );
    expect(service.finishExport).not.toHaveBeenCalled();
    expect(stalled.dispose).toHaveBeenCalled();
    expect(incoming).toBeDefined();

    prepareSubjectExport.mockResolvedValueOnce(instantExport());
    await vi.waitFor(async () => expect((await inject("alice")).statusCode).toBe(200));
    outgoing.destroy();
  });

  it("leaves a normal download alone under short deadlines", async () => {
    const { service, port } = await exportApp(undefined, { idleMs: 200, totalMs: 5_000 });
    prepareSubjectExport.mockResolvedValueOnce(instantExport());
    const first = await startStreaming(port, "alice").firstBytes;
    expect(first.status).toBe(200);
    expect(await first.rest).toBe("PK");
    await vi.waitFor(() => expect(service.finishExport).toHaveBeenCalledTimes(1));
    expect(service.recordExportFailure).not.toHaveBeenCalled();
  });

  it("frees the slot when the client leaves while the export is being prepared", async () => {
    const { service, port } = await exportApp();
    const held = heldExport();
    let release!: (value: unknown) => void;
    prepareSubjectExport.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { outgoing } = startStreaming(port, "alice");
    await vi.waitFor(() => expect(prepareSubjectExport).toHaveBeenCalledTimes(1));
    outgoing.destroy();
    // Give the server a moment to see the closed socket before preparation ends.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release(held.prepared);

    await vi.waitFor(() =>
      expect(service.recordExportFailure).toHaveBeenCalledWith(
        "request-alice",
        "export-interrupted",
      ),
    );
    prepareSubjectExport.mockResolvedValueOnce(instantExport());
    await vi.waitFor(async () => expect((await inject("alice")).statusCode).toBe(200));
  });
});
