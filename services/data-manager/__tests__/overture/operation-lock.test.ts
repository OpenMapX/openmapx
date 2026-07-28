import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unsafe: vi.fn(),
  release: vi.fn(),
  reserve: vi.fn(),
}));

vi.mock("../../src/db/index.js", () => ({
  sql: { reserve: mocks.reserve },
}));

import { withOvertureOperationLock } from "../../src/jobs/overture/operation-lock.js";

beforeEach(() => {
  mocks.unsafe.mockReset().mockResolvedValue([]);
  mocks.release.mockReset();
  mocks.reserve.mockReset().mockResolvedValue({
    unsafe: mocks.unsafe,
    release: mocks.release,
  });
});

describe("withOvertureOperationLock", () => {
  it("holds one session advisory lock around the operation", async () => {
    const operation = vi.fn(async () => "done");
    await expect(withOvertureOperationLock(operation)).resolves.toBe("done");
    expect(mocks.unsafe.mock.calls[0]?.[0]).toContain("pg_advisory_lock");
    expect(mocks.unsafe.mock.calls[1]?.[0]).toContain("pg_advisory_unlock");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("unlocks and releases the reserved connection when the operation fails", async () => {
    await expect(
      withOvertureOperationLock(async () => {
        throw new Error("failed operation");
      }),
    ).rejects.toThrow("failed operation");
    expect(mocks.unsafe.mock.calls[1]?.[0]).toContain("pg_advisory_unlock");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
