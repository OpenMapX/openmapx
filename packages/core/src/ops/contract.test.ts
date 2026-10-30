import { describe, expect, it } from "vitest";
import { createCatalogPinSet } from "../catalog-pins/generation";
import {
  authorizeOpsOperation,
  OPS_KIND_POLICIES,
  OPS_MAX_BACKUP_ID_LENGTH,
  OPS_OPERATION_KINDS,
  OpsContractError,
  type OpsOperation,
  type OpsRole,
  opsResourceId,
  parseBoundedOpsResult,
  parseOpsRequest,
  parseOpsResult,
  redactedOpsError,
} from "./contract";
import { configurationProjectionFingerprint } from "./fingerprint";

const issuedAt = "2026-08-23T18:00:00.000Z";
const expiresAt = "2026-08-23T18:00:20.000Z";
const maintenanceBinding = {
  maintenanceId: "11111111-1111-4111-8111-111111111111",
  candidateId: "22222222-2222-4222-8222-222222222222",
  applyOperationKey: "opk1_originalApply000001",
  applyOperationFingerprint: "a".repeat(64),
  expectedCurrentRevisionId: null,
  revisionId: `cfg1_${"b".repeat(43)}`,
  expectedSourceRevision: "33333333-3333-4333-8333-333333333333",
  coordinatorMode: "ensure-running" as const,
  followUp: "render-only" as const,
};
const maintenanceIdentity = {
  maintenanceId: maintenanceBinding.maintenanceId,
  candidateId: maintenanceBinding.candidateId,
  prepareOperationKey: "opk1_originalPrepare0001",
  prepareFingerprint: "c".repeat(64),
  planDigest: "d".repeat(64),
};

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

