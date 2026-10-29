import { describe, expect, it, vi } from "vitest";
import {
  createNotablePlacesOperationLock,
  createSearchIndexOperationLock,
} from "../../src/jobs/search-index/operation-lock.js";

const factories = [
  ["search index", createSearchIndexOperationLock],
  ["notable places", createNotablePlacesOperationLock],
] as const;

function healthyConnection() {
  return {
    unsafe: vi.fn().mockResolvedValue([]),
    release: vi.fn(),
  };
}

describe.each(factories)("%s operation lock", (_name, createLock) => {
  it("rejects a second in-process build and releases the advisory lock", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const connection = healthyConnection();
    const lock = createLock({
      reserve: vi.fn().mockResolvedValue(connection),
    } as never);
    const first = lock.run(async () => {
      await gate;
      return "done";
    });
    await expect(lock.run(async () => "second")).rejects.toThrow(/already running/);
    releaseFirst();
    await expect(first).resolves.toBe("done");
    expect(connection.unsafe.mock.calls[0]?.[0]).toContain("pg_advisory_lock");
    expect(connection.unsafe.mock.calls[1]?.[0]).toContain("pg_advisory_unlock");
    expect(connection.release).toHaveBeenCalledOnce();
    expect(lock.inFlight).toBe(false);
  });

  it("admits a later build after the advisory unlock fails", async () => {
    const unlockError = new Error("unlock failed");
    const faulty = {
      unsafe: vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(unlockError),
      release: vi.fn(),
    };
    const healthy = healthyConnection();
    const reserve = vi.fn().mockResolvedValueOnce(faulty).mockResolvedValueOnce(healthy);
    const lock = createLock({ reserve } as never);

    await expect(lock.run(async () => "first")).rejects.toBe(unlockError);
    expect(faulty.release).toHaveBeenCalledOnce();
    expect(lock.inFlight).toBe(false);

    await expect(lock.run(async () => "second")).resolves.toBe("second");
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(healthy.release).toHaveBeenCalledOnce();
  });

  it("admits a later build after the connection release throws", async () => {
    const releaseError = new Error("release failed");
    const faulty = {
      unsafe: vi.fn().mockResolvedValue([]),
      release: vi.fn(() => {
        throw releaseError;
      }),
    };
    const healthy = healthyConnection();
    const reserve = vi.fn().mockResolvedValueOnce(faulty).mockResolvedValueOnce(healthy);
    const lock = createLock({ reserve } as never);

    await expect(lock.run(async () => "first")).rejects.toBe(releaseError);
    expect(faulty.unsafe.mock.calls[1]?.[0]).toContain("pg_advisory_unlock");
    expect(faulty.release).toHaveBeenCalledOnce();
    expect(lock.inFlight).toBe(false);

    await expect(lock.run(async () => "second")).resolves.toBe("second");
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it("stays busy while cleanup is pending, then admits a later build once it fails", async () => {
    const unlockError = new Error("unlock failed");
    let failUnlock!: (error: Error) => void;
    const pendingUnlock = new Promise<never>((_resolve, reject) => {
      failUnlock = reject;
    });
    const faulty = {
      unsafe: vi.fn().mockResolvedValueOnce([]).mockReturnValueOnce(pendingUnlock),
      release: vi.fn(),
    };
    const healthy = healthyConnection();
    const reserve = vi.fn().mockResolvedValueOnce(faulty).mockResolvedValueOnce(healthy);
    const lock = createLock({ reserve } as never);

    const first = lock.run(async () => "first");
    const firstOutcome = first.catch((error: unknown) => error);
    await vi.waitFor(() => expect(faulty.unsafe).toHaveBeenCalledTimes(2));
    expect(lock.inFlight).toBe(true);
    await expect(lock.run(async () => "during cleanup")).rejects.toThrow(/already running/);
    expect(reserve).toHaveBeenCalledOnce();

    failUnlock(unlockError);
    await expect(firstOutcome).resolves.toBe(unlockError);
    expect(lock.inFlight).toBe(false);
    await expect(lock.run(async () => "after cleanup")).resolves.toBe("after cleanup");
  });

  it("admits a later build after the operation rejects", async () => {
    const operationError = new Error("operation failed");
    const connection = healthyConnection();
    const lock = createLock({
      reserve: vi.fn().mockResolvedValue(connection),
    } as never);

    await expect(
      lock.run(async () => {
        throw operationError;
      }),
    ).rejects.toBe(operationError);
    expect(connection.release).toHaveBeenCalledOnce();
    expect(lock.inFlight).toBe(false);
    await expect(lock.run(async () => "second")).resolves.toBe("second");
  });

  it("admits a later build after reservation fails", async () => {
    const reserveError = new Error("reserve failed");
    const healthy = healthyConnection();
    const reserve = vi.fn().mockRejectedValueOnce(reserveError).mockResolvedValueOnce(healthy);
    const lock = createLock({ reserve } as never);

    await expect(lock.run(async () => "first")).rejects.toBe(reserveError);
    expect(lock.inFlight).toBe(false);
    await expect(lock.run(async () => "second")).resolves.toBe("second");
    expect(reserve).toHaveBeenCalledTimes(2);
  });
});
