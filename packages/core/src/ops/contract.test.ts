import { describe, expect, it } from "vitest";
import {
  authorizeOpsOperation,
  OPS_KIND_POLICIES,
  OPS_MAX_BACKUP_ID_LENGTH,
  OPS_OPERATION_KINDS,
  OpsContractError,
  type OpsOperation,
  type OpsRole,
  opsResourceId,
  parseOpsRequest,
  parseOpsResult,
  redactedOpsError,
} from "./contract";

const issuedAt = "2026-08-23T18:00:00.000Z";
const expiresAt = "2026-08-23T18:00:20.000Z";

function request(operation: unknown, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    requestId: "ops1_0123456789abcdef",
    operationKey: "opk1_0123456789abcdef",
    issuedAt,
    expiresAt,
    operation,
    ...extra,
  };
}

const samples: Record<(typeof OPS_OPERATION_KINDS)[number], OpsOperation> = {
  "docker.status": { kind: "docker.status" },
  "stack.status": { kind: "stack.status" },
  "stack.render": { kind: "stack.render", revisionId: "config_20260823" },
  "stack.start": { kind: "stack.start" },
  "stack.stop": { kind: "stack.stop" },
  "service.start": { kind: "service.start", serviceId: "motis" },
  "service.stop": { kind: "service.stop", serviceId: "motis" },
  "service.restart": { kind: "service.restart", serviceId: "motis" },
  "service.recreate": { kind: "service.recreate", serviceId: "motis" },
  "service.recreateIsolated": { kind: "service.recreateIsolated", serviceId: "motis" },
  "service.pull": { kind: "service.pull", serviceId: "motis" },
  "service.remove": { kind: "service.remove", serviceId: "motis" },
  "service.update": { kind: "service.update", serviceId: "motis" },
  "service.build": { kind: "service.build", serviceId: "motis", regionId: "europe/germany" },
  "services.buildAll": { kind: "services.buildAll", failFast: true },
  "service.logs": { kind: "service.logs", serviceId: "motis", tail: 200 },
  "service.logs.follow": {
    kind: "service.logs.follow",
    serviceId: "motis",
    tail: 200,
    maxDurationSeconds: 300,
  },
  "dawarich.provisioning.inspect": { kind: "dawarich.provisioning.inspect" },
  "release.resolve": { kind: "release.resolve" },
  "release.pull": { kind: "release.pull", releaseId: "2026.08.23" },
  "release.inspect": { kind: "release.inspect" },
  "release.apply": { kind: "release.apply", releaseId: "2026.08.23" },
  "appApi.replace": {
    kind: "appApi.replace",
    releaseId: "2026.08.23",
    updateJobId: "update_20260823",
  },
  "appApi.runtime.inspect": { kind: "appApi.runtime.inspect" },
  "backup.list": { kind: "backup.list" },
  "backup.create": { kind: "backup.create", backupId: "pre-update-20260823" },
  "backup.restore": {
    kind: "backup.restore",
    backupId: "pre-update-20260823",
    serviceIds: ["postgis"],
    stopRunning: true,
  },
  "backup.delete": { kind: "backup.delete", backupId: "pre-update-20260823" },
  "system.diagnostics": { kind: "system.diagnostics" },
  "system.inspect": { kind: "system.inspect" },
  "system.update": {
    kind: "system.update",
    releaseId: "2026.08.23",
    createBackup: true,
    backupId: "pre-update-20260823",
  },
  "extension.repository.inspect": {
    kind: "extension.repository.inspect",
    catalogEntryId: "maps-bundle",
    catalogRevisionId: "catalog_20260823",
  },
  "extension.install": {
    kind: "extension.install",
    extensionId: "maps-bundle",
    catalogEntryId: "maps-bundle",
    catalogRevisionId: "catalog_20260823",
  },
  "extension.update": {
    kind: "extension.update",
    extensionId: "maps-bundle",
    catalogRevisionId: "catalog_20260823",
  },
  "extension.remove": { kind: "extension.remove", extensionId: "maps-bundle" },
  "serviceSelection.apply": {
    kind: "serviceSelection.apply",
    revisionId: "selection_20260823",
  },
  "serviceConfig.apply": {
    kind: "serviceConfig.apply",
    serviceId: "motis",
    revisionId: "config_20260823",
  },
  "integrationConfig.apply": {
    kind: "integrationConfig.apply",
    integrationId: "routing",
    revisionId: "config_20260823",
  },
  "vault.apply": {
    kind: "vault.apply",
    serviceId: "motis",
    revisionId: "vault_20260823",
  },
  "data.inspect": { kind: "data.inspect" },
  "data.downloadOsm": { kind: "data.downloadOsm", regionId: "europe/germany" },
  "data.downloadFonts": { kind: "data.downloadFonts" },
  "data.update": { kind: "data.update", countryCodes: ["DE"], failFast: true },
  "data.convertOverpass": { kind: "data.convertOverpass", regionId: "europe/germany" },
  "data.link": { kind: "data.link" },
  "data.clean": { kind: "data.clean", dataTypeId: "osm" },
  "data.generateApiKeys": {
    kind: "data.generateApiKeys",
    catalogRevisionId: "catalog_20260823",
  },
  "data.overtureSync": { kind: "data.overtureSync", regionId: "europe/germany" },
  "data.overtureConflate": {
    kind: "data.overtureConflate",
    regionId: "europe/germany",
    restart: true,
  },
  "data.searchIndexBuild": {
    kind: "data.searchIndexBuild",
    regionId: "europe/germany",
  },
  "motis.staging.restart": { kind: "motis.staging.restart" },
  "motis.staging.stop": { kind: "motis.staging.stop" },
  "motis.primary.restart": { kind: "motis.primary.restart" },
  "motis.primary.stop": { kind: "motis.primary.stop" },
  "motis.primary.promote": { kind: "motis.primary.promote", preparedRunId: "run_20260823" },
  "feedProxy.validateAndReload": {
    kind: "feedProxy.validateAndReload",
    candidateId: "candidate_20260823",
  },
  "valhalla.traffic.inspect": { kind: "valhalla.traffic.inspect" },
  "valhalla.traffic.rebuild": { kind: "valhalla.traffic.rebuild" },
  "valhalla.traffic.refreshWaysToEdges": { kind: "valhalla.traffic.refreshWaysToEdges" },
  "valhalla.traffic.applyPredicted": { kind: "valhalla.traffic.applyPredicted" },
  "postgis.capacity.inspect": { kind: "postgis.capacity.inspect" },
  "transitousLock.inspect": { kind: "transitousLock.inspect" },
  "transitousLock.propose": {
    kind: "transitousLock.propose",
    ref: `main@${"a".repeat(40)}`,
    submodules: { "transitland-atlas": "b".repeat(40) },
    lockedBy: "fixture-actor",
  },
  "transitousLock.approve": {
    kind: "transitousLock.approve",
    ref: `main@${"a".repeat(40)}`,
    approvedBy: "fixture-actor",
  },
  "gbfsCatalogLock.inspect": { kind: "gbfsCatalogLock.inspect" },
};

