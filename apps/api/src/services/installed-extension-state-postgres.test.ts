import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installedExtension, installedExtensionComponent } from "../db/installed-extension-schema";
import { createMigratedPostgresContainer } from "../test/postgres-fixture";
import { disabledExtensionIntegrationIds } from "./installed-extension-state";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

dbDescribe("the disabled extension gate", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresContainer>>;

  beforeAll(async () => {
    fixture = await createMigratedPostgresContainer();
  }, 90_000);
  afterAll(async () => {
    await fixture?.stop();
  });

  it("names the integrations of disabled extensions and nothing else", async () => {
    const database = fixture.db as unknown as Parameters<typeof disabledExtensionIntegrationIds>[0];
    expect(await disabledExtensionIntegrationIds(database)).toEqual(new Set());

    await fixture.db.insert(installedExtension).values([
      { id: "acme", name: "Acme", installedVersion: "1.0.0", enabled: false },
      { id: "other", name: "Other", installedVersion: "1.0.0" },
    ]);
    await fixture.db.insert(installedExtensionComponent).values([
      { extensionId: "acme", kind: "integration", componentId: "acme-places" },
      { extensionId: "acme", kind: "integration", componentId: "acme-weather" },
      { extensionId: "acme", kind: "service", componentId: "acme-tiles" },
      { extensionId: "other", kind: "integration", componentId: "other-places" },
    ]);

    expect(await disabledExtensionIntegrationIds(database)).toEqual(
      new Set(["acme-places", "acme-weather"]),
    );
  });
});
