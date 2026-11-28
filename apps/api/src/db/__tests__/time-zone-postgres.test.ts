import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, getTableName, inArray, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { afterAll, assert, beforeAll, describe, expect, it, vi } from "vitest";
import * as authSchema from "../auth-schema";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
/** A default that differs from UTC in every season. */
const DATABASE_TIME_ZONE = "Europe/Berlin";

const integration = describe.runIf(process.env.OPENMAPX_RUN_DATABASE_TESTS === "1");

/** Better Auth's tables keep the CLI's `timestamp` columns. */
const betterAuthTables = Object.values(authSchema)
  .filter((value) => is(value, PgTable))
  .map((table) => getTableName(table));

let container: StartedPostgreSqlContainer;
let fixture: Sql;
let api: typeof import("../index");

integration("timestamps on a database whose default time zone is not UTC", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(
      "ghcr.io/baosystems/postgis:18-3.6@sha256:dd7515b7d8b8b8bac3516a9c3e12584df5890b0864c29295c1b934ecd1db81a7",
    )
      .withStartupTimeout(60_000)
      .start();
    const admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "time_zone"`);
      await admin.unsafe(`ALTER DATABASE "time_zone" SET timezone = '${DATABASE_TIME_ZONE}'`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const url = new URL(container.getConnectionUri());
    url.pathname = "/time_zone";
    fixture = postgres(url.toString(), { max: 2, onnotice: () => {} });
    await fixture`CREATE EXTENSION IF NOT EXISTS postgis`;
    await migrate(drizzle(fixture), { migrationsFolder: MIGRATIONS });
    vi.stubEnv("DATABASE_URL", url.toString());
    vi.resetModules();
    api = await import("../index");
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await api?.sql.end({ timeout: 5 });
    await api?.integrationSql.end({ timeout: 5 });
    await api?.extensionSql.end({ timeout: 5 });
    await fixture?.end({ timeout: 5 });
    await container?.stop();
  });

  it("the fixture database really defaults to another time zone", async () => {
    expect(await fixture`SHOW TimeZone`).toEqual([{ TimeZone: DATABASE_TIME_ZONE }]);
  });

  it("no app-owned column in public or data_manager is timestamp without time zone", async () => {
    expect(betterAuthTables).toEqual(expect.arrayContaining(["user", "session", "verification"]));
    const columns = await fixture<
      { table_schema: string; table_name: string; column_name: string }[]
    >`
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE data_type = 'timestamp without time zone'
        AND table_schema IN ('public', 'data_manager')
        AND NOT (table_schema = 'public' AND table_name IN ${fixture(betterAuthTables)})
      ORDER BY table_schema, table_name, column_name`;
    expect(columns).toEqual([]);
  });

  it("every API connection reports TimeZone UTC", async () => {
    const migrations = api.openMigrationSession();
    try {
      for (const connection of [api.sql, api.integrationSql, api.extensionSql, migrations])
        expect(await connection`SHOW TimeZone`).toEqual([{ TimeZone: "UTC" }]);
    } finally {
      await migrations.end({ timeout: 5 });
    }
  });

  it("timestamps round-trip through the API pool", async () => {
    const { healthHistory, session, user } = await import("../schema");
    await api.db.insert(healthHistory).values({ serviceId: "time-zone", status: "healthy" });
    const [check] = await api.db
      .select({ checkedAt: healthHistory.checkedAt })
      .from(healthHistory)
      .where(eq(healthHistory.serviceId, "time-zone"));
    assert.isDefined(check);
    expect(Math.abs(check.checkedAt.getTime() - Date.now())).toBeLessThan(5_000);

    const expiresAt = new Date(Date.now() + 3_600_000);
    await api.db.insert(user).values({
      id: "time-zone-user",
      name: "Time zone",
      email: "time-zone@example.test",
    });
    await api.db.insert(session).values({
      id: "time-zone-session",
      token: "time-zone-session-token",
      userId: "time-zone-user",
      expiresAt,
      updatedAt: new Date(),
    });
    const [stored] = await api.db
      .select({ createdAt: session.createdAt, expiresAt: session.expiresAt })
      .from(session)
      .where(eq(session.id, "time-zone-session"));
    assert.isDefined(stored);
    expect(Math.abs(stored.createdAt.getTime() - Date.now())).toBeLessThan(5_000);
    expect(stored.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it("the legal-hold guard compares instants", async () => {
    const { adminAuditLog, dataSubjectRequestPreservation, user } = await import("../schema");
    const { preservationAllowsDeletion } = await import("../../privacy/preservation");
    const { PrivacyRequestService } = await import("../../privacy/request-service");
    await api.db.insert(user).values({
      id: "time-zone-subject",
      name: "Time zone subject",
      email: "time-zone-subject@example.test",
    });
    const request = await new PrivacyRequestService({ database: api.db }).create({
      userId: "time-zone-subject",
      kind: "access",
      channel: "self_service",
      locale: "en",
      timeZone: "UTC",
    });
    const [hold] = await api.db
      .select({ cutoff: dataSubjectRequestPreservation.sourceCutoffAt })
      .from(dataSubjectRequestPreservation)
      .where(
        and(
          eq(dataSubjectRequestPreservation.requestId, request.id),
          eq(dataSubjectRequestPreservation.registrationId, "admin-audit-attribution"),
        ),
      );
    assert.isDefined(hold);
    const halfHour = 30 * 60 * 1000;
    await api.db.insert(adminAuditLog).values([
      {
        id: "0193e4a0-0000-7000-8007-000000000001",
        actorUserId: "time-zone-subject",
        action: "cache.clear",
        createdAt: new Date(hold.cutoff.getTime() - halfHour),
      },
      {
        id: "0193e4a0-0000-7000-8007-000000000002",
        actorUserId: "time-zone-subject",
        action: "cache.clear",
        createdAt: new Date(hold.cutoff.getTime() + halfHour),
      },
    ]);
    const deletable = await api.db
      .select({ id: adminAuditLog.id })
      .from(adminAuditLog)
      .where(
        and(
          inArray(adminAuditLog.id, [
            "0193e4a0-0000-7000-8007-000000000001",
            "0193e4a0-0000-7000-8007-000000000002",
          ]),
          preservationAllowsDeletion({
            registrationId: "admin-audit-attribution",
            candidateTimestamp: adminAuditLog.createdAt,
            subjectIds: [adminAuditLog.actorUserId, adminAuditLog.targetId],
          }),
        ),
      );
    expect(deletable).toEqual([{ id: "0193e4a0-0000-7000-8007-000000000002" }]);
  });
});
