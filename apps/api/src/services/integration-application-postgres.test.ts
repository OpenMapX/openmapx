import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { capabilityBinding, integrationBindingRevision } from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const databaseTests = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
databaseTests("integration application binding source with migrated PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    vi.doMock("../db", () => ({ db: fixture.db, sql: fixture.sql }));
  }, 90000);
  afterAll(async () => {
    await fixture?.stop();
    vi.doUnmock("../db");
  });
  it("detects a delete/reinsert ABA in the exact read version while preserving the semantic desired revision", async () => {
    const { readBindingState } = await import("./integration-binding-state"),
      integrationId = "binding-aba";
    const empty = await readBindingState(integrationId, fixture.db);
    await fixture.db
      .insert(capabilityBinding)
      .values({ integrationId, capability: "routing-engine", serviceId: "engine-a" });
    const first = await readBindingState(integrationId, fixture.db);
    expect(first.revision).not.toBe(empty.revision);
    expect(first.bindings).toEqual({ "routing-engine": "engine-a" });
    await fixture.db
      .delete(capabilityBinding)
      .where(eq(capabilityBinding.integrationId, integrationId));
    await fixture.db
      .insert(capabilityBinding)
      .values({ integrationId, capability: "routing-engine", serviceId: "engine-a" });
    const second = await readBindingState(integrationId, fixture.db);
    expect(second.desiredRevision).toBe(first.desiredRevision);
    expect(second.revision).not.toBe(first.revision);
  });
  it("retains a changed revision when an explicit binding is removed back to automatic selection", async () => {
    const { readBindingState } = await import("./integration-binding-state"),
      integrationId = "binding-empty-version";
    const before = await readBindingState(integrationId, fixture.db);
    await fixture.db.insert(integrationBindingRevision).values({ integrationId });
    const after = await readBindingState(integrationId, fixture.db);
    expect(after.bindings).toEqual({});
    expect(after.desiredRevision).toBe(before.desiredRevision);
    expect(after.revision).not.toBe(before.revision);
  });
});
