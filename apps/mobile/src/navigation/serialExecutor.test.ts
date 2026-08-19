import { SerialExecutor } from "./serialExecutor";

/** A promise a test can settle by hand, to interleave tasks deliberately. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SerialExecutor", () => {
  it("starts and finishes tasks in submission order", async () => {
    const executor = new SerialExecutor();
    const log: string[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

    const runs = gates.map((gate, index) =>
      executor.run(async () => {
        log.push(`start-${index}`);
        await gate.promise;
        log.push(`finish-${index}`);
      }),
    );

    // Releasing out of order must not let a later task overtake an earlier one.
    gates[2].resolve();
    gates[1].resolve();
    gates[0].resolve();
    await Promise.all(runs);

    expect(log).toEqual(["start-0", "finish-0", "start-1", "finish-1", "start-2", "finish-2"]);
  });

  it("does not start a task before the previous one settles", async () => {
    const executor = new SerialExecutor();
    const gate = deferred<void>();
    const started: number[] = [];

    const first = executor.run(async () => {
      started.push(1);
      await gate.promise;
    });
    const second = executor.run(async () => {
      started.push(2);
    });

    await Promise.resolve();
    expect(started).toEqual([1]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(started).toEqual([1, 2]);
  });

  it("keeps order and continues after a rejection", async () => {
    const executor = new SerialExecutor();
    const log: string[] = [];

    const first = executor.run(async () => {
      log.push("1");
    });
    const second = executor.run(async () => {
      log.push("2");
      throw new Error("batch failed");
    });
    const third = executor.run(async () => {
      log.push("3");
    });

    await expect(second).rejects.toThrow("batch failed");
    await Promise.all([first, third]);
    expect(log).toEqual(["1", "2", "3"]);
  });

  it("continues after a task that throws synchronously", async () => {
    const executor = new SerialExecutor();
    const failing = executor.run(() => {
      throw new Error("immediate");
    });
    const following = executor.run(() => "ok");

    await expect(failing).rejects.toThrow("immediate");
    await expect(following).resolves.toBe("ok");
  });

  it("fails fast instead of deadlocking on a reentrant call", async () => {
    const executor = new SerialExecutor();

    const outcome = executor.run(async () => {
      await executor.run(async () => "inner");
      return "outer";
    });

    await expect(outcome).rejects.toThrow(/from inside a task/);
    // The queue is still usable afterwards.
    await expect(executor.run(async () => "next")).resolves.toBe("next");
  });

  it("resolves with the task's value", async () => {
    const executor = new SerialExecutor();

    await expect(executor.run(async () => 42)).resolves.toBe(42);
    await expect(executor.run(() => "sync")).resolves.toBe("sync");
  });

  it("drains everything queued so far", async () => {
    const executor = new SerialExecutor();
    const log: string[] = [];
    void executor.run(async () => {
      log.push("a");
    });
    executor
      .run(async () => {
        throw new Error("b failed");
      })
      .catch(() => undefined);
    void executor.run(async () => {
      log.push("c");
    });

    await executor.drain();

    expect(log).toEqual(["a", "c"]);
  });
});
