import { beforeEach, describe, expect, it, vi } from "vitest";

const addProtocol = vi.hoisted(() => vi.fn());
vi.mock("maplibre-gl", () => ({ addProtocol }));

import {
  createPaintProtocolHandler,
  ensurePaintProtocol,
  PAINT_PROTOCOL,
  PAINT_SOURCE_ID,
  PAINT_TEMPLATE,
} from "../web/paint-protocol";
import type { MapDetailsWorkerClient } from "../web/worker-client";

const TEMPLATE = "https://maps.example/street/{z}/{x}/{y}.pbf";

function client(bytes: ArrayBuffer | null | Error): MapDetailsWorkerClient {
  return {
    paint: vi.fn(async () => {
      if (bytes instanceof Error) throw bytes;
      return bytes;
    }),
    objects: vi.fn(async () => []),
    dispose: vi.fn(),
  };
}
const params = (url: string) =>
  ({ url }) as Parameters<ReturnType<typeof createPaintProtocolHandler>>[0];

beforeEach(() => addProtocol.mockClear());

describe("paint protocol", () => {
  it("names the protocol, source and template", () => {
    expect(PAINT_PROTOCOL).toBe("openmapx-street-detail");
    expect(PAINT_SOURCE_ID).toBe("openmapx-street-detail");
    expect(PAINT_TEMPLATE).toBe("openmapx-street-detail://{z}/{x}/{y}");
  });

  it("asks the worker for the requested tile and returns its bytes", async () => {
    const worker = client(new ArrayBuffer(4));
    const handler = createPaintProtocolHandler(
      () => worker,
      () => TEMPLATE,
    );
    const controller = new AbortController();
    const result = await handler(params("openmapx-street-detail://17/70418/42985"), controller);
    expect(worker.paint).toHaveBeenCalledWith(17, 70418, 42985, TEMPLATE, controller.signal);
    expect((result.data as ArrayBuffer).byteLength).toBe(4);
  });

  it("returns an empty tile without data, template or client", async () => {
    const empty = async (getClient: () => MapDetailsWorkerClient | null, template: string | null) =>
      (
        await createPaintProtocolHandler(getClient, () => template)(
          params("openmapx-street-detail://16/1/2"),
          new AbortController(),
        )
      ).data as ArrayBuffer;
    expect((await empty(() => client(null), TEMPLATE)).byteLength).toBe(0);
    expect((await empty(() => client(new ArrayBuffer(4)), null)).byteLength).toBe(0);
    expect((await empty(() => null, TEMPLATE)).byteLength).toBe(0);
  });

  it("logs a failure once and answers empty tiles", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = createPaintProtocolHandler(
      () => client(new Error("boom")),
      () => TEMPLATE,
    );
    for (let i = 0; i < 3; i++) {
      const result = await handler(
        params(`openmapx-street-detail://16/${i}/2`),
        new AbortController(),
      );
      expect((result.data as ArrayBuffer).byteLength).toBe(0);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("registers once per page and reads the latest client and template", async () => {
    const first = client(new ArrayBuffer(1));
    const second = client(new ArrayBuffer(2));
    ensurePaintProtocol(
      () => first,
      () => TEMPLATE,
    );
    ensurePaintProtocol(
      () => second,
      () => TEMPLATE,
    );
    expect(addProtocol).toHaveBeenCalledTimes(1);
    const registered = addProtocol.mock.calls[0]?.[1] as ReturnType<
      typeof createPaintProtocolHandler
    >;
    const result = await registered(
      params("openmapx-street-detail://16/1/2"),
      new AbortController(),
    );
    expect((result.data as ArrayBuffer).byteLength).toBe(2);
  });
});
