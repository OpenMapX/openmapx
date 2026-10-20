import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, expect, it, vi } from "vitest";

// A precise transactional row boundary: execute the actual adapter, inspect its
// SQL ownership predicate, and model commit/rollback rather than live PostgreSQL.
const dialect = new PgDialect();
let rows: Array<{
  id: string;
  integrationId: string;
  config: Record<string, unknown>;
  version: string;
}> = [];
let nextVersion = 1;
let failCommit = false;
let failWrite = false;
let _writes = 0;
const predicates: string[] = [];
function port() {
  let candidate: (typeof rows)[number] | undefined;
  let changes: Partial<(typeof rows)[number]> = {};
  let op = "select";
  const chain = {
    select() {
      op = "select";
      return chain;
    },
    from() {
      return chain;
    },
    orderBy() {
      return chain;
    },
    for() {
      return Promise.resolve(structuredClone(rows));
    },
    where(condition: SQL) {
      if (op !== "select") {
        const query = dialect.sqlToQuery(condition);
        predicates.push(query.sql);
        candidate = rows.find((row) => row.id === query.params[0]);
        if (query.params.length > 1 && candidate?.version !== query.params[1])
          candidate = undefined;
      }
      return chain;
    },
    update() {
      op = "update";
      return chain;
    },
    delete() {
      op = "delete";
      return chain;
    },
    insert() {
      op = "insert";
      return chain;
    },
    set(value: typeof changes) {
      changes = value;
      return chain;
    },
    values(value: typeof changes) {
      changes = value;
      return chain;
    },
    onConflictDoNothing() {
      return chain;
    },
    async returning() {
      if (failWrite) throw Error("write failed");
      _writes++;
      if (op === "insert") {
        if (rows.some((r) => r.integrationId === changes.integrationId)) return [];
        const row = { ...changes, version: String(nextVersion++) } as (typeof rows)[number];
        rows.push(row);
        return [structuredClone(row)];
      }
      if (!candidate) return [];
      const id = candidate.id;
      if (op === "delete") rows = rows.filter((r) => r !== candidate);
      else Object.assign(candidate, changes, { version: String(nextVersion++) });
      return [op === "delete" ? { id } : structuredClone(candidate)];
    },
    // biome-ignore lint/suspicious/noThenProperty: Drizzle's query builders are thenable.
    then(resolve: (value: unknown) => unknown) {
      return Promise.resolve(structuredClone(rows)).then(resolve);
    },
  };
  return chain;
}
vi.mock("../db", () => ({
  db: {
    select: () => port().select(),
    async transaction(fn: (tx: ReturnType<typeof port>) => Promise<unknown>) {
      const before = structuredClone(rows);
      try {
        const value = await fn(port());
        if (failCommit) throw Error("commit failed");
        return value;
      } catch (error) {
        rows = before;
        throw error;
      }
    },
  },
}));
const { persistIntegrationImport } = await import("./integration-config-store");
beforeEach(() => {
  rows = [
    { id: "row-a", integrationId: "alpha", config: { old: "x", enabled: false }, version: "0" },
  ];
  nextVersion = 1;
  failCommit = false;
  failWrite = false;
  _writes = 0;
  predicates.length = 0;
});
it("replaces named nonsecret overrides, preserves omitted enabled, and restores exact prior rows", async () => {
  const saved = await persistIntegrationImport([
    { integrationId: "alpha", config: { label: "new" } },
    { integrationId: "beta", config: {} },
  ]);
  expect(rows[0].config).toEqual({ label: "new", enabled: false });
  expect(await saved.owns()).toBe(true);
  expect(await saved.restore()).toBe(true);
  expect(await saved.owns()).toBe(true);
  expect(rows).toHaveLength(1);
  expect(rows[0].config).toEqual({ old: "x", enabled: false });
  expect(predicates.filter((p) => p.includes("xmin::text"))).toHaveLength(2);
});
it("checks tuple version, rolls back partial restoration and preserves competing rows", async () => {
  const saved = await persistIntegrationImport([
    { integrationId: "alpha", config: {} },
    { integrationId: "beta", config: {} },
  ]);
  rows[1].version = "competing-version";
  rows[1].config = { label: "competitor" };
  expect(await saved.owns()).toBe(false);
  expect(await saved.restore()).toBe(false);
  expect(rows[0].config).toEqual({ enabled: false });
  expect(rows[1].config).toEqual({ label: "competitor" });
});
it.each(["write", "commit"])("does not leave partial batch after %s failure", async (kind) => {
  failWrite = kind === "write";
  failCommit = kind === "commit";
  await expect(
    persistIntegrationImport([{ integrationId: "alpha", config: {} }]),
  ).rejects.toThrow();
  expect(rows[0].config).toEqual({ old: "x", enabled: false });
});
