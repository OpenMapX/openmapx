import { describe, expect, it, vi } from "vitest";
import { createSearchIndexOperationLock } from "../../src/jobs/search-index/operation-lock.js";

describe("search index operation lock", () => {
  it("rejects a second in-process build and releases the advisory lock", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const connection = {
      unsafe: vi.fn().mockResolvedValue([]),
      release: vi.fn(),
    };
    const lock = createSearchIndexOperationLock({
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
  });
});
