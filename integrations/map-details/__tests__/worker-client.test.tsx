import { afterEach, describe, expect, it, vi } from "vitest";
import { absoluteTemplate, createMapDetailsWorker } from "../web/worker-client";
import type { WorkerRequest, WorkerResponse } from "../web/worker-core";

const TEMPLATE = "https://maps.example/street/{z}/{x}/{y}.pbf";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("absoluteTemplate", () => {
  it("resolves relative templates without escaping the placeholders", () => {
    expect(
      absoluteTemplate("/tiles/data/street_detail/{z}/{x}/{y}.pbf", "https://maps.example/a/"),
    ).toBe("https://maps.example/tiles/data/street_detail/{z}/{x}/{y}.pbf");
    expect(absoluteTemplate(TEMPLATE, "https://other.example/")).toBe(TEMPLATE);
  });
});

describe("inline fallback", () => {
  it("derives in this thread when workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createMapDetailsWorker();
    expect(await client.paint(16, 1, 2, TEMPLATE)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("https://maps.example/street/16/1/2.pbf");
    expect(
      await client.objects({
        cellX: 1,
        cellY: 2,
        streetTemplate: TEMPLATE,
        basemapTemplates: [],
        basemapMaxzoom: 14,
      }),
    ).toEqual([]);
    client.dispose();
  });

  it("answers null for a request superseded before it finished", async () => {
    vi.stubGlobal("Worker", undefined);
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createMapDetailsWorker();
    const controller = new AbortController();
    const pending = client.paint(16, 1, 2, TEMPLATE, controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    // The inline work still finishes in the background; let it before fetch is unstubbed.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});

describe("worker transport", () => {
  class FakeWorker {
    static last: FakeWorker | null = null;
    posted: Array<{ request: WorkerRequest; transfer?: Transferable[] }> = [];
    onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = false;
    constructor(
      readonly url: URL,
      readonly options: WorkerOptions,
    ) {
      FakeWorker.last = this;
    }
    postMessage(request: WorkerRequest, transfer?: Transferable[]) {
      this.posted.push({ request, transfer });
    }
    reply(response: WorkerResponse) {
      this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
    }
    terminate() {
      this.terminated = true;
    }
  }

  it("posts requests to a module worker and resolves their answers", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = createMapDetailsWorker();
    const worker = FakeWorker.last as FakeWorker;
    expect(worker.options).toEqual({ type: "module" });
    expect(String(worker.url)).toContain("map-details-worker");
    const pending = client.paint(17, 3, 4, TEMPLATE);
    const [{ request }] = worker.posted as [{ request: WorkerRequest }];
    expect(request).toMatchObject({ kind: "paint", z: 17, x: 3, y: 4, streetTemplate: TEMPLATE });
    const bytes = new ArrayBuffer(8);
    worker.reply({ id: request.id, kind: "paint", bytes });
    expect(await pending).toBe(bytes);
    client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("cancels a superseded request in the worker and ignores its late answer", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = createMapDetailsWorker();
    const worker = FakeWorker.last as FakeWorker;
    const controller = new AbortController();
    const pending = client.objects(
      {
        cellX: 1,
        cellY: 2,
        streetTemplate: null,
        basemapTemplates: [TEMPLATE],
        basemapMaxzoom: 14,
      },
      controller.signal,
    );
    controller.abort();
    expect(await pending).toBeNull();
    const [first, second] = worker.posted;
    expect(second?.request).toEqual({
      id: expect.any(Number),
      kind: "cancel",
      target: first?.request.id,
    });
    worker.reply({ id: first?.request.id ?? 0, kind: "objects", instances: [] });
  });
});
