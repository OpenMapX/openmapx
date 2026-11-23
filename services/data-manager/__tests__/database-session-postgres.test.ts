import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type PostgisFixture, startPostgis } from "./helpers/postgis-testcontainer.js";

const integration = describe.runIf(process.env.OPENMAPX_RUN_DATABASE_TESTS === "1");

let fixture: PostgisFixture;
let database: typeof import("../src/db/index.js");

integration("data-manager database sessions", () => {
  beforeAll(async () => {
    fixture = await startPostgis();
    await fixture.sql.unsafe(`ALTER DATABASE openmapx_test SET timezone = 'Europe/Berlin'`);
    vi.stubEnv("DATABASE_URL", fixture.connectionString);
    vi.resetModules();
    database = await import("../src/db/index.js");
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.sql.end({ timeout: 5 });
    await fixture?.stop();
  });

  it("report TimeZone UTC on a database whose default is another time zone", async () => {
    const plain = postgres(fixture.connectionString, { max: 1 });
    try {
      expect(await plain`SHOW TimeZone`).toEqual([{ TimeZone: "Europe/Berlin" }]);
    } finally {
      await plain.end({ timeout: 5 });
    }
    const worker = database.connectDatabase("openmapx-data-manager-time-zone-test");
    try {
      for (const connection of [database.sql, worker])
        expect(await connection`SHOW TimeZone`).toEqual([{ TimeZone: "UTC" }]);
    } finally {
      await worker.end({ timeout: 5 });
    }
  });
});
