import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedWorkQueue, isWorkAdmissionError, WorkAdmissionError } from "./bounded-work-queue";

function deferred<T = string>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const later = () => Date.now() + 60_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe("BoundedWorkQueue", () => {
  it("refuses work beyond a finite ceiling while every worker is blocked", async () => {
    const queue = new BoundedWorkQueue({
      concurrency: 2,
      maxQueued: 3,
      maxPerClient: 100,
      cancelAbandoned: true,
    });
    const blocked = deferred();
    const operation = vi.fn(() => blocked.promise);
    const accepted = Array.from({ length: 5 }, (_, index) =>
      queue.run({ key: `k${index}`, client: `c${index}`, deadlineAt: later() }, operation),
    );
    const refused = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        queue.run({ key: `extra${index}`, client: `x${index}`, deadlineAt: later() }, operation),
      ),
    );
    await flush();
    expect(operation).toHaveBeenCalledTimes(2);
    expect(queue.active).toBe(2);
    expect(queue.queued).toBe(3);
    expect(refused.every((result) => result.status === "rejected")).toBe(true);
    expect(
      refused.every(
        (result) =>
          result.status === "rejected" &&
          isWorkAdmissionError(result.reason) &&
          result.reason.reason === "capacity",
      ),
    ).toBe(true);
    blocked.resolve("done");
    await expect(Promise.all(accepted)).resolves.toEqual(Array(5).fill("done"));
    expect(operation).toHaveBeenCalledTimes(5);
    expect(queue.active).toBe(0);
    expect(queue.queued).toBe(0);
  });

  it("charges each network separately and releases its budget when work settles", async () => {
    const queue = new BoundedWorkQueue({
      concurrency: 1,
      maxQueued: 100,
      maxPerClient: 2,
      cancelAbandoned: true,
    });
    const blocked = deferred();
    const first = queue.run(
      { key: "a", client: "net", deadlineAt: later() },
      () => blocked.promise,
    );
    const second = queue.run(
      { key: "b", client: "net", deadlineAt: later() },
      () => blocked.promise,
    );
    await expect(
      queue.run({ key: "c", client: "net", deadlineAt: later() }, () => blocked.promise),
    ).rejects.toMatchObject({ reason: "client-capacity" });
    const other = queue.run({ key: "c", client: "other", deadlineAt: later() }, async () => "ok");
    expect(queue.pendingFor("net")).toBe(2);
    blocked.reject(new Error("upstream failed"));
    await expect(first).rejects.toThrow("upstream failed");
    await expect(second).rejects.toThrow("upstream failed");
    await expect(other).resolves.toBe("ok");
    expect(queue.pendingFor("net")).toBe(0);
    expect(queue.pendingFor("other")).toBe(0);
    expect(queue.active).toBe(0);
  });

  it("drops queued work when its caller disconnects so another caller proceeds", async () => {
    const queue = new BoundedWorkQueue({
      concurrency: 1,
      maxQueued: 1,
      maxPerClient: 10,
      cancelAbandoned: true,
    });
    const blocked = deferred();
    const running = queue.run(
      { key: "running", client: "a", deadlineAt: later() },
      () => blocked.promise,
    );
    const disconnect = new AbortController();
    const abandonedOperation = vi.fn(async () => "never");
    const abandoned = queue.run(
      { key: "queued", client: "b", deadlineAt: later(), signal: disconnect.signal },
      abandonedOperation,
    );
    await expect(
      queue.run({ key: "next", client: "c", deadlineAt: later() }, async () => "next"),
    ).rejects.toBeInstanceOf(WorkAdmissionError);

    disconnect.abort(new Error("Client disconnected"));
    await expect(abandoned).rejects.toThrow("Client disconnected");
    expect(queue.queued).toBe(0);
    expect(queue.pendingFor("b")).toBe(0);

    const next = queue.run({ key: "next", client: "c", deadlineAt: later() }, async () => "next");
    blocked.resolve("running");
    await expect(running).resolves.toBe("running");
    await expect(next).resolves.toBe("next");
    expect(abandonedOperation).not.toHaveBeenCalled();
  });

  it("keeps shared work alive for the callers that remain", async () => {
    const queue = new BoundedWorkQueue({
      concurrency: 1,
      maxQueued: 1,
      maxPerClient: 10,
      cancelAbandoned: true,
    });
    const upstream = deferred();
    let signal: AbortSignal | undefined;
    const operation = vi.fn((workSignal: AbortSignal) => {
      signal = workSignal;
      return upstream.promise;
    });
    const leaving = new AbortController();
    const first = queue.run(
      { key: "shared", client: "a", deadlineAt: later(), signal: leaving.signal },
      operation,
    );
    const second = queue.run({ key: "shared", client: "b", deadlineAt: later() }, operation);
    await flush();
    leaving.abort(new Error("Client disconnected"));
    await expect(first).rejects.toThrow("Client disconnected");
    expect(signal?.aborted).toBe(false);
    upstream.resolve("shared result");
    await expect(second).resolves.toBe("shared result");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(queue.pendingFor("a")).toBe(0);
    expect(queue.pendingFor("b")).toBe(0);
  });

  it("keeps queued shared work when one of its callers leaves", async () => {
    const queue = new BoundedWorkQueue({
      concurrency: 1,
      maxQueued: 1,
      maxPerClient: 10,
      cancelAbandoned: true,
    });
    const blocker = deferred();
    const running = queue.run(
      { key: "first", client: "a", deadlineAt: later() },
      () => blocker.promise,
    );
    const leaving = new AbortController();
    const operation = vi.fn(async () => "shared");
    const left = queue.run(
      { key: "shared", client: "b", deadlineAt: later(), signal: leaving.signal },
      operation,
    );
    const stays = queue.run({ key: "shared", client: "c", deadlineAt: later() }, operation);
    leaving.abort(new Error("Client disconnected"));
    await expect(left).rejects.toThrow("Client disconnected");
    expect(queue.queued).toBe(1);
    blocker.resolve("first");
    await running;
    await expect(stays).resolves.toBe("shared");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("aborts running work once its last caller leaves and holds the slot until it settles", async () => {
    const queue = new BoundedWorkQueue({
      concurrency: 1,
      maxQueued: 1,
      maxPerClient: 10,
      cancelAbandoned: true,
    });
    const settled = deferred<void>();
    let signal: AbortSignal | undefined;
    const leaving = new AbortController();
    const abandoned = queue.run(
      { key: "k", client: "a", deadlineAt: later(), signal: leaving.signal },
      async (workSignal) => {
        signal = workSignal;
        await settled.promise;
        throw workSignal.reason;
      },
    );
    await flush();
    leaving.abort(new Error("Client disconnected"));
    await expect(abandoned).rejects.toThrow("Client disconnected");
    expect(signal?.aborted).toBe(true);
    expect(queue.active).toBe(1);

    const replacement = vi.fn(async () => "fresh");
    const next = queue.run({ key: "k", client: "b", deadlineAt: later() }, replacement);
    await flush();
    expect(replacement).not.toHaveBeenCalled();
    settled.resolve();
    await expect(next).resolves.toBe("fresh");
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(queue.active).toBe(0);
    expect(queue.pendingFor("a")).toBe(0);
  });

  it("lets later callers join running work that ignores cancellation", async () => {
    const queue = new BoundedWorkQueue({
      concurrency: 1,
      maxQueued: 0,
      maxPerClient: 10,
      cancelAbandoned: false,
    });
    const upstream = deferred();
    let signal: AbortSignal | undefined;
    const operation = vi.fn((workSignal: AbortSignal) => {
      signal = workSignal;
      return upstream.promise;
    });
    const leaving = new AbortController();
    const first = queue.run(
      { key: "k", client: "a", deadlineAt: later(), signal: leaving.signal },
      operation,
    );
    await flush();
    leaving.abort(new Error("Client disconnected"));
    await expect(first).rejects.toThrow("Client disconnected");
    const joined = queue.run({ key: "k", client: "b", deadlineAt: later() }, operation);
    upstream.resolve("cached later");
    await expect(joined).resolves.toBe("cached later");
    expect(signal?.aborted).toBe(false);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("counts queue time toward the deadline", async () => {
    vi.useFakeTimers();
    const queue = new BoundedWorkQueue({
      concurrency: 1,
      maxQueued: 5,
      maxPerClient: 10,
      cancelAbandoned: true,
    });
    const blocked = deferred();
    const running = queue.run(
      { key: "running", client: "a", deadlineAt: Date.now() + 60_000 },
      () => blocked.promise,
    );
    const waitingOperation = vi.fn(async () => "late");
    const waiting = queue.run(
      { key: "waiting", client: "b", deadlineAt: Date.now() + 1_000 },
      waitingOperation,
    );
    const outcome = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toMatchObject({ reason: "deadline" });
    expect(queue.queued).toBe(0);
    expect(queue.pendingFor("b")).toBe(0);
    blocked.resolve("running");
    await running;
    expect(waitingOperation).not.toHaveBeenCalled();
    await expect(
      queue.run({ key: "expired", client: "c", deadlineAt: Date.now() }, waitingOperation),
    ).rejects.toMatchObject({ reason: "deadline" });
  });

  it("rejects a caller that already disconnected without charging it", async () => {
    const queue = new BoundedWorkQueue({
      concurrency: 1,
      maxQueued: 1,
      maxPerClient: 1,
      cancelAbandoned: true,
    });
    const gone = new AbortController();
    gone.abort(new Error("Client disconnected"));
    const operation = vi.fn(async () => "x");
    await expect(
      queue.run({ key: "k", client: "a", deadlineAt: later(), signal: gone.signal }, operation),
    ).rejects.toThrow("Client disconnected");
    expect(operation).not.toHaveBeenCalled();
    expect(queue.pendingFor("a")).toBe(0);
  });
});
