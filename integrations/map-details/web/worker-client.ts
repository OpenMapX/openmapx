import type { Instances } from "./derive/forest";
import type { LaneHighlightAnswer } from "./derive/lane-highlight";
import type { WorkerCore, WorkerRequest, WorkerResponse } from "./worker-core";

/** What the objects layer asks the worker for one z16 cell. */
export type ObjectsQuery = Omit<Extract<WorkerRequest, { kind: "objects" }>, "id" | "kind">;
export type LaneHighlightQuery = Omit<
  Extract<WorkerRequest, { kind: "lane-highlight" }>,
  "id" | "kind"
>;

export interface MapDetailsWorkerClient {
  /** Paint tile bytes, or null without street data or when superseded (`signal` aborted). */
  paint(
    z: number,
    x: number,
    y: number,
    template: string,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer | null>;
  /** Instances of a cell, or null when superseded. */
  objects(query: ObjectsQuery, signal?: AbortSignal): Promise<Instances[] | null>;
  /** The recommended lanes as polygons on the road, or null when superseded or disposed. */
  laneHighlight(
    query: LaneHighlightQuery,
    signal?: AbortSignal,
  ): Promise<LaneHighlightAnswer | null>;
  dispose(): void;
}

type Send = (request: WorkerRequest) => Promise<WorkerResponse | null>;

/**
 * Resolve a tile URL template against the page without escaping `{z}`,
 * `{x}` and `{y}`: the worker fetches from its own location, so relative
 * templates must be absolute.
 */
export function absoluteTemplate(template: string, base: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(template)) return template;
  const tokens = template.replace(/\{([zxy])\}/g, "__map_details_$1__");
  return new URL(tokens, base).href.replace(/__map_details_([zxy])__/g, "{$1}");
}

function inlineSend(): Send {
  let core: Promise<WorkerCore> | undefined;
  return async (request) => {
    core ??= import("./worker-core").then(({ createWorkerCore }) =>
      createWorkerCore((...args) => fetch(...args)),
    );
    const result = await (await core).handle(request);
    return result?.response ?? null;
  };
}

/** One module worker for all derivation, with an inline fallback where workers are unavailable. */
export function createMapDetailsWorker(): MapDetailsWorkerClient {
  const base = typeof document === "undefined" ? "http://localhost/" : document.baseURI;
  let sequence = 0;
  let disposed = false;
  let worker: Worker | null = null;
  let send: Send = inlineSend();
  const pending = new Map<number, (response: WorkerResponse | null) => void>();

  if (typeof Worker !== "undefined") {
    try {
      worker = new Worker(new URL("./map-details-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const resolve = pending.get(event.data.id);
        pending.delete(event.data.id);
        resolve?.(event.data);
      };
      worker.onerror = () => {
        // A broken worker falls back to deriving in this thread from now on.
        worker?.terminate();
        worker = null;
        send = inlineSend();
        for (const resolve of pending.values()) resolve(null);
        pending.clear();
      };
      send = (request) => {
        // Only after disposal: a broken worker swaps `send` for the inline fallback.
        if (!worker) return Promise.resolve(null);
        const target = worker;
        return new Promise((resolve) => {
          if (request.kind === "cancel") {
            target.postMessage(request);
            resolve(null);
            return;
          }
          pending.set(request.id, resolve);
          target.postMessage(request);
        });
      };
    } catch {
      worker = null;
    }
  }

  async function request(
    body: Extract<WorkerRequest, { kind: "paint" | "objects" | "lane-highlight" }>,
    signal: AbortSignal | undefined,
  ): Promise<WorkerResponse | null> {
    if (disposed || signal?.aborted) return null;
    const answer = send(body);
    if (!signal) return answer;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        pending.delete(body.id);
        void send({ id: ++sequence, kind: "cancel", target: body.id });
        resolve(null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      answer.then(
        (response) => {
          signal.removeEventListener("abort", onAbort);
          resolve(signal.aborted ? null : response);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  const unwrap = <T>(response: WorkerResponse | null, pick: (r: WorkerResponse) => T): T | null => {
    if (!response) return null;
    if ("error" in response) {
      if (response.error === "cancelled") return null;
      throw new Error(response.error);
    }
    return pick(response);
  };

  return {
    async paint(z, x, y, template, signal) {
      const response = await request(
        {
          id: ++sequence,
          kind: "paint",
          z,
          x,
          y,
          streetTemplate: absoluteTemplate(template, base),
        },
        signal,
      );
      return unwrap(response, (r) => ("kind" in r && r.kind === "paint" ? r.bytes : null));
    },
    async objects(query, signal) {
      const response = await request(
        {
          id: ++sequence,
          kind: "objects",
          ...query,
          streetTemplate: query.streetTemplate
            ? absoluteTemplate(query.streetTemplate, base)
            : null,
          basemapTemplates: query.basemapTemplates.map((t) => absoluteTemplate(t, base)),
        },
        signal,
      );
      return unwrap(response, (r) => ("kind" in r && r.kind === "objects" ? r.instances : []));
    },
    async laneHighlight(query, signal) {
      const response = await request(
        {
          id: ++sequence,
          kind: "lane-highlight",
          ...query,
          streetTemplate: absoluteTemplate(query.streetTemplate, base),
        },
        signal,
      );
      return unwrap(response, (r) =>
        "kind" in r && r.kind === "lane-highlight"
          ? r.answer
          : ({ polygons: null, reason: "no-way" } as const),
      );
    },
    dispose() {
      disposed = true;
      worker?.terminate();
      worker = null;
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
    },
  };
}
