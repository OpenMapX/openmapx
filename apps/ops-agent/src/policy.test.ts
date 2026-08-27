import { authorizeOpsResources, type OpsOperation } from "@openmapx/core/ops";
import { describe, expect, it } from "vitest";
import {
  createProductionRegistryResourceClaimer,
  createRegistryResourceClaimer,
  createRegistryResourcePolicy,
  denyAllTrustedOpsData,
} from "./policy";

describe("operation-specific authority policy", () => {
  it("uses agent-owned backup authority without consulting caller-published trusted data", async () => {
    const trustedClaims: string[] = [];
    const backupClaims: string[] = [];
    const claimer = createRegistryResourceClaimer({
      serviceIds: ["postgis"],
      integrationIds: [],
      resourceAuthority: {
        allowBackup: async (kind, backupId) => {
          backupClaims.push(`${kind}:${backupId}`);
          return (
            (kind === "backup.create" && backupId === "fresh") ||
            (kind !== "backup.create" && backupId === "present")
          );
        },
      },
      trustedData: {
        claim: async (operation) => {
          trustedClaims.push(operation.kind);
          return null;
        },
      },
    });
    const signal = new AbortController().signal;
    await expect(
      claimer.claim({ kind: "backup.create", backupId: "fresh" }, "a".repeat(64), signal),
    ).resolves.not.toBeNull();
    await expect(
      claimer.claim(
        { kind: "backup.restore", backupId: "present", serviceIds: ["postgis"] },
        "b".repeat(64),
        signal,
      ),
    ).resolves.not.toBeNull();
    await expect(
      claimer.claim({ kind: "backup.delete", backupId: "fresh" }, "c".repeat(64), signal),
    ).resolves.toBeNull();
    expect(backupClaims).toEqual([
      "backup.create:fresh",
      "backup.restore:present",
      "backup.delete:fresh",
    ]);
    expect(trustedClaims).toEqual([]);
  });

  it("uses independent agent authority for typed data IDs without a caller snapshot", async () => {
    const trustedClaims: string[] = [];
    const claimer = createRegistryResourceClaimer({
      serviceIds: ["valhalla"],
      integrationIds: [],
      resourceAuthority: {
        allowRegion: (_kind, regionId) => regionId === "europe/germany",
        allowCountry: (_kind, countryCode) => ["DE", "AT"].includes(countryCode),
        allowDataType: (dataTypeId) => dataTypeId === "osm",
        allowCatalogRevision: (kind, revisionId) =>
          kind === "data.generateApiKeys" && revisionId === "transitous-fixed-v1",
      },
      trustedData: {
        claim: async (operation) => {
          trustedClaims.push(operation.kind);
          return null;
        },
      },
    });
    const signal = new AbortController().signal;
    await expect(
      claimer.claim(
        { kind: "data.downloadOsm", regionId: "europe/germany" },
        "a".repeat(64),
        signal,
      ),
    ).resolves.not.toBeNull();
    await expect(
      claimer.claim(
        { kind: "data.update", regionId: "europe/germany", countryCodes: ["DE", "AT"] },
        "h".repeat(64),
        signal,
      ),
    ).resolves.not.toBeNull();
    await expect(
      claimer.claim(
        { kind: "data.update", regionId: "europe/germany", countryCodes: ["ZZ"] },
        "i".repeat(64),
        signal,
      ),
    ).resolves.toBeNull();
    await expect(
      claimer.claim(
        { kind: "service.build", serviceId: "valhalla", regionId: "europe/germany" },
        "f".repeat(64),
        signal,
      ),
    ).resolves.not.toBeNull();
    await expect(
      claimer.claim(
        { kind: "services.buildAll", regionId: "europe/germany", failFast: true },
        "g".repeat(64),
        signal,
      ),
    ).resolves.not.toBeNull();
    await expect(
      claimer.claim({ kind: "data.clean", dataTypeId: "osm" }, "b".repeat(64), signal),
    ).resolves.not.toBeNull();
    await expect(
      claimer.claim(
        { kind: "data.generateApiKeys", catalogRevisionId: "transitous-fixed-v1" },
        "c".repeat(64),
        signal,
      ),
    ).resolves.not.toBeNull();
    await expect(
      claimer.claim({ kind: "data.clean", dataTypeId: "unknown" }, "d".repeat(64), signal),
    ).resolves.toBeNull();
    await expect(
      claimer.claim(
        { kind: "data.overtureSync", regionId: "europe/germany/../../etc" } as never,
        "e".repeat(64),
        signal,
      ),
    ).resolves.toBeNull();
    expect(trustedClaims).toEqual([]);
  });

  it("uses agent-owned release and update-job authority without a caller snapshot", async () => {
    const trustedClaims: string[] = [];
    const claimer = createRegistryResourceClaimer({
      serviceIds: [],
      integrationIds: [],
      resourceAuthority: {
        allowRelease: (_kind, releaseId) => releaseId === "release-123",
        allowBackup: (_kind, backupId) => backupId === "pre-update-job-1",
        allowUpdateJobId: (updateJobId) => updateJobId === "job-1",
      },
      trustedData: {
        claim: async (operation) => {
          trustedClaims.push(operation.kind);
          return null;
        },
      },
    });
    const signal = new AbortController().signal;
    for (const operation of [
      { kind: "release.pull", releaseId: "release-123" },
      { kind: "release.apply", releaseId: "release-123" },
      { kind: "appApi.replace", releaseId: "release-123", updateJobId: "job-1" },
      {
        kind: "system.update",
        releaseId: "release-123",
        createBackup: true,
        backupId: "pre-update-job-1",
      },
    ] as const) {
      await expect(claimer.claim(operation, "r".repeat(64), signal)).resolves.not.toBeNull();
    }
    await expect(
      claimer.claim(
        { kind: "appApi.replace", releaseId: "release-123", updateJobId: "other" },
        "s".repeat(64),
        signal,
      ),
    ).resolves.toBeNull();
    expect(trustedClaims).toEqual([]);
  });

  it("refreshes custom service and integration authority without restarting the agent", async () => {
    let enabled = new Set(["redis"]);
    let authority = {
      revisionId: "authority-initial",
      services: [{ serviceId: "redis", enabled: true, isBuiltIn: true }],
      integrationIds: [] as string[],
    };
    const claimer = createProductionRegistryResourceClaimer({
      services: authority.services,
      integrationIds: authority.integrationIds,
      loadAuthority: async () => authority,
      trustedData: {
        claim: async (operation) =>
          "revisionId" in operation ? { revisionId: operation.revisionId, values: {} } : null,
      },
      enabledServiceIds: () => enabled,
    });
    const signal = new AbortController().signal;
    await expect(
      claimer.claim({ kind: "service.start", serviceId: "community-live" }, "a".repeat(64), signal),
    ).resolves.toBeNull();

    authority = {
      revisionId: "authority-installed",
      services: [
        { serviceId: "redis", enabled: true, isBuiltIn: true },
        { serviceId: "community-live", enabled: true, isBuiltIn: false },
      ],
      integrationIds: ["integration-live"],
    };
    enabled = new Set(["redis", "community-live"]);
    await expect(
      claimer.claim({ kind: "service.start", serviceId: "community-live" }, "b".repeat(64), signal),
    ).resolves.not.toBeNull();
    const configClaim = await claimer.claim(
      {
        kind: "integrationConfig.apply",
        integrationId: "integration-live",
        revisionId: `cfg1_${"c".repeat(43)}`,
      },
      "c".repeat(64),
      signal,
      { role: "api", operationKey: "opk1_authorityRefresh0" },
    );
    expect(configClaim?.capability.values).toEqual({
      authorityRevision: "authority-installed",
    });

    authority = {
      revisionId: "authority-removed",
      services: [{ serviceId: "redis", enabled: true, isBuiltIn: true }],
      integrationIds: [],
    };
    enabled = new Set(["redis"]);
    await expect(
      claimer.claim({ kind: "service.start", serviceId: "community-live" }, "d".repeat(64), signal),
    ).resolves.toBeNull();
    await expect(
      claimer.claim(
        {
          kind: "integrationConfig.apply",
          integrationId: "integration-live",
          revisionId: `cfg1_${"e".repeat(43)}`,
        },
        "e".repeat(64),
        signal,
      ),
    ).resolves.toBeNull();
  });

  it("rolls back the exact pre-admission snapshot when refreshed authority rejects its binding", async () => {
    let rollbacks = 0;
    const claimer = createProductionRegistryResourceClaimer({
      services: [{ serviceId: "redis", enabled: true, isBuiltIn: true }],
      integrationIds: [],
      loadAuthority: async () => ({
        revisionId: "authority-current",
        services: [{ serviceId: "redis", enabled: true, isBuiltIn: true }],
        integrationIds: [],
      }),
      trustedData: {
        claim: async (operation) => ({
          capability: {
            revisionId: "revisionId" in operation ? operation.revisionId : "invalid",
            values: { authorityRevision: "caller-controlled" },
          },
          admission: {
            rollback: async () => {
              rollbacks += 1;
            },
            commit: async () => undefined,
            release: async () => undefined,
          },
        }),
      },
    });
    await expect(
      claimer.claim(
        { kind: "stack.render", revisionId: `cfg1_${"r".repeat(43)}` },
        "a".repeat(64),
        new AbortController().signal,
        { role: "api", operationKey: "opk1_authorityReject00" },
      ),
    ).resolves.toBeNull();
    expect(rollbacks).toBe(1);
  });

  it("tracks committed generation enable/disable state for lifecycle authority across restart", async () => {
    let enabled = new Set(["redis", "app-api", "traefik", "ops-agent"]);
    const claimer = createProductionRegistryResourceClaimer({
      services: [
        { serviceId: "redis", enabled: true, isBuiltIn: true },
        { serviceId: "motis", enabled: false, isBuiltIn: true },
        { serviceId: "community-enabled", enabled: true, isBuiltIn: false },
        { serviceId: "community-disabled", enabled: false, isBuiltIn: false },
        { serviceId: "app-api", enabled: true, isBuiltIn: true },
        { serviceId: "traefik", enabled: true, isBuiltIn: true },
        { serviceId: "ops-agent", enabled: true, isBuiltIn: true },
      ],
      integrationIds: [],
      trustedData: denyAllTrustedOpsData,
      enabledServiceIds: () => enabled,
    });
    const signal = new AbortController().signal;
    const operations: OpsOperation[] = [
      { kind: "service.restart", serviceId: "redis" },
      { kind: "service.logs", serviceId: "redis", tail: 20 },
    ];
    for (const operation of operations) {
      await expect(claimer.claim(operation, "a".repeat(64), signal)).resolves.not.toBeNull();
      for (const serviceId of [
        "motis",
        "community-enabled",
        "community-disabled",
        "app-api",
        "traefik",
        "ops-agent",
      ]) {
        const denied = { ...operation, serviceId } as OpsOperation;
        await expect(claimer.claim(denied, "b".repeat(64), signal)).resolves.toBeNull();
      }
    }
    enabled = new Set(["motis"]);
    await expect(
      claimer.claim({ kind: "service.start", serviceId: "motis" }, "c".repeat(64), signal),
    ).resolves.not.toBeNull();
    await expect(
      claimer.claim({ kind: "service.start", serviceId: "redis" }, "d".repeat(64), signal),
    ).resolves.toBeNull();
    // A reconstructed claimer reads the same recovered generation-owned set.
    const restarted = createProductionRegistryResourceClaimer({
      services: [
        { serviceId: "redis", enabled: true, isBuiltIn: true },
        { serviceId: "motis", enabled: false, isBuiltIn: true },
      ],
      integrationIds: [],
      trustedData: denyAllTrustedOpsData,
      enabledServiceIds: () => enabled,
    });
    await expect(
      restarted.claim({ kind: "service.start", serviceId: "motis" }, "e".repeat(64), signal),
    ).resolves.not.toBeNull();
  });

  it("excludes the agent, edge proxy, and self-replaced API from generic lifecycle", async () => {
    const policy = createRegistryResourcePolicy({
      serviceIds: ["redis", "ops-agent", "traefik", "app-api"],
      integrationIds: [],
      trustedData: denyAllTrustedOpsData,
    });
    await expect(
      authorizeOpsResources({ kind: "service.restart", serviceId: "redis" }, policy),
    ).resolves.toBe(true);
    for (const serviceId of ["ops-agent", "traefik", "app-api"]) {
      await expect(
        authorizeOpsResources({ kind: "service.restart", serviceId }, policy),
      ).resolves.toBe(false);
    }
  });

  it("resolves prepared runs and trusted revisions through authoritative predicates", async () => {
    const sourceOperation = { kind: "motis.primary.promote", preparedRunId: "prepared_1" } as const;
    const claimer = createRegistryResourceClaimer({
      serviceIds: ["motis"],
      integrationIds: ["routing-motis"],
      trustedData: {
        claim: async (operation) =>
          "preparedRunId" in operation && operation.preparedRunId === "prepared_1"
            ? {
                revisionId: "trusted-revision-1",
                values: { preparedPathId: "prepared_1" },
              }
            : null,
      },
    });
    const claim = await claimer.claim(
      sourceOperation,
      "f".repeat(64),
      new AbortController().signal,
    );
    (sourceOperation as { preparedRunId: string }).preparedRunId = "mutated";
    expect(claim).toEqual({
      operation: { kind: "motis.primary.promote", preparedRunId: "prepared_1" },
      fingerprint: "f".repeat(64),
      source: "trusted-data",
      capability: {
        revisionId: "trusted-revision-1",
        values: { preparedPathId: "prepared_1" },
      },
    });
    expect(Object.isFrozen(claim?.operation)).toBe(true);
    await expect(
      claimer.claim(
        { kind: "motis.primary.promote", preparedRunId: "syntactic_only" },
        "e".repeat(64),
        new AbortController().signal,
      ),
    ).resolves.toBeNull();
  });

  it("reapplies registry and never-manage constraints after a trusted complete-operation claim", async () => {
    let sourceCalls = 0;
    const claimer = createRegistryResourceClaimer({
      serviceIds: ["redis", "motis"],
      integrationIds: ["routing-motis"],
      trustedData: {
        claim: async () => {
          sourceCalls += 1;
          return { revisionId: "source-revision-1", values: {} };
        },
      },
    });
    const signal = new AbortController().signal;
    const forbidden: OpsOperation[] = [
      { kind: "serviceConfig.apply", serviceId: "ops-agent", revisionId: "revision_1" },
      {
        kind: "backup.restore",
        backupId: "backup_1",
        serviceIds: ["redis", "traefik"],
      },
      {
        kind: "integrationConfig.apply",
        integrationId: "unregistered-integration",
        revisionId: "revision_1",
      },
    ];
    for (const operation of forbidden) {
      await expect(claimer.claim(operation, "f".repeat(64), signal)).resolves.toBeNull();
    }
    expect(sourceCalls).toBe(0);
  });

  it("routes extension catalog inspection through the exact trusted model", async () => {
    const claimedKinds: string[] = [];
    const claimer = createRegistryResourceClaimer({
      serviceIds: [],
      integrationIds: [],
      trustedData: {
        claim: async (operation) => {
          claimedKinds.push(operation.kind);
          return { revisionId: "source-revision-1", values: {} };
        },
      },
    });
    const signal = new AbortController().signal;
    await expect(
      claimer.claim(
        {
          kind: "extension.repository.inspect",
          catalogEntryId: "catalog_1",
          catalogRevisionId: "revision_1",
        },
        "a".repeat(64),
        signal,
      ),
    ).resolves.not.toBeNull();
    expect(claimedKinds).toEqual(["extension.repository.inspect"]);
  });

  it("does not start a trusted read when admission aborts during registry preflight", async () => {
    let sourceCalls = 0;
    const claimer = createRegistryResourceClaimer({
      serviceIds: [],
      integrationIds: [],
      trustedData: {
        claim: async () => {
          sourceCalls += 1;
          return { revisionId: "source-revision-1", values: {} };
        },
      },
    });
    const controller = new AbortController();
    const result = claimer.claim(
      {
        kind: "extension.repository.inspect",
        catalogEntryId: "catalog_1",
        catalogRevisionId: "revision_1",
      },
      "c".repeat(64),
      controller.signal,
    );
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(sourceCalls).toBe(0);
  });
});
