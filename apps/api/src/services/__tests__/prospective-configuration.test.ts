import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ failService: false, vaultRows: [] as unknown[] }));
vi.mock("../../db", () => ({
  db: {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      const { db } = await import("../../db");
      return run(db);
    },
    select: () => ({
      from: (table: { name: string }) => {
        const rows = () => {
          if (table.name === "service_config" && state.failService)
            throw new Error("synthetic unavailable service query");
          return table.name === "service_secret" ? state.vaultRows : [];
        };
        return {
          // biome-ignore lint/suspicious/noThenProperty: This unit fixture models Drizzle lazy awaitable query acquisition.
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve().then(rows).then(resolve, reject),
          where: () => ({
            // biome-ignore lint/suspicious/noThenProperty: The filtered query retains the same lazy acquisition/error behavior.
            then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
              Promise.resolve().then(rows).then(resolve, reject),
            limit: rows,
          }),
        };
      },
    }),
  },
}));
vi.mock("../../db/schema", () => ({
  serviceConfig: { name: "service_config", serviceId: "service_id" },
  integrationConfig: { name: "integration_config" },
  serviceSecret: { name: "service_secret", serviceId: "service_id" },
  integrationSecret: { name: "integration_secret", integrationId: "integration_id" },
}));
vi.mock("../../integration-host", () => ({ getAllIntegrations: () => [] }));
vi.mock("../service-registry", () => ({
  getServiceRegistry: () => ({
    list: () =>
      ["alpha", "beta", "data-manager"].map((id) => ({
        manifest: {
          id,
          configSchema: { properties: { WORKERS: { type: "integer", default: 2 } } },
          container: { image: `fixture/${id}`, tag: "1" },
        },
      })),
  }),
}));

const { buildConfigurationInput } = await import("../trusted-config-operations");
const { encrypt } = await import("../secrets");
const { withAdministrativeConfigurationRead } = await import(
  "../administrative-configuration-writer"
);
const { resolveAllServiceConfigsStrict } = await import("../service-config-resolver");
afterEach(() => {
  state.failService = false;
  state.vaultRows = [];
  vi.unstubAllEnvs();
});

it("authoritative full preparation rejects a failed service read while other sources succeed", async () => {
  state.failService = true;
  await expect(buildConfigurationInput()).rejects.toThrow("Configuration acquisition unavailable");
});

it("authoritative full preparation cannot treat existing vault rows without a key as absent", async () => {
  vi.stubEnv("OPENMAPX_SECRETS_KEY", "");
  state.vaultRows = [{ key: "TOKEN", ciphertext: "fixture", iv: "fixture", tag: "fixture" }];
  await expect(buildConfigurationInput()).rejects.toThrow("Configuration acquisition unavailable");
});

it("counts retained orphan feed credentials in UTF-8 before publishing a full snapshot", async () => {
  vi.stubEnv("OPENMAPX_SECRETS_KEY", "51".repeat(32));
  const value = JSON.stringify(
    Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`orphan-${n}`, 'ü\\"'.repeat(1500)])),
  );
  expect(value.length).toBeLessThan(65536);
  expect(Buffer.byteLength(value)).toBeGreaterThan(65536);
  state.vaultRows = [{ serviceId: "data-manager", key: "TRANSITOUS_API_KEYS", ...encrypt(value) }];
  await expect(buildConfigurationInput()).rejects.toThrow();
});

it("rejects an expired administrative read context", async () => {
  let saved: Parameters<typeof resolveAllServiceConfigsStrict>[1] | undefined;
  await withAdministrativeConfigurationRead({}, async (context) => {
    saved = context;
  });
  await expect(resolveAllServiceConfigsStrict([], saved!)).rejects.toThrow(
    "Configuration acquisition unavailable",
  );
});

it("rejects a foreign still-live read context inside another coherent read", async () => {
  await withAdministrativeConfigurationRead({}, async (first) => {
    await withAdministrativeConfigurationRead({}, async () => {
      await expect(resolveAllServiceConfigsStrict([], first)).rejects.toThrow(
        "Configuration acquisition unavailable",
      );
    });
  });
});
