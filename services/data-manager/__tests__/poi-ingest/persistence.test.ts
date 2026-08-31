import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoiIngestResult } from "../../src/jobs/poi-ingest/types.js";

interface InsertCall {
  table: unknown;
  values?: unknown;
  returning?: unknown;
  onConflict?: { target: unknown; set: unknown };
}

interface UpdateCall {
  table: unknown;
  set: unknown;
  where: unknown;
}

interface SelectCall {
  fields: unknown;
  from?: unknown;
  where?: unknown;
  limit?: number;
}

const insertCalls: InsertCall[] = [];
const updateCalls: UpdateCall[] = [];
const selectCalls: SelectCall[] = [];
let returningResult: unknown[] = [];
let insertShouldThrow: Error | null = null;
let selectResult: unknown[] = [];

vi.mock("../../src/db/index.js", () => {
  return {
    db: {
      insert(table: unknown) {
        const call: InsertCall = { table };
        insertCalls.push(call);
        const builder = {
          values(values: unknown) {
            call.values = values;
            if (insertShouldThrow) {
              const err = insertShouldThrow;
              return {
                returning() {
                  return Promise.reject(err);
                },
                onConflictDoUpdate() {
                  return Promise.reject(err);
                },
                // biome-ignore lint/suspicious/noThenProperty: mocks Drizzle's thenable query builder
                then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
                  return Promise.reject(err).then(onFulfilled, onRejected);
                },
              };
            }
            return {
              returning(fields: unknown) {
                call.returning = fields;
                return Promise.resolve(returningResult);
              },
              onConflictDoUpdate(spec: { target: unknown; set: unknown }) {
                call.onConflict = spec;
                return Promise.resolve();
              },
              // biome-ignore lint/suspicious/noThenProperty: mocks Drizzle's thenable query builder
              then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
                return Promise.resolve().then(onFulfilled, onRejected);
              },
            };
          },
        };
        return builder;
      },
      update(table: unknown) {
        const call: UpdateCall = { table, set: undefined, where: undefined };
        updateCalls.push(call);
        return {
          set(values: unknown) {
            call.set = values;
            return {
              where(predicate: unknown) {
                call.where = predicate;
                return Promise.resolve();
              },
            };
          },
        };
      },
      select(fields: unknown) {
        const call: SelectCall = { fields };
        selectCalls.push(call);
        return {
          from(table: unknown) {
            call.from = table;
            return {
              where(predicate: unknown) {
                call.where = predicate;
                return {
                  limit(n: number) {
                    call.limit = n;
                    return Promise.resolve(selectResult);
                  },
                };
              },
            };
          },
        };
      },
    },
    sql: {},
  };
});

function baseResult(overrides: Partial<PoiIngestResult> = {}): PoiIngestResult {
  return {
    sourceId: "bnetza-ev",
    kind: "static",
    startedAt: "2026-05-24T00:00:00.000Z",
    finishedAt: "2026-05-24T00:00:01.000Z",
    durationMs: 1000,
    status: "ok",
    stages: [],
    staticRowCount: 42,
    staticHash: "deadbeef",
    ...overrides,
  };
}

beforeEach(() => {
  insertCalls.length = 0;
  updateCalls.length = 0;
  selectCalls.length = 0;
  returningResult = [];
  selectResult = [];
  insertShouldThrow = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createPoiJobRow", () => {
  it("inserts a running jobs row with the poi-ingest:<kind> kind and returns the id", async () => {
    const { createPoiJobRow } = await import("../../src/jobs/poi-ingest/persistence.js");
    returningResult = [{ id: "job-123" }];

    const id = await createPoiJobRow({
      sourceId: "bnetza-ev",
      kind: "bundled",
      triggeredBy: "cron",
      metadata: { reason: "scheduled" },
    });

    expect(id).toBe("job-123");
    expect(insertCalls).toHaveLength(1);
    const inserted = insertCalls[0]?.values as Record<string, unknown>;
    expect(inserted).toMatchObject({
      kind: "poi-ingest:bundled",
      status: "running",
      triggeredBy: "cron",
      metadata: { sourceId: "bnetza-ev", reason: "scheduled" },
    });
  });

  it("throws if no row was returned", async () => {
    const { createPoiJobRow } = await import("../../src/jobs/poi-ingest/persistence.js");
    returningResult = [];
    await expect(createPoiJobRow({ sourceId: "x", kind: "static" })).rejects.toThrow(
      /Failed to create/,
    );
  });
});

