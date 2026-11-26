import { describe, expect, it } from "vitest";
import { createCatalogPinSet } from "../catalog-pins/generation";
import {
  MAX_RECORDED_INVENTORY_BYTES,
  recordedInventoryBytes,
  recordedSourceBytes,
} from "../services/integration-records";
import { prepareConfigurationCandidate } from "./configuration-preparation";
import {
  authorizeOpsOperation,
  isTrustedConfigurationApplyOperation,
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
const candidatePayload = {
  domain: "maps.example.test",
  serviceConfigs: [],
  integrationConfigs: [],
  serviceSecrets: [],
};
const preparedCandidate = prepareConfigurationCandidate({
  role: "api",
  operationKey: "opk1_0123456789abcdef",
  payload: candidatePayload,
  issuedAtMs: Date.parse("2026-08-24T08:00:00.000Z"),
  nonce: "nonce_0123456789abcdef",
  operationForRevision: (revisionId, payloadDigest) => ({
    kind: "stack.render",
    revisionId,
    payloadDigest,
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
    coordinatorMode: "ensure-running",
  }),
});
const samples: Record<(typeof OPS_OPERATION_KINDS)[number], OpsOperation> = {
  "artifactTransfer.capabilities": { kind: "artifactTransfer.capabilities", ownerId: "admin" },
  "artifactTransfer.export": {
    kind: "artifactTransfer.export",
    serviceId: "osrm",
    ownerId: "admin",
    expectedArtifactFingerprint: "a".repeat(64),
  },
  "artifactTransfer.previewImport": {
    kind: "artifactTransfer.previewImport",
    stageId: transferClaim.stageId,
    ownerId: "admin",
  },
  "artifactTransfer.import": {
    kind: "artifactTransfer.import",
    stageId: transferClaim.stageId,
    ownerId: "admin",
    expectedSha256: "a".repeat(64),
    previewFingerprint: "b".repeat(64),
    expectedCurrentRevisionId: null,
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
  "artifactTransfer.validate": {
    kind: "artifactTransfer.validate",
    stageId: transferClaim.stageId,
    ownerId: "admin",
    purpose: "prepared-artifact",
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
  },
  "configurationMaintenance.apply": {
    kind: "configurationMaintenance.apply",
    maintenanceId: maintenanceBinding.maintenanceId,
  },
  "configurationMaintenance.settle": {
    kind: "configurationMaintenance.settle",
    maintenanceId: maintenanceBinding.maintenanceId,
    outcome: "abandon",
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
  "configuration.candidate.retain": {
    kind: "configuration.candidate.retain",
    record: {
      version: 1,
      candidateId: "22222222-2222-4222-8222-222222222222",
      operationKey: "opk1_0123456789abcdef",
      operation: preparedCandidate.operation,
      sourceFingerprint: "a".repeat(64),
      expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
      snapshot: preparedCandidate.snapshot,
      payload: candidatePayload,
      privateOverlay: {},
      apiJobId: "33333333-3333-4333-8333-333333333333",
      actorId: "admin",
      parentOperationKey: "opk1_0123456789abcdef",
      parentFingerprint: "a".repeat(64),
      parentDeadlineAt: 1,
      affectedServiceIds: [],
      maintenanceId: null,
      prepareOperationKey: null,
    },
  },
  "configuration.candidate.read": {
    kind: "configuration.candidate.read",
    lookup: { candidateId: "22222222-2222-4222-8222-222222222222" },
  },
  "configuration.candidate.discard": {
    kind: "configuration.candidate.discard",
    operationKey: "opk1_0123456789abcdef",
  },
  "configuration.failure.inspect": {
    kind: "configuration.failure.inspect",
    attemptedRevisionId: `cfg1_${"a".repeat(43)}`,
  },
  "stack.render": {
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
    coordinatorMode: "ensure-running",
    kind: "stack.render",
    revisionId: "config_20260823",
    payloadDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
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
    serviceId: "api",
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
  "release.images.pull": {
    kind: "release.images.pull",
    releaseId: "2026.08.23",
    manifestDigest: "a".repeat(64),
  },
  "release.inspect": { kind: "release.inspect" },
  "release.clear": { kind: "release.clear", releaseId: "checked-release" },
  "backup.list": { kind: "backup.list" },
  "backup.create": { kind: "backup.create", backupId: "pre-update-20260823" },
  "backup.restore": {
    kind: "backup.restore",
    backupId: "pre-update-20260823",
    serviceIds: ["postgis"],
    stopRunning: true,
  },
  "backup.delete": { kind: "backup.delete", backupId: "pre-update-20260823" },
  "backup.prune.preview": { kind: "backup.prune.preview" },
  "backup.prune": {
    kind: "backup.prune",
    proof: {
      inventoryDigest: "a".repeat(64),
      policyRevision: "b".repeat(64),
      previewedAt: issuedAt,
      expiresAt,
      authenticator: "c".repeat(64),
    },
  },
  "system.diagnostics": { kind: "system.diagnostics" },
  "system.inspect": { kind: "system.inspect" },
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
  "catalogIntegration.inspect": {
    kind: "catalogIntegration.inspect",
    source: {
      kind: "artifact",
      url: "https://example.test/weather-radar-1.0.0.tar.gz",
      sha256: "c".repeat(64),
    },
  },
  "catalogIntegration.publish": {
    kind: "catalogIntegration.publish",
    integrationId: "weather-radar",
    source: { kind: "upload", sha256: "c".repeat(64) },
    extensionId: "maps-bundle",
  },
  "catalogIntegration.settle": {
    kind: "catalogIntegration.settle",
    integrationId: "weather-radar",
    transactionId: `itx1_${"d".repeat(24)}`,
    outcome: "rollback",
  },
  "catalogIntegration.remove": {
    kind: "catalogIntegration.remove",
    integrationId: "weather-radar",
    extensionId: "maps-bundle",
  },
  "installedIntegrations.inspect": { kind: "installedIntegrations.inspect" },
  "serviceSelection.apply": {
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
    coordinatorMode: "ensure-running",
    kind: "serviceSelection.apply",
    revisionId: "selection_20260823",
    payloadDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  },
  "serviceSelection.inspect": { kind: "serviceSelection.inspect" },
  "serviceConfig.apply": {
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
    coordinatorMode: "ensure-running",
    kind: "serviceConfig.apply",
    serviceId: "motis",
    revisionId: "config_20260823",
    payloadDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  },
  "integrationConfig.apply": {
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
    coordinatorMode: "ensure-running",
    kind: "integrationConfig.apply",
    integrationId: "routing",
    revisionId: "config_20260823",
    payloadDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  },
  "vault.apply": {
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
    coordinatorMode: "ensure-running",
    kind: "vault.apply",
    serviceId: "motis",
    revisionId: "vault_20260823",
    payloadDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
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
  "transitousPin.inspect": { kind: "transitousPin.inspect" },
  "lease.acquire": {
    kind: "lease.acquire",
    owner: {
      executor: "data-manager",
      principal: "data-manager",
      executionId: "91a78b3e-208b-4ba4-9ddf-870fbdf1da22",
      operationKey: "opk1_AAAAAAAAAAAAAAAAAAAA",
      operationFingerprint: "a".repeat(64),
      fingerprint: "b".repeat(64),
      deadlineAt: 1_900_000_000_000,
    },
    ownerKind: "data.update",
    targets: ["motis"],
  },
  "lease.read": { kind: "lease.read", leaseId: "91a78b3e-208b-4ba4-9ddf-870fbdf1da22" },
  "lease.update": {
    kind: "lease.update",
    leaseId: "91a78b3e-208b-4ba4-9ddf-870fbdf1da22",
    action: { action: "release" },
  },
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
      // An apply's payload travels beside it and must match its digest.
      if (isTrustedConfigurationApplyOperation(operation)) {
        expect(() => parseOpsRequest(request(operation), { role })).toThrow(/Invalid/);
        continue;
      }
      expect(parseOpsRequest(request(operation), { role }).operation).toEqual(operation);
    }
  });

  it("rejects unknown fields and every general-runner escape hatch", () => {
    expect(parseOpsRequest(request(samples["service.start"]), { role: "api" }).operation).toEqual(
      samples["service.start"],
    );
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
        parseOpsRequest(request({ ...samples["service.start"], [field]: "x" }), {
          role: "api",
        }),
      ).toThrow(OpsContractError);
    }
  });

  it.each([
    "https://sentinel-user:sentinel-password@example.test/integration.tgz",
    "https://example.test/integration.tgz?token=sentinel-query",
    "https://example.test/integration.tgz#sentinel-fragment",
  ])("rejects unsafe integration artifact locators before agent dispatch: %s", (url) => {
    const source = { kind: "artifact", url, sha256: "a".repeat(64) };
    for (const operation of [
      { kind: "catalogIntegration.inspect", source },
      { kind: "catalogIntegration.publish", integrationId: "fixture", source },
    ]) {
      expect(() => parseOpsRequest(request(operation), { role: "api" })).toThrow(OpsContractError);
    }
  });

  it("canonicalizes accepted integration artifact locators before dispatch", () => {
    const parsed = parseOpsRequest(
      request({
        kind: "catalogIntegration.inspect",
        source: {
          kind: "artifact",
          url: "https://ARTIFACTS.example.test:443/releases/../integration.tgz",
          sha256: "a".repeat(64),
        },
      }),
      { role: "api" },
    );

    expect(parsed.operation).toEqual({
      kind: "catalogIntegration.inspect",
      source: {
        kind: "artifact",
        url: "https://artifacts.example.test/integration.tgz",
        sha256: "a".repeat(64),
      },
    });
  });

  it("rejects flag-shaped, path-shaped and malformed service IDs", () => {
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
          release: "2026.11.0",
          manifestDigest: "f".repeat(64),
          formatVersion: 1,
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
      { ...inventory.backups[0], formatVersion: 2 },
      { ...inventory.backups[0], formatVersion: undefined },
      { ...inventory.backups[0], release: undefined },
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
      release: {
        currentReleaseId: "release-old",
        availableReleaseId: "release-new",
      },
      services: [
        {
          serviceId: "api",
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
      services: ["api", "web", "data-manager", "ops-agent", "transitous-runner"].map(
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
      { ...result, release: { ...result.release, untrustedField: "unexpected" } },
      { ...result, containerName: "openmapx-api-1" },
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

  it("gives the api role a read-only view of the Transitous pins, and nothing of the lock", () => {
    expect(authorizeOpsOperation("api", "transitousPin.inspect")).toBe(true);
    expect(authorizeOpsOperation("data-manager", "transitousPin.inspect")).toBe(false);
    for (const kind of [
      "transitousLock.inspect",
      "transitousLock.propose",
      "transitousLock.approve",
    ] as const) {
      expect(authorizeOpsOperation("api", kind)).toBe(false);
    }
    const pin = {
      ref: `main@${"a".repeat(40)}`,
      submodules: { "transitland-atlas": "b".repeat(40) },
      lockedAt: "2026-10-25T00:00:00.000Z",
      lockedBy: "dev@example.test",
    };
    expect(parseOpsResult("transitousPin.inspect", { release: pin, active: pin })).toEqual({
      release: pin,
      active: pin,
    });
    expect(() =>
      parseOpsResult("transitousPin.inspect", { release: pin, active: pin, proposed: pin }),
    ).toThrow();
  });

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

  it("reports the largest set of installed integrations the agent admits in one inspection", () => {
    // 256 integrations with the longest ids, reason and artifact URL, each with
    // one file of quotes so that the inventory budget is used to the byte.
    const id = (prefix: string, i: number) => `${prefix.repeat(44)}${String(i).padStart(4, "0")}`;
    const url = `https://artifacts.example.test/${"u".repeat(2048 - 31)}`;
    const integrations = Array.from({ length: 256 }, (_, i) => ({
      integrationId: id("a", i),
      extensionId: id("e", i),
      status: "needs_reinstall" as const,
      reason: "r".repeat(1_024),
      source: { kind: "artifact" as const, url, sha256: "0".repeat(64) },
      files: [{ path: '"'.repeat(207), sha256: "0".repeat(64) }],
      pending: { transactionId: `itx1_${"0".repeat(24)}` },
    }));
    expect(
      integrations.reduce(
        (total, entry) =>
          total + recordedInventoryBytes(entry.files) + recordedSourceBytes(entry.source),
        0,
      ),
    ).toBe(MAX_RECORDED_INVENTORY_BYTES);
    const result = {
      integrations,
      unrecorded: Array.from({ length: 256 }, (_, i) => id("d", i)),
    };
    const bytes = new TextEncoder().encode(
      JSON.stringify(parseOpsResult("installedIntegrations.inspect", result)),
    ).byteLength;
    expect(bytes).toBeLessThan(OPS_KIND_POLICIES["installedIntegrations.inspect"].maxResultBytes);
    expect(() => parseBoundedOpsResult("installedIntegrations.inspect", result)).not.toThrow();
  });
});

it("reads only an exact current-version admission with its execution identity", async () => {
  const { parseOpsAdmission } = await import("./contract");
  const admission = {
    version: 1,
    execution: "async",
    operationId: "job1_0123456789abcdef",
    operationKey: "opk1_0123456789abcdef",
    kind: "service.build",
    state: "queued",
    admittedAt: 1,
    deadlineAt: 2,
    fingerprint: "a".repeat(64),
  };
  expect(parseOpsAdmission(admission)).toEqual(admission);
  const { version: _version, admittedAt: _admittedAt, ...withoutIdentity } = admission;
  for (const candidate of [
    withoutIdentity,
    { ...admission, version: 2 },
    { ...admission, deadlineAt: 1 },
    { ...admission, parent: {} },
    { ...admission, unexpected: true },
  ])
    expect(() => parseOpsAdmission(candidate)).toThrow();
});

it("refuses a request body of another protocol version", () => {
  expect(() =>
    parseOpsRequest(request({ kind: "docker.status" }, { version: 2 }), { role: "api" }),
  ).toThrow(OpsContractError);
});
