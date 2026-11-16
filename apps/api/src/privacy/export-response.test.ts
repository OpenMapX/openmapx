import { PassThrough, type Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportDeadlineError, pumpExport } from "./export-response.js";

const CHUNK = Buffer.alloc(16 * 1024, 1);

/** Writes chunks for as long as the sink accepts them, honouring backpressure,
 * and rejects once the sink fails, as the real archive writer does. */
function endlessExport(pauseMs = 0) {
  return {
    filename: "export.zip",
    dispose: vi.fn(async () => {}),
    write: (sink: Writable) =>
      new Promise<void>((_resolve, reject) => {
        let stopped = false;
        const stop = () => {
          stopped = true;
          reject(new Error("sink closed"));
        };
        sink.once("close", stop);
        sink.once("error", () => undefined);
        const next = () => {
          if (stopped) return;
          if (sink.write(CHUNK)) setTimeout(next, pauseMs);
          else sink.once("drain", next);
        };
        next();
      }),
  };
}

function shortExport() {
  return {
    filename: "export.zip",
    dispose: vi.fn(async () => {}),
    write: async (sink: Writable) => {
      sink.write(CHUNK);
      sink.end(CHUNK);
    },
  };
}

function deadlineOf(body: PassThrough): Promise<unknown> {
  return new Promise((resolve) => body.once("error", resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pumpExport", () => {
  it("ends the archive when the response closed before streaming began", async () => {
    const response = new PassThrough();
    response.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    let sink: Writable | undefined;
    const dispose = vi.fn(async () => {});
    const { body, delivered } = pumpExport(
      {
        filename: "export.zip",
        // Waits for the sink to fail, as the real archive writer does.
        write: (target) =>
          new Promise<void>((_resolve, reject) => {
            sink = target;
            if (target.destroyed) reject(new Error("sink closed"));
            else target.once("close", () => reject(new Error("sink closed")));
          }),
        dispose,
      },
      response,
    );
    // Fastify listens on the body once it is sent; stand in for it here.
    body.on("error", () => undefined);
    expect(await delivered).toBe(false);
    expect(sink?.destroyed).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("ends a download whose client stops reading", async () => {
    // A response nobody reads: once its small buffer is full, no more bytes move.
    const response = new PassThrough({ highWaterMark: 1024 });
    const prepared = endlessExport();
    const { body, delivered } = pumpExport(prepared, response, { idleMs: 50, totalMs: 60_000 });
    const reason = deadlineOf(body);
    body.pipe(response);
    expect(await delivered).toBe(false);
    expect(await reason).toEqual(new ExportDeadlineError("idle"));
    expect(response.destroyed).toBe(true);
    expect(prepared.dispose).toHaveBeenCalledTimes(1);
  });

  it("ends a download that runs past the longest download time", async () => {
    // The client reads every byte, but the archive only trickles in.
    const response = new PassThrough();
    response.resume();
    const prepared = endlessExport(5);
    const { body, delivered } = pumpExport(prepared, response, { idleMs: 60_000, totalMs: 100 });
    const reason = deadlineOf(body);
    body.pipe(response);
    expect(await delivered).toBe(false);
    expect(await reason).toEqual(new ExportDeadlineError("total"));
    expect(prepared.dispose).toHaveBeenCalledTimes(1);
  });

  it("delivers a normal download and leaves no timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = new PassThrough();
    const read = new Promise<number>((resolve) => {
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
      });
      response.once("end", () => resolve(bytes));
    });
    const { body, delivered } = pumpExport(shortExport(), response, {
      idleMs: 1_000,
      totalMs: 5_000,
    });
    // Both deadlines are armed and neither keeps the process alive.
    expect(vi.getTimerCount()).toBe(2);
    body.pipe(response);
    expect(await delivered).toBe(true);
    expect(await read).toBe(CHUNK.byteLength * 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not keep the process alive while a download runs", () => {
    const created: Array<ReturnType<typeof setTimeout>> = [];
    const original = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const timer = original(...args);
      created.push(timer);
      return timer;
    }) as typeof setTimeout);
    try {
      const response = new PassThrough();
      const { body } = pumpExport(
        { filename: "export.zip", dispose: async () => {}, write: () => new Promise(() => {}) },
        response,
      );
      expect(created).toHaveLength(2);
      for (const timer of created) expect(timer.hasRef()).toBe(false);
      body.destroy();
    } finally {
      spy.mockRestore();
    }
  });
});
