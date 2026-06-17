import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unsafe = vi.fn();
vi.mock("./db", () => ({ sql: { unsafe: (...args: unknown[]) => unsafe(...args) } }));

function isMatviewCheck(query: string): boolean {
  return query.includes("pg_matviews");
}

beforeEach(() => {
  unsafe.mockReset();
  // Matview check → exists; any other query → empty result set.
  unsafe.mockImplementation(async (query: string) =>
    isMatviewCheck(query) ? [{ exists: true }] : [],
  );
});

afterEach(() => {
  vi.resetModules();
});

describe("service_days matview existence cache", () => {
  it("checks pg_matviews once per schema across repeated departure queries", async () => {
    vi.resetModules();
    const q = await import("./queries");
    await q.getDepartures("gtfs_ch", "stop-1", 60);
    await q.getDepartures("gtfs_ch", "stop-1", 60);
    await q.getArrivals("gtfs_ch", "stop-1", 60);

    const matviewCalls = unsafe.mock.calls.filter(([query]) => isMatviewCheck(query as string));
    expect(matviewCalls).toHaveLength(1);
  });

  it("re-checks pg_matviews after invalidateSchemaCaches", async () => {
    vi.resetModules();
    const q = await import("./queries");
    await q.getDepartures("gtfs_ch", "stop-1", 60);
    q.invalidateSchemaCaches("gtfs_ch");
    await q.getDepartures("gtfs_ch", "stop-1", 60);

    const matviewCalls = unsafe.mock.calls.filter(([query]) => isMatviewCheck(query as string));
    expect(matviewCalls).toHaveLength(2);
  });

  it("caches the negative result (matview missing → empty, no re-check)", async () => {
    unsafe.mockImplementation(async (query: string) =>
      isMatviewCheck(query) ? [{ exists: false }] : [],
    );
    vi.resetModules();
    const q = await import("./queries");
    expect(await q.getDepartures("gtfs_none", "stop-1", 60)).toEqual([]);
    expect(await q.getDepartures("gtfs_none", "stop-1", 60)).toEqual([]);

    const matviewCalls = unsafe.mock.calls.filter(([query]) => isMatviewCheck(query as string));
    expect(matviewCalls).toHaveLength(1);
  });
});
