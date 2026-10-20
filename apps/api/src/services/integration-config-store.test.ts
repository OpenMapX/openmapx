import { beforeEach, expect, it, vi } from "vitest";
import { integrationConfigDbFixture } from "./__tests__/helpers/integration-config-db";

const fixture = integrationConfigDbFixture();
vi.mock("../db", () => ({ db: fixture.db }));
const { persistIntegrationConfigPatch, persistIntegrationImport } = await import(
  "./integration-config-store"
);
beforeEach(() =>
  fixture.reset([
    { id: "row-a", integrationId: "alpha", config: { old: "x", enabled: false }, version: "0" },
  ]),
);
it("replaces named nonsecret overrides, preserves omitted enabled, and restores exact prior rows", async () => {
  const saved = await persistIntegrationImport([
    { integrationId: "alpha", config: { label: "new" } },
    { integrationId: "beta", config: {} },
  ]);
  expect(fixture.rows[0].config).toEqual({ label: "new", enabled: false });
  expect(await saved.owns()).toBe(true);
  expect(await saved.restore()).toBe(true);
  expect(await saved.owns()).toBe(true);
  expect(fixture.rows).toHaveLength(1);
  expect(fixture.rows[0].config).toEqual({ old: "x", enabled: false });
  expect(fixture.predicates.filter((p) => p.includes("xmin::text"))).toHaveLength(2);
});
it("checks tuple version, rolls back partial restoration and preserves competing rows", async () => {
  const saved = await persistIntegrationImport([
    { integrationId: "alpha", config: {} },
    { integrationId: "beta", config: {} },
  ]);
  fixture.rows[1].version = "competing-version";
  fixture.rows[1].config = { label: "competitor" };
  expect(await saved.owns()).toBe(false);
  expect(await saved.restore()).toBe(false);
  expect(fixture.rows[0].config).toEqual({ enabled: false });
  expect(fixture.rows[1].config).toEqual({ label: "competitor" });
});
it.each(["write", "commit"])("does not leave partial batch after %s failure", async (kind) => {
  fixture.failWrite = kind === "write";
  fixture.failCommit = kind === "commit";
  await expect(
    persistIntegrationImport([{ integrationId: "alpha", config: {} }]),
  ).rejects.toThrow();
  expect(fixture.rows[0].config).toEqual({ old: "x", enabled: false });
});

it("restores the locked current row after an ordinary partial edit, not an earlier snapshot", async () => {
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  fixture.beforeTransaction = async () => {
    reached.resolve();
    await resume.promise;
  };
  const pending = persistIntegrationConfigPatch({
    integrationId: "alpha",
    config: { enabled: true },
  });
  try {
    await reached.promise;
    await persistIntegrationImport([{ integrationId: "alpha", config: { label: "imported" } }]);
    resume.resolve();
    const saved = await pending;
    expect(fixture.rows[0].config).toEqual({ label: "imported", enabled: true });
    expect(saved.previous).toEqual([
      { integrationId: "alpha", config: { label: "imported", enabled: false } },
    ]);
    expect(await saved.restore()).toBe(true);
    expect(await saved.owns()).toBe(true);
    expect(fixture.rows[0].config).toEqual({ label: "imported", enabled: false });
  } finally {
    resume.resolve();
    await pending;
  }
});
it("rejects a partial edit's inverse after another import replaces its row", async () => {
  const saved = await persistIntegrationConfigPatch({
    integrationId: "alpha",
    config: { enabled: true },
  });
  await persistIntegrationImport([{ integrationId: "alpha", config: { label: "imported" } }]);
  expect(await saved.owns()).toBe(false);
  expect(await saved.restore()).toBe(false);
  expect(fixture.rows[0].config).toEqual({ label: "imported", enabled: true });
});
it("creates an absent ordinary config and conditionally removes only its owned insertion", async () => {
  const saved = await persistIntegrationConfigPatch({
    integrationId: "beta",
    config: { enabled: false },
  });
  expect(fixture.rows[1].config).toEqual({ enabled: false });
  expect(await saved.restore()).toBe(true);
  expect(await saved.owns()).toBe(true);
  expect(fixture.rows.map((row) => row.integrationId)).toEqual(["alpha"]);
});
