import { accuracyBucket, EMPTY_PROBE_STATE, FeasibilityRepository } from "./feasibilityRepository";
import { migrateSessionSchema } from "./migrations";
import { openTestDatabase } from "./testing/nodeSqliteDatabase";

/**
 * These run against a real in-memory SQLite engine rather than a mock, so the
 * schema, the migration, the CHECK constraint and the transaction rollback are
 * all genuinely exercised.
 */
async function freshDatabase() {
  const database = openTestDatabase();
  await migrateSessionSchema(database, 1_000);
  return database;
}

describe("feasibility probe schema", () => {
  it("stores no column that could hold a coordinate", async () => {
    const database = await freshDatabase();
    const columns = await database.getAllAsync<{ name: string }>(
      "PRAGMA table_info(feasibility_probe)",
    );
    const names = columns.map((column) => column.name.toLowerCase());
    for (const forbidden of ["lat", "latitude", "lng", "lon", "longitude", "coords", "geometry"]) {
      expect(names).not.toContain(forbidden);
    }
    await database.closeAsync();
  });

  it("refuses a second probe row", async () => {
    const database = await freshDatabase();
    await database.runAsync(
      `INSERT INTO feasibility_probe (id, callback_count, accepted_fix_count, rejected_fix_count, pending_audio_probe, updated_at_ms)
       VALUES (1, 0, 0, 0, 0, 1)`,
    );
    await expect(
      database.runAsync(
        `INSERT INTO feasibility_probe (id, callback_count, accepted_fix_count, rejected_fix_count, pending_audio_probe, updated_at_ms)
         VALUES (2, 0, 0, 0, 0, 1)`,
      ),
    ).rejects.toThrow();
    await database.closeAsync();
  });
});

describe("FeasibilityRepository", () => {
  it("returns empty state before anything is written", async () => {
    const database = await freshDatabase();
    await expect(new FeasibilityRepository(database).read()).resolves.toEqual(EMPTY_PROBE_STATE);
    await database.closeAsync();
  });

  it("survives repository recreation without losing or regressing counters", async () => {
    const database = await freshDatabase();
    const first = new FeasibilityRepository(database);
    await first.commit((current) => ({
      ...current,
      callbackCount: current.callbackCount + 1,
      acceptedFixCount: 3,
      lastTimestampMs: 1_700_000_000_000,
      lastAccuracyBucket: "good",
      updatedAtMs: 1_700_000_000_000,
    }));
    await first.commit((current) => ({
      ...current,
      callbackCount: current.callbackCount + 1,
      acceptedFixCount: current.acceptedFixCount + 2,
      updatedAtMs: 1_700_000_001_000,
    }));

    // A brand new repository models the process being recreated between
    // background callbacks.
    const recreated = new FeasibilityRepository(database);
    const state = await recreated.read();
    expect(state.callbackCount).toBe(2);
    expect(state.acceptedFixCount).toBe(5);
    expect(state.lastTimestampMs).toBe(1_700_000_000_000);
    expect(state.lastAccuracyBucket).toBe("good");
    await database.closeAsync();
  });

  it("round-trips every field, including the audio probe flag", async () => {
    const database = await freshDatabase();
    const repository = new FeasibilityRepository(database);
    await repository.commit((current) => ({
      ...current,
      callbackCount: 7,
      acceptedFixCount: 6,
      rejectedFixCount: 1,
      lastTimestampMs: 42,
      lastAccuracyBucket: "poor",
      lastCallbackGapMs: 1_200,
      maxCallbackGapMs: 9_000,
      lastErrorCode: "E_TEST",
      pendingAudioProbe: true,
      audioResultCode: "spoken",
      updatedAtMs: 99,
    }));
    expect(await repository.read()).toEqual({
      callbackCount: 7,
      acceptedFixCount: 6,
      rejectedFixCount: 1,
      lastTimestampMs: 42,
      lastAccuracyBucket: "poor",
      lastCallbackGapMs: 1_200,
      maxCallbackGapMs: 9_000,
      lastErrorCode: "E_TEST",
      pendingAudioProbe: true,
      audioResultCode: "spoken",
      updatedAtMs: 99,
    });
    await database.closeAsync();
  });

  it("rejects a mutation that would regress the callback counter", async () => {
    const database = await freshDatabase();
    const repository = new FeasibilityRepository(database);
    await repository.commit((current) => ({ ...current, callbackCount: 5, updatedAtMs: 1 }));
    await expect(
      repository.commit((current) => ({ ...current, callbackCount: 1, updatedAtMs: 2 })),
    ).rejects.toThrow(/must not regress/);
    // The refused transaction must leave the previous state completely intact.
    expect((await repository.read()).callbackCount).toBe(5);
    await database.closeAsync();
  });

  it("leaves state untouched when the mutation throws mid-transaction", async () => {
    const database = await freshDatabase();
    const repository = new FeasibilityRepository(database);
    await repository.commit((current) => ({ ...current, callbackCount: 2, updatedAtMs: 1 }));
    await expect(
      repository.commit(() => {
        throw new Error("engine exploded");
      }),
    ).rejects.toThrow("engine exploded");
    expect((await repository.read()).callbackCount).toBe(2);
    await database.closeAsync();
  });

  it("clears everything on reset", async () => {
    const database = await freshDatabase();
    const repository = new FeasibilityRepository(database);
    await repository.commit((current) => ({ ...current, callbackCount: 3, updatedAtMs: 1 }));
    await repository.reset();
    expect(await repository.read()).toEqual(EMPTY_PROBE_STATE);
    await database.closeAsync();
  });
});

describe("accuracyBucket", () => {
  it.each([
    [0, "excellent"],
    [5, "excellent"],
    [5.1, "good"],
    [15, "good"],
    [40, "fair"],
    [100, "poor"],
    [101, "unusable"],
    [-1, "unusable"],
    [Number.NaN, "unusable"],
    [Number.POSITIVE_INFINITY, "unusable"],
  ])("maps %p metres to %s", (accuracy, expected) => {
    expect(accuracyBucket(accuracy)).toBe(expected);
  });
});