const transferIdentity = {
  executionId: "job1_abcdefghijklmnop",
  operationKey: "opk1_abcdefghijklmnop",
  fingerprint: "a".repeat(64),
  executionDeadlineAt: "2026-10-29T00:00:00.000Z",
};
const transferClaim = {
  claimId: "91a78b3e-208b-4ba4-9ddf-870fbdf1da22",
  stageId: "81a78b3e-208b-4ba4-9ddf-870fbdf1da22",
  ownerId: "admin",
  purpose: "prepared-artifact" as const,
  use: "validate-build" as const,
  identity: transferIdentity,
  sha256: "a".repeat(64),
  bytes: 4,
};
const samples: Record<(typeof OPS_OPERATION_KINDS)[number], OpsOperation> = {
  "configurationHandoff.prepare": {
    kind: "configurationHandoff.prepare",
    handoffId: "77777777-7777-4777-8777-777777777777",
    maintenanceId: maintenanceBinding.maintenanceId,
    candidateId: maintenanceBinding.candidateId,
    planDigest: "d".repeat(64),
    previewFingerprint: "e".repeat(64),
    expectedCurrentRevisionId: maintenanceBinding.revisionId,
    serviceIds: ["app-api"],
    expectedImageIdentities: { "app-api": `sha256:${"1".repeat(64)}` },
    mode: { kind: "configuration" },
  },
  "configurationHandoff.inspect": {
    kind: "configurationHandoff.inspect",
    handoffId: "77777777-7777-4777-8777-777777777777",
  },
  "integration.inventory": { kind: "integration.inventory" },
  "integration.inspectOwnership": {
    kind: "integration.inspectOwnership",
    integrationId: "fixture",
    expectedContentDigest: "a".repeat(64),
    ownerId: "admin",
    operationId: "81a78b3e-208b-4ba4-9ddf-870fbdf1da22",
  },
  "integration.remove": {
    kind: "integration.remove",
    transactionId: "81a78b3e-208b-4ba4-9ddf-870fbdf1da22",
    expectedContentDigest: "a".repeat(64),
  },
  "integration.inspectInstall": {
    kind: "integration.inspectInstall",
    ownerId: "admin",
    source: {
      kind: "artifact",
      url: "https://example.com/integration.tar.gz",
      sha256: "a".repeat(64),
    },
  },
  "integration.install": {
    kind: "integration.install",
    ownerId: "admin",
    inspectionId: "91a78b3e-208b-4ba4-9ddf-870fbdf1da22",
    expectedContentDigest: "a".repeat(64),
    operationId: "81a78b3e-208b-4ba4-9ddf-870fbdf1da22",
  },
  "integration.settle": {
    kind: "integration.settle",
    transactionId: "91a78b3e-208b-4ba4-9ddf-870fbdf1da22",
    decision: "commit",
    expectedContentDigest: "a".repeat(64),
  },
  "artifactTransfer.create": {
    kind: "artifactTransfer.create",
    ownerId: "admin",
    purpose: "prepared-artifact",
    direction: "upload",
    operationKey: "opk1_abcdefghijklmnop",
    declaredBytes: 4,
  },
  "artifactTransfer.list": {
    kind: "artifactTransfer.list",
    ownerId: "admin",
    limit: 50,
    offset: 0,
  },
  "artifactTransfer.inspect": {
    kind: "artifactTransfer.inspect",
    stageId: transferClaim.stageId,
    ownerId: "admin",
    purpose: "prepared-artifact",
  },
  "artifactTransfer.delete": {
    kind: "artifactTransfer.delete",
    stageId: transferClaim.stageId,
    ownerId: "admin",
  },
  "artifactTransfer.claim": {
    kind: "artifactTransfer.claim",
    stageId: transferClaim.stageId,
    ownerId: "admin",
    purpose: "prepared-artifact",
    use: "validate-build",
    identity: transferIdentity,
    expectedSha256: "a".repeat(64),
  },
  "artifactTransfer.inspectClaim": {
    kind: "artifactTransfer.inspectClaim",
    stageId: transferClaim.stageId,
    ownerId: "admin",
    identity: transferIdentity,
  },
  "artifactTransfer.settle": {
    kind: "artifactTransfer.settle",
    claim: transferClaim,
    settlement: { outcome: "unknown", receiptId: "retained" },
  },
  "controlRetention.acknowledge": {
    kind: "controlRetention.acknowledge",
    originRootKey: "opk1_abcdefghijklmnop",
    operationKey: "opk1_abcdefghijklmnop",
    fingerprint: "a".repeat(64),
    terminalDigest: "b".repeat(64),
    proof: "test",
  },
  "docker.status": { kind: "docker.status" },
  "stack.status": { kind: "stack.status" },
  "services.inspect": { kind: "services.inspect" },
  "configuration.inspect": { kind: "configuration.inspect" },
  "configuration.sources.inspect": { kind: "configuration.sources.inspect" },
  "configurationMaintenance.prepare": {
    kind: "configurationMaintenance.prepare",
    ...maintenanceBinding,
  },
  "configurationMaintenance.inspect": {
    kind: "configurationMaintenance.inspect",
    maintenanceId: maintenanceBinding.maintenanceId,
    candidateId: maintenanceBinding.candidateId,
  },
  "configurationMaintenance.decide": {
    kind: "configurationMaintenance.decide",
    ...maintenanceIdentity,
    decisionId: "44444444-4444-4444-8444-444444444444",
    decision: "abandon",
    expectedSequence: 1,
    checkpointVersion: 1,
    checkpointDigest: "e".repeat(64),
  },
  "configurationMaintenance.settle": {
    kind: "configurationMaintenance.settle",
    ...maintenanceIdentity,
    decisionId: "44444444-4444-4444-8444-444444444444",
    expectedSequence: 2,
    evidenceDigest: "f".repeat(64),
  },
  "configuration.hardlinks.preview": {
    kind: "configuration.hardlinks.preview",
    candidateId: maintenanceBinding.candidateId,
    revisionId: maintenanceBinding.revisionId,
    expectedCurrentRevisionId: null,
    expectedSourceRevision: maintenanceBinding.expectedSourceRevision,
    coordinatorMode: "ensure-running",
  },
  "configuration.hardlinks.apply": {
    kind: "configuration.hardlinks.apply",
    revisionId: maintenanceBinding.revisionId,
    coordinatorMode: "ensure-running",
  },
  "configuration.hardlinks.inspect": {
    kind: "configuration.hardlinks.inspect",
    revisionId: `cfg1_${"a".repeat(43)}`,
  },
  "stack.render": {
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
    coordinatorMode: "ensure-running",
    kind: "stack.render",
    revisionId: "config_20260823",
  },
  "stack.start": { kind: "stack.start", expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}` },
  "stack.stop": { kind: "stack.stop" },
  "service.start": {
    kind: "service.start",
    serviceId: "motis",
    expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
  },
  "service.stop": { kind: "service.stop", serviceId: "motis" },
  "service.restart": { kind: "service.restart", serviceId: "motis" },
  "coreService.restart": {
    kind: "coreService.restart",
    serviceId: "app-api",
    expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
  },
  "service.recreate": {
    kind: "service.recreate",
    serviceId: "motis",
    expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
  },
  "service.recreateIsolated": {
    kind: "service.recreateIsolated",
    serviceId: "motis",
    expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
  },
  "service.image.stage": {
    kind: "service.image.stage",
    serviceId: "data-manager",
    expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
  },
  "service.pull": {
    kind: "service.pull",
    serviceId: "motis",
    expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
  },
  "service.remove": { kind: "service.remove", serviceId: "motis" },
  "service.update": {
    kind: "service.update",
    serviceId: "motis",
    expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
  },
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
  "release.clear": { kind: "release.clear", releaseId: "checked-release" },
  "release.apply": { kind: "release.apply", releaseId: "2026.08.23" },
  "appApi.replace": {
    kind: "appApi.replace",
    releaseId: "2026.08.23",
    updateJobId: "update_20260823",
  },
  "appApi.runtime.inspect": { kind: "appApi.runtime.inspect" },
  "agent.update": {
    kind: "agent.update",
    releaseId: "release-123",
    expectedDigest: "a".repeat(64),
    handoffId: "handoff-123",
  },
  "agent.handoff.inspect": { kind: "agent.handoff.inspect", handoffId: "handoff-123" },
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
    expectedDigest: "a".repeat(64),
    releaseId: "2026.08.23",
    createBackup: true,
    backupId: "pre-update-20260823",
  },
  "serviceRepository.inspect": {
    kind: "serviceRepository.inspect",
    url: "https://github.com/example/maps-services",
    ref: "v1.2.0",
  },
  "serviceRepository.publish": {
    kind: "serviceRepository.publish",
    url: "https://github.com/example/maps-services",
    commit: "a".repeat(40),
    extensionId: "maps-bundle",
    recovery: {
      selectionBefore: ["postgis"],
      touchedServiceIds: ["maps-tiles"],
      previouslyEnabledServiceIds: [],
    },
  },
  "serviceRepository.settle": {
    kind: "serviceRepository.settle",
    repository: "0123456789abcdef",
    transactionId: `txn1_${"b".repeat(24)}`,
    outcome: "commit",
  },
  "serviceRepository.remove": {
    kind: "serviceRepository.remove",
    repository: "0123456789abcdef",
    extensionId: "maps-bundle",
  },
  "communityServices.inspect": { kind: "communityServices.inspect" },
  "serviceSelection.apply": {
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
    coordinatorMode: "ensure-running",
    kind: "serviceSelection.apply",
    revisionId: "selection_20260823",
  },
  "serviceSelection.inspect": { kind: "serviceSelection.inspect" },
  "serviceConfig.apply": {
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
    coordinatorMode: "ensure-running",
    kind: "serviceConfig.apply",
    serviceId: "motis",
    revisionId: "config_20260823",
  },
  "integrationConfig.apply": {
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
    coordinatorMode: "ensure-running",
    kind: "integrationConfig.apply",
    integrationId: "routing",
    revisionId: "config_20260823",
  },
  "vault.apply": {
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
    coordinatorMode: "ensure-running",
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
  "data.overturePull": { kind: "data.overturePull", regionId: "europe/germany" },
  "data.overtureIngest": { kind: "data.overtureIngest", regionId: "europe/germany" },
  "data.overtureExtract": { kind: "data.overtureExtract", regionId: "europe/germany" },
  "data.overtureConflate": {
    kind: "data.overtureConflate",
    regionId: "europe/germany",
    restart: true,
  },
  "data.searchIndexBuild": {
    kind: "data.searchIndexBuild",
    regionId: "europe/germany",
  },
  "data.notablePlacesBuild": { kind: "data.notablePlacesBuild" },
  "motis.staging.restart": { kind: "motis.staging.restart" },
  "motis.staging.stop": { kind: "motis.staging.stop" },
  "motis.primary.restart": { kind: "motis.primary.restart" },
  "motis.primary.stop": { kind: "motis.primary.stop" },
  "motis.primary.promote": { kind: "motis.primary.promote", preparedRunId: "run_20260823" },
  "feedProxy.validateAndReload": {
    kind: "feedProxy.validateAndReload",
    candidateId: "candidate_20260823",
  },
  "valhalla.traffic.disable": { kind: "valhalla.traffic.disable" },
  "valhalla.traffic.inspect": { kind: "valhalla.traffic.inspect" },
  "valhalla.traffic.maintain": {
    kind: "valhalla.traffic.maintain",
    plan: "rebuild-extract",
  },
  "valhalla.traffic.refreshWaysToEdges": { kind: "valhalla.traffic.refreshWaysToEdges" },
  "postgis.capacity.inspect": { kind: "postgis.capacity.inspect" },
  "catalogPins.inspect": { kind: "catalogPins.inspect" },
  "transitCredentials.inspect": {
    kind: "transitCredentials.inspect",
    catalogRevisionId: "a".repeat(64),
  },
  "transitousLock.inspect": { kind: "transitousLock.inspect" },
  "transitousLock.propose": {
    kind: "transitousLock.propose",
    proposalId: "00000000-0000-4000-8000-000000000001",
    baseGenerationId: null,
    pins: createCatalogPinSet(
      {
        ref: `main@${"a".repeat(40)}`,
        submodules: { "transitland-atlas": "b".repeat(40) },
        lockedAt: issuedAt,
        lockedBy: "fixture-actor",
      },
      {
        schemaVersion: 1,
        source: "mobilitydata-gbfs",
        commit: "c".repeat(40),
        url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"c".repeat(40)}/systems.csv`,
        sha256: "d".repeat(64),
        lockedAt: issuedAt,
        lockedBy: "fixture-actor",
      },
    ),
    diffDigest: "e".repeat(64),
    sourcePolicyRevision: "f".repeat(64),
  },
  "transitousLock.approve": {
    kind: "transitousLock.approve",
    proposalId: "00000000-0000-4000-8000-000000000001",
    validationId: "00000000-0000-4000-8000-000000000002",
    expectedGenerationId: null,
    diffDigest: "a".repeat(64),
    acknowledgeLicenseChanges: false,
  },
  "gbfsCatalogLock.inspect": { kind: "gbfsCatalogLock.inspect" },
};