describe("finalizePoiJobRow", () => {
  it("issues an UPDATE with the status and finishedAt", async () => {
    const { finalizePoiJobRow } = await import("../../src/jobs/poi-ingest/persistence.js");
    const before = Date.now();
    await finalizePoiJobRow("job-xyz", "ok");
    const after = Date.now();

    expect(updateCalls).toHaveLength(1);
    const setVals = updateCalls[0]?.set as { status: string; finishedAt: Date };
    expect(setVals.status).toBe("ok");
    expect(setVals.finishedAt).toBeInstanceOf(Date);
    expect(setVals.finishedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(setVals.finishedAt.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("upsertPoiFeedState", () => {
  it("updates the static side on a successful static run", async () => {
    const { upsertPoiFeedState } = await import("../../src/jobs/poi-ingest/persistence.js");

    await upsertPoiFeedState({
      sourceId: "bnetza-ev",
      domain: "ev-charging",
      result: baseResult({ kind: "static", staticRowCount: 42, staticHash: "h1" }),
    });

    expect(insertCalls).toHaveLength(1);
    const call = insertCalls[0];
    const vals = call?.values as Record<string, unknown>;
    expect(vals).toMatchObject({
      sourceId: "bnetza-ev",
      domain: "ev-charging",
      status: "active",
      consecutiveFailures: 0,
      lastError: null,
      lastStaticRowCount: 42,
      lastStaticHash: "h1",
    });
    expect(vals.lastStaticIngestAt).toBeInstanceOf(Date);
    expect(vals.lastLiveIngestAt).toBeUndefined();

    expect(call?.onConflict).toBeDefined();
    const update = call?.onConflict?.set as Record<string, unknown>;
    expect(update.status).toBe("active");
    expect(update.lastStaticHash).toBe("h1");
    expect(update.lastStaticRowCount).toBe(42);
    expect(update.lastError).toBeNull();
    // consecutiveFailures uses a server-side SQL fragment (0 on success).
    expect(update.consecutiveFailures).toBeDefined();
  });

  it("increments consecutive_failures on a static failure", async () => {
    const { upsertPoiFeedState } = await import("../../src/jobs/poi-ingest/persistence.js");

    await upsertPoiFeedState({
      sourceId: "bnetza-ev",
      domain: "ev-charging",
      result: baseResult({
        kind: "static",
        status: "error",
        error: { message: "fetch failed", stack: "stack-trace" },
      }),
    });

    const call = insertCalls[0];
    const vals = call?.values as Record<string, unknown>;
    expect(vals.status).toBe("failed");
    expect(vals.consecutiveFailures).toBe(1);
    expect(vals.lastError).toEqual({ message: "fetch failed", stack: "stack-trace" });

    const update = call?.onConflict?.set as Record<string, unknown>;
    expect(update.status).toBe("failed");
    expect(update.lastError).toEqual({ message: "fetch failed", stack: "stack-trace" });
    // Should be a SQL fragment for `consecutive_failures + 1`, not a literal.
    expect(typeof update.consecutiveFailures).toBe("object");
  });

  it("scrubs the error message and stack stored in feed state", async () => {
    const { upsertPoiFeedState } = await import("../../src/jobs/poi-ingest/persistence.js");
    const sourceError = {
      message: "fetch https://user:STATE-PASSWORD@example.org/feed?token=STATE-TOKEN failed",
      stack: "at fetch (https://example.org/feed?key=STACK-STATE-TOKEN)",
    };

    await upsertPoiFeedState({
      sourceId: "bnetza-ev",
      domain: "ev-charging",
      result: baseResult({ kind: "static", status: "error", error: sourceError }),
    });

    const persisted = (insertCalls[0]?.values as Record<string, unknown>).lastError;
    expect(JSON.stringify(persisted)).not.toMatch(
      /STATE-PASSWORD|STATE-TOKEN|STACK-STATE-TOKEN|user/,
    );
    expect(JSON.stringify(persisted)).toContain("example.org");
    expect(sourceError.message).toContain("STATE-TOKEN");
  });

  it("falls back to the last failing stage's error when result.error is absent", async () => {
    const { upsertPoiFeedState } = await import("../../src/jobs/poi-ingest/persistence.js");

    await upsertPoiFeedState({
      sourceId: "x",
      domain: "ev-charging",
      result: baseResult({
        kind: "static",
        status: "error",
        error: undefined,
        stages: [
          {
            stage: "parse",
            status: "ok",
            startedAt: "x",
            finishedAt: "x",
            durationMs: 0,
          },
          {
            stage: "validate",
            status: "error",
            startedAt: "x",
            finishedAt: "x",
            durationMs: 0,
            error: { message: "bad row" },
          },
        ],
      }),
    });

    const vals = insertCalls[0]?.values as Record<string, unknown>;
    expect(vals.lastError).toEqual({ message: "bad row" });
  });

  it("updates the live side on a successful live run", async () => {
    const { upsertPoiFeedState } = await import("../../src/jobs/poi-ingest/persistence.js");

    await upsertPoiFeedState({
      sourceId: "utmc-newcastle",
      domain: "parking",
      result: baseResult({
        kind: "live",
        staticRowCount: undefined,
        staticHash: undefined,
        liveRowCount: 17,
      }),
    });

    const call = insertCalls[0];
    const vals = call?.values as Record<string, unknown>;
    expect(vals.lastLiveRowCount).toBe(17);
    expect(vals.lastLiveIngestAt).toBeInstanceOf(Date);
    expect(vals.lastStaticRowCount).toBeUndefined();
    expect(vals.lastStaticIngestAt).toBeUndefined();
    expect(vals.lastStaticHash).toBeUndefined();

    const update = call?.onConflict?.set as Record<string, unknown>;
    expect(update.lastLiveRowCount).toBe(17);
    expect(update.lastStaticRowCount).toBeUndefined();
  });

  it("updates both static and live sides on a successful bundled run", async () => {
    const { upsertPoiFeedState } = await import("../../src/jobs/poi-ingest/persistence.js");

    await upsertPoiFeedState({
      sourceId: "src",
      domain: "ev-charging",
      result: baseResult({
        kind: "bundled",
        staticRowCount: 200,
        staticHash: "h2",
        liveRowCount: 50,
        skippedStaticSwap: false,
      }),
    });

    const vals = insertCalls[0]?.values as Record<string, unknown>;
    expect(vals.lastStaticRowCount).toBe(200);
    expect(vals.lastStaticHash).toBe("h2");
    expect(vals.lastLiveRowCount).toBe(50);

    const update = insertCalls[0]?.onConflict?.set as Record<string, unknown>;
    expect(update.lastStaticRowCount).toBe(200);
    expect(update.lastLiveRowCount).toBe(50);
    expect(update.lastStaticHash).toBe("h2");
  });

  it("leaves the static side untouched on a bundled-skip run", async () => {
    const { upsertPoiFeedState } = await import("../../src/jobs/poi-ingest/persistence.js");

    await upsertPoiFeedState({
      sourceId: "src",
      domain: "ev-charging",
      result: baseResult({
        kind: "bundled",
        staticRowCount: 200,
        staticHash: "h-current",
        liveRowCount: 50,
        skippedStaticSwap: true,
      }),
      previousStaticHash: "h-current",
      previousStaticRowCount: 200,
    });

    const vals = insertCalls[0]?.values as Record<string, unknown>;
    // First-insert path: preserves previous values for internal consistency.
    expect(vals.lastStaticHash).toBe("h-current");
    expect(vals.lastStaticRowCount).toBe(200);
    expect(vals.lastStaticIngestAt).toBeUndefined();
    // Live side was still touched.
    expect(vals.lastLiveRowCount).toBe(50);

    // The conflict update must NOT include lastStaticIngestAt / hash / row count.
    const update = insertCalls[0]?.onConflict?.set as Record<string, unknown>;
    expect(update.lastStaticIngestAt).toBeUndefined();
    expect(update.lastStaticHash).toBeUndefined();
    expect(update.lastStaticRowCount).toBeUndefined();
    expect(update.lastLiveRowCount).toBe(50);
    expect(update.lastLiveIngestAt).toBeInstanceOf(Date);
  });

  it("on a bundled failure with skipped static swap, leaves static side alone but marks failed", async () => {
    const { upsertPoiFeedState } = await import("../../src/jobs/poi-ingest/persistence.js");

    await upsertPoiFeedState({
      sourceId: "src",
      domain: "ev-charging",
      result: baseResult({
        kind: "bundled",
        status: "error",
        staticHash: undefined,
        skippedStaticSwap: true,
        error: { message: "write-live died" },
      }),
      previousStaticHash: "h-prev",
      previousStaticRowCount: 100,
    });

    const vals = insertCalls[0]?.values as Record<string, unknown>;
    expect(vals.status).toBe("failed");
    expect(vals.consecutiveFailures).toBe(1);
    expect(vals.lastError).toEqual({ message: "write-live died" });
    // Static side preserved from previous values.
    expect(vals.lastStaticHash).toBe("h-prev");
    expect(vals.lastStaticRowCount).toBe(100);
    expect(vals.lastStaticIngestAt).toBeUndefined();

    const update = insertCalls[0]?.onConflict?.set as Record<string, unknown>;
    expect(update.lastStaticIngestAt).toBeUndefined();
    expect(update.lastStaticHash).toBeUndefined();
  });
});

describe("getLastPoiFeedState", () => {
  it("returns the row when present", async () => {
    const { getLastPoiFeedState } = await import("../../src/jobs/poi-ingest/persistence.js");
    const row = {
      lastStaticHash: "h1",
      lastStaticRowCount: 42,
      lastStaticIngestAt: new Date("2026-05-24T00:00:00.000Z"),
      consecutiveFailures: 0,
      status: "active",
    };
    selectResult = [row];

    const result = await getLastPoiFeedState("bnetza-ev");
    expect(result).toEqual(row);
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]?.limit).toBe(1);
  });

  it("returns undefined when the source has never been ingested", async () => {
    const { getLastPoiFeedState } = await import("../../src/jobs/poi-ingest/persistence.js");
    selectResult = [];
    const result = await getLastPoiFeedState("unknown");
    expect(result).toBeUndefined();
  });
});
