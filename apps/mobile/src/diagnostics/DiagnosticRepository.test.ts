import { migrateSessionSchema } from "../storage/migrations";
import { SessionRepository } from "../storage/SessionRepository";
import { openTestDatabase } from "../storage/testing/nodeSqliteDatabase";
import {
  DIAGNOSTIC_FIELDS,
  DiagnosticRepository,
  type DiagnosticType,
  durationBucketMs,
  MAX_DIAGNOSTIC_VALUE_LENGTH,
} from "./DiagnosticRepository";

const NOW = 1_700_000_100_000;

async function harness() {
  const database = openTestDatabase();
  await migrateSessionSchema(database, 1_000);
  const repository = new SessionRepository(database);
  return {
    diagnostics: new DiagnosticRepository(repository, () => NOW),
    repository,
    close: () => database.closeAsync(),
  };
}

describe("DiagnosticRepository", () => {
  it("keeps declared fields", async () => {
    const { diagnostics, close } = await harness();

    const outcome = await diagnostics.record("location.batch", { accepted: 3, rejected: 1 });

    expect(outcome).toEqual({ written: true, rejected: [] });
    expect((await diagnostics.list())[0].fields).toEqual({ accepted: 3, rejected: 1 });
    await close();
  });

  describe("rejects rather than redacts", () => {
    it.each([
      ["coordinates", { coords: [8.68, 50.11] }],
      ["a latitude", { lat: 50.11 }],
      ["a longitude", { lng: 8.68 }],
      ["geometry", { geometry: [[8.68, 50.11]] }],
      ["a route", { route: { distance: 1 } }],
      ["a token", { token: "tok_secret" }],
      ["a cookie", { cookie: "session=abc" }],
      ["cue text", { text: "Turn left onto Hauptstraße" }],
      ["a URL", { url: "https://openmapx.com/route?to=50.11,8.68" }],
      ["a nested payload", { payload: { coords: [8.68, 50.11] } }],
    ])("refuses %s", async (_label, fields) => {
      const { diagnostics, close } = await harness();

      const outcome = await diagnostics.record("location.batch", fields);

      expect(outcome.rejected).toEqual(Object.keys(fields));
      const stored = (await diagnostics.list())[0].fields;
      expect(Object.keys(stored)).toEqual(["droppedFieldCount"]);
      expect(JSON.stringify(stored)).not.toContain("50.11");
      expect(JSON.stringify(stored)).not.toContain("tok_secret");
      await close();
    });

    it("refuses an object even under a declared field name", async () => {
      const { diagnostics, close } = await harness();

      const outcome = await diagnostics.record("location.batch", {
        accepted: { nested: [8.68, 50.11] },
      });

      expect(outcome.rejected).toEqual(["accepted"]);
      await close();
    });

    it("records that fields were dropped without naming them", async () => {
      const { diagnostics, close } = await harness();

      await diagnostics.record("engine.timing", { stage: "tick", secretName: "x", other: "y" });

      const stored = (await diagnostics.list())[0].fields;
      expect(stored).toEqual({ stage: "tick", droppedFieldCount: 2 });
      expect(JSON.stringify(stored)).not.toContain("secretName");
      await close();
    });

    it("refuses an unknown event type entirely", async () => {
      const { diagnostics, close } = await harness();

      const outcome = await diagnostics.record("route.exported" as DiagnosticType, { a: 1 });

      expect(outcome.written).toBe(false);
      expect(await diagnostics.list()).toEqual([]);
      await close();
    });
  });

  it("truncates a long string rather than storing it whole", async () => {
    const { diagnostics, close } = await harness();

    await diagnostics.record("typed.error", { code: "c".repeat(500) });

    const stored = (await diagnostics.list())[0].fields as { code: string };
    expect(stored.code).toHaveLength(MAX_DIAGNOSTIC_VALUE_LENGTH);
    await close();
  });

  it("drops a non-finite number", async () => {
    const { diagnostics, close } = await harness();

    const outcome = await diagnostics.record("engine.timing", { iterations: Number.NaN });

    expect(outcome.rejected).toEqual(["iterations"]);
    await close();
  });

  it("never throws, even when storage fails", async () => {
    const { diagnostics, repository, close } = await harness();
    jest.spyOn(repository, "recordDiagnostic").mockRejectedValue(new Error("disk full"));

    await expect(diagnostics.record("engine.timing", { stage: "tick" })).resolves.toEqual({
      written: false,
      rejected: [],
    });
    await close();
  });

  it("declares only fields that carry no position or identity", () => {
    const forbidden = [
      "lat",
      "lng",
      "lon",
      "coords",
      "geometry",
      "route",
      "token",
      "cookie",
      "text",
      "url",
      "name",
      "sessionid",
      "instruction",
    ];

    for (const fields of Object.values(DIAGNOSTIC_FIELDS)) {
      for (const field of fields) {
        expect(forbidden).not.toContain(field.toLowerCase());
      }
    }
  });

  it("stays within its bounded storage", async () => {
    const { diagnostics, close } = await harness();
    for (let index = 0; index < 5_100; index += 1) {
      await diagnostics.record("engine.timing", { iterations: index });
    }

    expect((await diagnostics.list()).length).toBeLessThanOrEqual(5_000);
    await close();
  });

  it("clears everything on request", async () => {
    const { diagnostics, close } = await harness();
    await diagnostics.record("engine.timing", { stage: "tick" });

    await diagnostics.clear();

    expect(await diagnostics.list()).toEqual([]);
    await close();
  });
});

describe("durationBucketMs", () => {
  it.each([
    [0, 10],
    [9, 10],
    [11, 25],
    [400, 500],
    [9_000, 10_000],
    [120_000, 30_000],
  ])("buckets %ims as %i", (input, expected) => {
    expect(durationBucketMs(input)).toBe(expected);
  });

  it("reports an impossible duration rather than guessing", () => {
    expect(durationBucketMs(-1)).toBe(-1);
    expect(durationBucketMs(Number.NaN)).toBe(-1);
  });
});