describe("ops contract", () => {
  it("freezes one strict schema for every inventoried typed effect", () => {
    expect(Object.keys(samples).sort()).toEqual([...OPS_OPERATION_KINDS].sort());
    for (const operation of Object.values(samples)) {
      // Take the role from the policy table rather than re-deriving it from a
      // kind prefix: a prefix list silently omits every kind added later.
      const role: OpsRole = OPS_KIND_POLICIES[operation.kind].role;
      expect(parseOpsRequest(request(operation), { role }).operation).toEqual(operation);
    }
  });

  it("rejects unknown fields and every general-runner escape hatch", () => {
    expect(() =>
      parseOpsRequest(request({ kind: "docker.status" }, { body: "secret" }), {
        role: "api",
      }),
    ).toThrow(OpsContractError);
    for (const field of [
      "command",
      "args",
      "path",
      "compose",
      "yaml",
      "environment",
      "containerName",
    ]) {
      expect(() =>
        parseOpsRequest(request({ kind: "service.start", serviceId: "motis", [field]: "x" }), {
          role: "api",
        }),
      ).toThrow(OpsContractError);
    }
  });

  it("rejects flag-shaped, path-shaped, malformed, and unregistered service IDs", () => {
    for (const serviceId of ["--project", "../motis", "MOTIS", "motis/blue"]) {
      expect(() =>
        parseOpsRequest(request({ kind: "service.restart", serviceId }), {
          role: "api",
        }),
      ).toThrow(OpsContractError);
    }
  });

  it("bounds log tails and identifier lists", () => {
    for (const tail of [0, 2001, 1.5, "200"]) {
      expect(() =>
        parseOpsRequest(request({ kind: "service.logs", serviceId: "motis", tail }), {
          role: "api",
        }),
      ).toThrow(OpsContractError);
    }
    expect(() =>
      parseOpsRequest(
        request({
          kind: "backup.restore",
          backupId: "safe",
          serviceIds: Array.from({ length: 65 }, () => "motis"),
        }),
        { role: "api" },
      ),
    ).toThrow(OpsContractError);
  });

  it("strictly bounds backup identifiers and backup inventory output", () => {
    for (const backupId of [
      "--force",
      "../backup",
      ".hidden",
      "a".repeat(OPS_MAX_BACKUP_ID_LENGTH + 1),
    ]) {
      expect(() =>
        parseOpsRequest(request({ kind: "backup.delete", backupId }), { role: "api" }),
      ).toThrow(OpsContractError);
    }
    expect(() =>
      parseOpsRequest(request({ kind: "backup.list", path: "/host/backups" }), { role: "api" }),
    ).toThrow(OpsContractError);

    const inventory = {
      backups: [
        {
          backupId: "nightly-20260823",
          createdAt: "2026-08-23T18:00:00.000Z",
          platformVersion: "1.0.0",
          serviceCount: 3,
          volumeCount: 4,
          totalBytes: 42,
        },
        {
          backupId: "corrupt-entry",
          createdAt: "2026-08-23T19:00:00.000Z",
          serviceCount: 0,
          volumeCount: 0,
          totalBytes: 0,
          corrupt: true,
          corruptReason: "missing_manifest",
        },
      ],
      warningCount: 1,
    };
    expect(parseOpsResult("backup.list", inventory)).toEqual(inventory);
    expect(() =>
      parseOpsResult("backup.list", {
        ...inventory,
        root: "/host/secret/path",
      }),
    ).toThrow();
  });

  it("binds the system-update backup option without accepting an implicit path", () => {
    expect(
      parseOpsRequest(
        request({
          kind: "system.update",
          releaseId: "release-1",
          createBackup: true,
          backupId: "pre-update-job-1",
        }),
        { role: "api" },
      ).operation,
    ).toMatchObject({ createBackup: true, backupId: "pre-update-job-1" });
    expect(
      parseOpsRequest(
        request({ kind: "system.update", releaseId: "release-1", createBackup: false }),
        { role: "api" },
      ).operation,
    ).toEqual({ kind: "system.update", releaseId: "release-1", createBackup: false });
    for (const operation of [
      { kind: "system.update", releaseId: "release-1", createBackup: true },
      {
        kind: "system.update",
        releaseId: "release-1",
        createBackup: false,
        backupId: "unexpected",
      },
      {
        kind: "system.update",
        releaseId: "release-1",
        createBackup: false,
        path: "/host",
      },
    ]) {
      expect(() => parseOpsRequest(request(operation), { role: "api" })).toThrow();
    }
    expect(
      opsResourceId({ kind: "system.update", releaseId: "release-1", createBackup: false }),
    ).toBe("release-1");
  });

  it("keeps data inventory kind-only and validates its bounded typed result", () => {
    expect(parseOpsRequest(request({ kind: "data.inspect" }), { role: "api" }).operation).toEqual({
      kind: "data.inspect",
    });
    for (const field of ["path", "environment", "argv", "url"]) {
      expect(() =>
        parseOpsRequest(request({ kind: "data.inspect", [field]: "/host/data" }), {
          role: "api",
        }),
      ).toThrow();
    }
    const inventory = {
      osm: {
        found: true,
        filename: "germany-latest.osm.pbf",
        sizeBytes: 42,
        modifiedAt: "2026-08-23T18:00:00.000Z",
        region: "germany",
      },
      builds: [{ target: "valhalla", built: true, builtAt: "2026-08-23T18:00:00.000Z" }],
      motisTransitous: {
        configFound: false,
        datasetCount: 0,
        realtimeFeedCount: 0,
        gbfsFeedCount: 0,
        feedProxyUrlCount: 0,
        gbfsProxyUrl: null,
        feedProxyMode: "none",
        feedProxyConfigFound: false,
        feedProxyVarsFound: false,
        feedProxyFeedCount: 0,
        capabilityState: "missing",
        activeEpoch: null,
        candidateEpoch: null,
        testedAt: null,
        configHash: null,
        licenseHash: null,
        rentalProviderCount: 0,
        rentalProviderGroupCount: 0,
        rollbackAvailable: false,
        operationsProfile: "unknown",
        activeSlot: null,
        previousHealthySlot: null,
        preflightState: "missing",
        preflightRequiredDiskBytes: null,
        preflightFreeDiskBytes: null,
        pinProposalPending: false,
        crowdsourceState: "disabled-pending-review",
        gbfsCatalog: {
          state: "missing",
          commit: null,
          lockedAt: null,
          registryRows: 0,
          registryAdded: 0,
          transitousPreferred: 0,
          quarantined: 0,
          validationFailed: 0,
          sources: [],
        },
      },
    };
    expect(parseOpsResult("data.inspect", inventory)).toEqual(inventory);
    expect(() =>
      parseOpsResult("data.inspect", { ...inventory, dataRoot: "/host/data" }),
    ).toThrow();
  });

  it("keeps system image inspection kind-only and requires explicit exact states", () => {
    expect(parseOpsRequest(request({ kind: "system.inspect" }), { role: "api" }).operation).toEqual(
      { kind: "system.inspect" },
    );
    expect(() =>
      parseOpsRequest(request({ kind: "system.inspect", image: "attacker/image:latest" }), {
        role: "api",
      }),
    ).toThrow();
    const result = {
      dockerReachable: true,
      composeReady: true,
      maintenanceReady: true,
      release: { currentReleaseId: "release-old", availableReleaseId: "release-new" },
      services: [
        {
          serviceId: "app-api",
          containerState: "running",
          pinnedImage: `ghcr.io/openmapx/api@sha256:${"a".repeat(64)}`,
          runningImageId: `sha256:${"b".repeat(64)}`,
          localImageId: `sha256:${"a".repeat(64)}`,
          releaseMember: true,
          state: "update_available",
        },
      ],
    };
    expect(parseOpsResult("system.inspect", result)).toEqual(result);
    for (const invalid of [
      { ...result, services: [{ ...result.services[0], state: "up-to-date" }] },
      { ...result, services: [{ ...result.services[0], localImageId: null }] },
      { ...result, containerName: "app-api-1" },
    ]) {
      expect(() => parseOpsResult("system.inspect", invalid)).toThrow();
    }
  });

  it("authorizes roles from the operation kind without inspecting operation arguments", () => {
    expect(authorizeOpsOperation("api", "service.start")).toBe(true);
    expect(authorizeOpsOperation("api", "motis.primary.restart")).toBe(false);
    expect(authorizeOpsOperation("data-manager", "motis.primary.restart")).toBe(true);
    expect(authorizeOpsOperation("data-manager", "service.start")).toBe(false);
  });

  it("returns bounded error classes without retaining secret exception text", () => {
    const envelope = redactedOpsError(
      "ops1_0123456789abcdef",
      "runtime",
      new Error("Bearer super-secret docker stderr"),
    );
    expect(envelope).toEqual({
      version: 1,
      requestId: "ops1_0123456789abcdef",
      ok: false,
      error: { class: "runtime", message: "Operation failed" },
    });
    expect(JSON.stringify(envelope)).not.toContain("super-secret");
  });

  it("strictly validates the fixed Dawarich provisioning inspection", () => {
    const inspection = {
      services: [
        { serviceId: "dawarich-app", state: "running" },
        { serviceId: "dawarich-sidekiq", state: "running" },
        { serviceId: "dawarich-postgis", state: "running" },
        { serviceId: "dawarich-redis", state: "running" },
      ],
      appliedGenerations: {
        app: "0123456789abcdef0123456789abcdef",
        worker: null,
      },
    };
    expect(parseOpsResult("dawarich.provisioning.inspect", inspection)).toEqual(inspection);
    expect(() =>
      parseOpsResult("dawarich.provisioning.inspect", {
        ...inspection,
        services: [{ serviceId: "redis", state: "running" }],
      }),
    ).toThrow();
    expect(() =>
      parseOpsResult("dawarich.provisioning.inspect", {
        ...inspection,
        appliedGenerations: { app: "../../secret", worker: null },
      }),
    ).toThrow();
    expect(() =>
      parseOpsResult("dawarich.provisioning.inspect", { ...inspection, environment: [] }),
    ).toThrow();
  });
});