it("compares projections independent of object ordering while preserving array and value identity", () => {
  const digest = configurationProjectionFingerprint({
    label: "before",
    nested: { a: 1, b: [true, false] },
  });
  expect(
    configurationProjectionFingerprint({ nested: { b: [true, false], a: 1 }, label: "before" }),
  ).toBe(digest);
  expect(
    configurationProjectionFingerprint({ label: "after", nested: { a: 1, b: [true, false] } }),
  ).not.toBe(digest);
  expect(
    configurationProjectionFingerprint({ label: "before", nested: { a: 1, b: [false, true] } }),
  ).not.toBe(digest);
});

describe("ops contract", () => {
  it.each([
    "stack.start",
    "service.start",
    "service.stop",
    "service.restart",
    "service.recreate",
    "service.recreateIsolated",
    "service.remove",
  ] as const)("bounds %s with shutdown grace and settlement overhead", (kind) => {
    expect(OPS_KIND_POLICIES[kind]).toMatchObject({
      execution: "async",
      role: "api",
      timeoutMs: 630_000,
    });
  });

  it("retains short operation budgets and expands long build budgets", () => {
    for (const [kind, timeoutMs] of [
      ["docker.status", 5_000],
      ["stack.status", 15_000],
      ["stack.render", 120_000],
      ["service.logs", 30_000],
      ["service.logs.follow", 900_000],
      ["service.pull", 900_000],
      ["service.build", 43_200_000],
      ["services.buildAll", 86_400_000],
      ["stack.stop", 300_000],
      ["service.update", 900_000],
    ] as const)
      expect(OPS_KIND_POLICIES[kind].timeoutMs).toBe(timeoutMs);
  });
  it("freezes one strict schema for every inventoried typed effect", () => {
    expect(Object.keys(samples).sort()).toEqual([...OPS_OPERATION_KINDS].sort());
    for (const operation of Object.values(samples)) {
      // Take the role from the policy table rather than re-deriving it from a
      // kind prefix: a prefix list silently omits every kind added later.
      const role: OpsRole = OPS_KIND_POLICIES[operation.kind].role;
      if (operation.kind === "data.generateApiKeys") {
        expect(() => parseOpsRequest(request(operation), { role })).toThrow(/not permitted/);
        continue;
      }
      expect(() => parseOpsRequest(request(operation), { role }), operation.kind).not.toThrow();
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
          manifestDigest: "f".repeat(64),
          formatVersion: 2,
          verified: true,
          volumes: [
            {
              serviceId: "postgis",
              volumeId: "db",
              mode: "pg_dump",
              sizeBytes: 42,
              sha256: "a".repeat(64),
            },
          ],
          serviceCount: 1,
          volumeCount: 1,
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
    for (const invalidEntry of [
      { ...inventory.backups[0], formatVersion: 1 },
      { ...inventory.backups[0], formatVersion: undefined },
      { ...inventory.backups[0], verified: undefined },
      { ...inventory.backups[0], manifestDigest: undefined },
      {
        ...inventory.backups[0],
        volumes: [{ ...inventory.backups[0]?.volumes?.[0], sha256: null }],
      },
    ]) {
      expect(() =>
        parseOpsResult("backup.list", { backups: [invalidEntry], warningCount: 0 }),
      ).toThrow();
    }
  });

  it("binds the system-update backup option without accepting an implicit path", () => {
    expect(
      parseOpsRequest(
        request({
          kind: "system.update",
          expectedDigest: "a".repeat(64),
          releaseId: "release-1",
          createBackup: true,
          backupId: "pre-update-job-1",
        }),
        { role: "api" },
      ).operation,
    ).toMatchObject({ createBackup: true, backupId: "pre-update-job-1" });
    expect(
      parseOpsRequest(
        request({
          kind: "system.update",
          expectedDigest: "a".repeat(64),
          releaseId: "release-1",
          createBackup: false,
        }),
        { role: "api" },
      ).operation,
    ).toEqual({
      kind: "system.update",
      expectedDigest: "a".repeat(64),
      releaseId: "release-1",
      createBackup: false,
    });
    for (const operation of [
      {
        kind: "system.update",
        expectedDigest: "a".repeat(64),
        releaseId: "release-1",
        createBackup: true,
      },
      {
        kind: "system.update",
        expectedDigest: "a".repeat(64),
        releaseId: "release-1",
        createBackup: false,
        backupId: "unexpected",
      },
      {
        kind: "system.update",
        expectedDigest: "a".repeat(64),
        releaseId: "release-1",
        createBackup: false,
        path: "/host",
      },
    ]) {
      expect(() => parseOpsRequest(request(operation), { role: "api" })).toThrow();
    }
    expect(
      opsResourceId({
        kind: "system.update",
        expectedDigest: "a".repeat(64),
        releaseId: "release-1",
        createBackup: false,
      }),
    ).toBe("release-1");
  });

  it("accepts bounded data inventory paging and validates its typed result", () => {
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
        items: [
          {
            artifactId: "a".repeat(64),
            filename: "synthetic.osm.pbf",
            region: "test",
            sizeBytes: 42,
            modifiedAt: "2026-08-23T18:00:00.000Z",
            sourceFingerprint: null,
            fingerprintState: "missing",
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
        unavailable: false,
      },
      builds: [
        {
          target: "valhalla",
          built: false,
          readiness: "unknown",
          reason: "Synthetic readiness unavailable",
          sizeBytes: null,
          sourceFingerprints: [],
          buildRecordVersion: null,
          region: null,
          runtimeImages: {},
        },
      ],
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
    const fullPage = {
      ...inventory,
      osm: {
        items: Array.from({ length: 500 }, (_, i) => ({
          artifactId: i.toString(16).padStart(64, "0"),
          filename: "f".repeat(220) + ".osm.pbf",
          region: "r".repeat(220),
          sizeBytes: 42,
          modifiedAt: "2026-08-23T18:00:00.000Z",
          sourceFingerprint: "a".repeat(64),
          fingerprintState: "verified",
        })),
        total: 500,
        offset: 0,
        limit: 500,
        unavailable: false,
      },
    };
    expect(() => parseBoundedOpsResult("data.inspect", fullPage)).not.toThrow();
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
    const complete = {
      ...result,
      services: ["app-api", "app-web", "data-manager", "ops-agent", "transitous-runner"].map(
        (serviceId) => ({ ...result.services[0], serviceId }),
      ),
    };
    expect(parseOpsResult("system.inspect", complete)).toEqual(complete);
    expect(() =>
      parseOpsResult("system.inspect", {
        ...complete,
        services: [...complete.services, complete.services[0]],
      }),
    ).toThrow();
    for (const invalid of [
      { ...result, services: [{ ...result.services[0], state: "up-to-date" }] },
      { ...result, services: [{ ...result.services[0], localImageId: null }] },
      { ...result, containerName: "app-api-1" },
    ]) {
      expect(() => parseOpsResult("system.inspect", invalid)).toThrow();
    }
  });

  describe.each(["motis.primary.stop", "motis.staging.stop"] as const)(
    "%s confirmation",
    (kind) => {
      it.each([
        { changed: true, state: "stopped" },
        { changed: false, state: "stopped" },
        { changed: false, state: "absent" },
        { changed: true, state: "absent" },
      ])("accepts a confirmed result %j", (result) => {
        expect(parseOpsResult(kind, result)).toEqual(result);
      });

      it.each([
        { changed: true },
        { changed: false, state: "running" },
        { changed: false, state: "unknown" },
        { changed: true, state: "stopped", environment: ["SECRET=value"] },
      ])("rejects legacy or unconfirmed result %j", (result) => {
        expect(() => parseOpsResult(kind, result)).toThrow();
      });

      it("keeps stop authority limited to the data-manager", () => {
        expect(authorizeOpsOperation("data-manager", kind)).toBe(true);
        expect(authorizeOpsOperation("api", kind)).toBe(false);
      });
    },
  );

  it("authorizes roles from the operation kind without inspecting operation arguments", () => {
    expect(authorizeOpsOperation("api", "catalogPins.inspect")).toBe(true);
    expect(authorizeOpsOperation("data-manager", "catalogPins.inspect")).toBe(true);
    expect(authorizeOpsOperation("data-manager", "configuration.inspect")).toBe(false);
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

  it("binds community repository operations to exact, bounded identities", () => {
    const publish = {
      kind: "serviceRepository.publish",
      url: "https://github.com/example/maps-services",
      commit: "a".repeat(40),
      extensionId: "maps-bundle",
      recovery: { selectionBefore: null, touchedServiceIds: [], previouslyEnabledServiceIds: [] },
    };
    expect(parseOpsRequest(request(publish), { role: "api" }).operation).toEqual(publish);
    for (const operation of [
      { ...publish, url: "http://github.com/example/maps-services" },
      { ...publish, url: "ssh://git@github.com/example/maps-services" },
      { ...publish, url: "https://github.com/example/maps services" },
      { ...publish, url: "https://github.com/example/maps-services?ref=main" },
      { ...publish, commit: "a".repeat(7) },
      { ...publish, commit: "A".repeat(40) },
      { ...publish, recovery: { ...publish.recovery, touchedServiceIds: ["../x"] } },
      { ...publish, recovery: { ...publish.recovery, directory: "/tmp" } },
      { kind: "serviceRepository.inspect", url: publish.url, ref: "--upload-pack=x" },
      {
        kind: "serviceRepository.settle",
        repository: "0123456789abcdef",
        transactionId: "txn1_short",
        outcome: "commit",
      },
      {
        kind: "serviceRepository.settle",
        repository: "0123456789abcdef",
        transactionId: `txn1_${"b".repeat(24)}`,
        outcome: "discard",
      },
      { kind: "serviceRepository.remove", repository: "../services", extensionId: "maps-bundle" },
      { kind: "communityServices.inspect", repository: "0123456789abcdef" },
    ]) {
      expect(
        () => parseOpsRequest(request(operation), { role: "api" }),
        JSON.stringify(operation),
      ).toThrow(OpsContractError);
    }
    expect(() => parseOpsRequest(request(publish), { role: "data-manager" })).toThrow(
      OpsContractError,
    );
    expect(
      opsResourceId({
        kind: "serviceRepository.remove",
        repository: "0123456789abcdef",
        extensionId: "maps-bundle",
      }),
    ).toBe("0123456789abcdef");
  });

  it("bounds community repository inspection results", () => {
    const inspection = {
      url: "https://github.com/example/maps-services",
      repository: "0123456789abcdef",
      commit: "a".repeat(40),
      valid: false,
      problems: ["service.json: invalid"],
      services: [{ path: "tiles", manifest: { id: "maps-tiles" } }],
    };
    expect(parseOpsResult("serviceRepository.inspect", inspection)).toEqual(inspection);
    expect(() =>
      parseOpsResult("serviceRepository.inspect", {
        ...inspection,
        problems: Array.from({ length: 65 }, () => "x"),
      }),
    ).toThrow();
    expect(() =>
      parseOpsResult("serviceRepository.inspect", { ...inspection, checkout: "/srv" }),
    ).toThrow();
  });
});

it("fix1 reads only the actual historical or exact v2 admission projection", async () => {
  const { parseOpsAdmission } = await import("./contract");
  const historical = {
    execution: "async",
    operationId: "job1_0123456789abcdef",
    operationKey: "opk1_0123456789abcdef",
    kind: "service.build",
    state: "queued",
  };
  expect(parseOpsAdmission(historical)).toEqual(historical);
  for (const extra of [{ version: 1 }, { deadlineAt: 10 }, { parent: {} }, { unexpected: true }])
    expect(() => parseOpsAdmission({ ...historical, ...extra })).toThrow();
  expect(
    parseOpsAdmission({
      ...historical,
      version: 2,
      admittedAt: 1,
      deadlineAt: 2,
      fingerprint: "a".repeat(64),
    }),
  ).toMatchObject({ version: 2 });
});
