import { createRequire } from "node:module";
import { serviceManifestSchema } from "@openmapx/extension-contracts/service";
import { describe, expect, it } from "vitest";
import { OPS_RESULT_SCHEMAS } from "../../ops/contract";
import { SERVICE_ACTIONS } from "../../ops/service-results";
import { routeJsonSchema } from "../schema";
import type { AdminOperation } from "./admin";
import * as contracts from "./index";

const acquisition = { state: "available", reason: null };
const actions = Object.fromEntries(
  SERVICE_ACTIONS.map((action) => [
    action,
    { available: false, execution: "direct", reason: "unavailable", workflow: null },
  ]),
);
const at = "2026-10-21T10:00:00.000Z";
const inventory = [
  ["listAdminArtifactTransfers", "GET", "/artifact-transfers"],
  ["createAdminArtifactTransfer", "POST", "/artifact-transfers"],
  ["getAdminArtifactTransfer", "GET", "/artifact-transfers/:stageId"],
  ["deleteAdminArtifactTransfer", "DELETE", "/artifact-transfers/:stageId"],
  ["uploadAdminArtifactTransferContent", "PUT", "/artifact-transfers/:stageId/content"],
  ["downloadAdminArtifactTransferContent", "GET", "/artifact-transfers/:stageId/content"],
  ["getAdminPlatformConfiguration", "GET", "/platform/configuration"],
  ["previewAdminPlatformConfiguration", "POST", "/platform/configuration/preview"],
  ["listAdminServices", "GET", "/services"],
  ["getAdminService", "GET", "/services/:id"],
  ["getAdminServiceConfig", "GET", "/services/:id/config"],
  ["updateAdminServiceConfig", "POST", "/services/:id/config"],
  ["getAdminServiceCredentials", "GET", "/services/:id/credentials"],
  ["setAdminServiceCredential", "PUT", "/services/:id/credentials/:key"],
  ["deleteAdminServiceCredential", "DELETE", "/services/:id/credentials/:key"],
  ["streamAdminServiceLogs", "GET", "/services/:id/logs"],
  ["runAdminServiceAction", "POST", "/services/:id/action"],
  ["runAdminServicesBulkAction", "POST", "/services/bulk-action"],
  ["checkAdminServices", "POST", "/services/check"],
  ["getAdminServiceData", "GET", "/services/data"],
  ["getAdminServiceSelection", "GET", "/services/selection"],
  ["setAdminServiceSelection", "PUT", "/services/selection"],
  ["listAdminServiceBackups", "GET", "/services/backups"],
  ["createAdminServiceBackup", "POST", "/services/backups"],
  ["restoreAdminServiceBackup", "POST", "/services/backups/:name/restore"],
  ["deleteAdminServiceBackup", "DELETE", "/services/backups/:name"],
  ["getAdminDeployment", "GET", "/deployment"],
  ["getAdminComposePreview", "GET", "/compose/preview"],
  ["startAdminCompose", "POST", "/compose/up"],
  ["stopAdminCompose", "POST", "/compose/down"],
  ["listAdminOperations", "GET", "/operations"],
  ["previewAdminOperation", "POST", "/operations/:id/preview"],
  ["runAdminOperation", "POST", "/operations/:id/run"],
  ["getAdminSharedMobility", "GET", "/shared-mobility"],
  ["rollbackAdminSharedMobility", "POST", "/shared-mobility/:category/rollback"],
  ["getAdminDawarich", "GET", "/dawarich"],
  ["provisionAdminDawarich", "POST", "/dawarich/provision"],
  ["rotateAdminDawarichOidcSecret", "POST", "/dawarich/rotate-oidc-secret"],
];
const raw = {
  id: "sample",
  name: "Sample",
  version: "any version",
  quality: "community",
  container: {
    image: "example/sample",
    tag: "latest",
    gpu: {},
    healthcheck: { type: "exec", command: ["true"], future: { nested: [null, true] } },
    future: { nested: [1, "x"] },
  },
  provides: [
    "routing-engine",
    { capability: "custom/routing", metadata: { nested: [1, null] }, future: false },
  ],
  consumes: [{ type: "osm", mountAt: "/data", instance: "region", future: { nested: true } }],
  exposure: {
    proxy: { enabled: true, additionalRoutes: [{ path: "/x", future: [1] }], future: null },
  },
  configSchema: {
    type: "object",
    properties: { field: { type: "string", default: "raw", "x-future": [false, null] } },
    $defs: { nested: { unknown: true } },
  },
  buildImages: {
    compiler: {
      image: "example/compiler",
      tag: "latest",
      digest: `sha256:${"a".repeat(64)}`,
      future: { nested: [null] },
    },
  },
  ui: { icon: "emoji", category: "custom", future: true },
  future: { complete: [null, false, { nested: "yes" }] },
};
const selection = {
  source: "file",
  selectedRoots: [],
  requestedIds: [],
  effectiveIds: [],
  warnings: [],
  missingIds: [],
  envVarName: "OPENMAPX_SERVICES",
  envVarValue: null,
  selectionFilePath: "/synthetic/services.json",
};
const dawarich = {
  installed: true,
  selected: true,
  running: false,
  healthy: false,
  publicOrigin: null,
  oauthClient: {
    present: true,
    clientId: "synthetic",
    redirectUriMatches: false,
    settingsMatch: true,
    recoveryRequired: true,
  },
  secrets: {
    databasePassword: "consistent",
    secretKeyBase: "missing",
    oidcClientSecret: "conflict",
  },
  configReady: false,
  readyToStart: false,
  needsApply: true,
};
const data = {
  osm: {
    items: [
      {
        artifactId: "a".repeat(64),
        filename: "synthetic.osm.pbf",
        region: "test",
        sizeBytes: 42,
        modifiedAt: at,
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
      target: "motis",
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
    configFound: true,
    datasetCount: 1,
    realtimeFeedCount: 2,
    gbfsFeedCount: 3,
    feedProxyUrlCount: 4,
    gbfsProxyUrl: null,
    feedProxyMode: "mixed",
    feedProxyConfigFound: true,
    feedProxyVarsFound: false,
    feedProxyFeedCount: 5,
    capabilityState: "error",
    capabilityError: "Synthetic",
    activeEpoch: null,
    candidateEpoch: "candidate",
    testedAt: null,
    configHash: "a".repeat(64),
    licenseHash: null,
    rentalProviderCount: 6,
    rentalProviderGroupCount: 7,
    rollbackAvailable: true,
    operationsProfile: "planet",
    activeSlot: "A",
    previousHealthySlot: "B",
    preflightState: "blocked",
    preflightRequiredDiskBytes: 100,
    preflightFreeDiskBytes: null,
    pinProposalPending: true,
    crowdsourceState: "disabled-pending-review",
    gbfsCatalog: {
      state: "error",
      commit: null,
      lockedAt: null,
      registryRows: 1,
      registryAdded: 2,
      transitousPreferred: 3,
      quarantined: 4,
      validationFailed: 5,
      sources: [
        {
          sourceId: "source",
          country: "DE",
          status: "excluded",
          observation: "unknown",
          errorClass: "Synthetic",
          lastObservedSuccess: "unknown",
          lastErrorAt: "unknown",
          dataAge: "unknown",
        },
      ],
    },
  },
};
function response(
  id: keyof typeof contracts.serviceAdminOperations,
  status: number,
  value: unknown,
) {
  const operation: AdminOperation = contracts.serviceAdminOperations[id];
  const contract = operation.responses[status];
  if (!contract || (contract.kind !== "json" && contract.kind !== "text"))
    throw new Error("Expected finite response");
  return contract.schema.parse(value);
}

describe("canonical complete service administration contracts", () => {
  it("binds the complete approved identities, methods, paths and admin auth", () => {
    expect(contracts).toHaveProperty("serviceAdminOperations");
    expect(
      Object.entries(contracts.serviceAdminOperations).map(([id, op]) => [
        id,
        op.method,
        op.path,
        op.auth,
      ]),
    ).toEqual(inventory.map(([id, method, path]) => [id, method, `/api/admin${path}`, "admin"]));
  });
  it("retains full raw manifests including unknown nested JSON, structured capabilities and omitted defaults", () => {
    expect(serviceManifestSchema.parse(raw).container.gpu).toEqual({
      driver: "nvidia",
      count: "all",
      capabilities: ["gpu"],
    });
    expect(contracts.adminServiceManifestSchema.parse(raw)).toEqual(raw);
    const detail = {
      acquisition,
      actions,
      manifest: raw,
      directory: "/synthetic/service",
      isBuiltIn: false,
      enabled: true,
      status: "running",
    };
    expect(response("getAdminService", 200, detail)).toEqual(detail);
    const apiRequire = createRequire(
      new URL("../../../../../../apps/api/package.json", import.meta.url),
    );
    const stringify = createRequire(apiRequire.resolve("fastify"))("fast-json-stringify");
    const definitions: Record<string, unknown> = {};
    const schema = routeJsonSchema(contracts.adminServiceDetailSchema, {
      identity: "ServiceDetailFixture",
      io: "output",
      registerDefinition: (definition) => {
        definitions[definition.$id] = definition;
      },
    });
    expect(JSON.parse(stringify(schema, { schema: definitions })(detail))).toEqual(detail);
  });
  it("retains portable known validators and rejects non-JSON values and unsafe nested keys", () => {
    for (const invalid of [
      { ...raw, name: "" },
      { ...raw, quality: "stable" },
      { ...raw, container: { ...raw.container, image: "INVALID" } },
      { ...raw, container: { ...raw.container, gpu: { count: 0 } } },
      {
        ...raw,
        exposure: {
          proxy: { enabled: true, additionalRoutes: [{ path: "/x", pathPrefix: "/y" }] },
        },
      },
      {
        ...raw,
        subjectData: {
          storesPersonalData: true,
          strategy: "collector",
          registrationIds: [],
          operatorInstructions: null,
        },
      },
      { ...raw, configSchema: { type: "array", properties: {} } },
      { ...raw, provides: [{ capability: "" }] },
      ...[undefined, new Date(), () => 1, NaN, Infinity, 1n, { nested: undefined }].map(
        (future) => ({ ...raw, future }),
      ),
      { ...raw, future: JSON.parse('{"nested":{"__proto__":null}}') },
    ])
      expect(contracts.adminServiceManifestSchema.safeParse(invalid).success).toBe(false);
    // Authoring stays strict and still applies its own defaults; the wire adapter does neither.
    expect(
      serviceManifestSchema.safeParse({
        ...raw,
        subjectData: {
          storesPersonalData: false,
          strategy: "not_personal",
          registrationIds: [],
          operatorInstructions: null,
          future: true,
        },
      }).success,
    ).toBe(false);
  });
  it("keeps list normalized names and config JSON/source fields complete", () => {
    const summary = {
      actions,
      id: raw.id,
      name: raw.name,
      version: raw.version,
      quality: raw.quality,
      provides: ["custom/routing"],
      consumes: raw.consumes,
      exposure: raw.exposure,
      enabled: true,
      isBuiltIn: false,
      status: "not-running",
    };
    const list = {
      acquisition,
      services: [summary],
      summary: { running: 0, stopped: 1, unknown: 0, total: 1 },
    };
    expect(response("listAdminServices", 200, list)).toEqual(list);
    const config = {
      schema: raw.configSchema,
      resolvedConfig: {
        field: { value: { nested: [null, true] }, source: "database" },
        secret: { value: "***", source: "env" },
      },
      envPrefix: "SERVICE_SAMPLE",
    };
    expect(response("getAdminServiceConfig", 200, config)).toEqual(config);
    expect(response("getAdminServiceConfig", 200, { ...config, schema: null })).toEqual({
      ...config,
      schema: null,
    });
    expect(response("updateAdminServiceConfig", 400, { errors: ["Invalid field"] })).toEqual({
      errors: ["Invalid field"],
    });
  });
  it("derives complete data inventory from actual ops schemas and keeps public backup count names", () => {
    expect(OPS_RESULT_SCHEMAS["data.inspect"].parse(data)).toEqual(data);
    expect(response("getAdminServiceData", 200, { ...data, fetchedAt: at })).toEqual({
      ...data,
      fetchedAt: at,
    });
    expect(contracts.adminServiceDataSchema.shape.motisTransitous).toBe(
      OPS_RESULT_SCHEMAS["data.inspect"].shape.motisTransitous,
    );
    expect(
      contracts.adminServiceDataSchema.safeParse({
        ...data,
        fetchedAt: at,
        builds: [{ target: "unknown", built: true }],
      }).success,
    ).toBe(false);
    expect(
      contracts.adminServiceDataSchema.safeParse({
        ...data,
        motisTransitous: { configFound: true },
        fetchedAt: at,
      }).success,
    ).toBe(false);
    const backups = {
      backups: [
        {
          name: "test",
          createdAt: at,
          openmapxVersion: "test",
          serviceCount: 2,
          volumeCount: 3,
          totalBytes: 42,
        },
        {
          name: "corrupt",
          createdAt: at,
          serviceCount: 0,
          volumeCount: 0,
          totalBytes: 0,
          corrupt: true,
          corruptReason: "invalid_manifest",
        },
      ],
      warnings: ["One invalid backup"],
      root: "ops-agent-managed",
    };
    expect(response("listAdminServiceBackups", 200, backups)).toEqual(backups);
    expect(
      contracts.adminServiceBackupsSchema.safeParse({
        ...backups,
        backups: [{ name: "bad", createdAt: at, services: 2, volumes: 3, totalBytes: 42 }],
      }).success,
    ).toBe(false);
  });
  it("requires explicit selection arrays, preserves deliberate empty intent and validates mutation alternatives", () => {
    const ops = contracts.serviceAdminOperations;
    for (const body of [
      undefined,
      null,
      [],
      {},
      { selectedRoots: null },
      { selectedRoots: "sample" },
      { selectedRoots: [1] },
      { selectedRoots: [""] },
      { selectedRoots: [" "] },
      { selectedRoots: [], extra: true },
    ])
      expect(ops.setAdminServiceSelection.request.body.safeParse(body).success).toBe(false);
    expect(ops.setAdminServiceSelection.request.body.parse({ selectedRoots: [] })).toEqual({
      selectedRoots: [],
    });
    expect(response("getAdminServiceSelection", 200, selection)).toEqual(selection);
    const saved = { ok: true, revisionId: "revision", summary: selection };
    expect(response("setAdminServiceSelection", 200, saved)).toEqual(saved);
    for (const body of [
      { action: "start", serviceIds: ["sample"] },
      { action: "build", all: true },
      { action: "build", serviceIds: ["sample"], region: "test", continueOnError: false },
    ])
      expect(ops.runAdminServicesBulkAction.request.body.safeParse(body).success).toBe(true);
    for (const body of [
      { action: "build" },
      { action: "stop", serviceIds: [] },
      { action: "start", serviceIds: ["sample"], all: true },
      { action: "build", all: "true" },
    ])
      expect(ops.runAdminServicesBulkAction.request.body.safeParse(body).success).toBe(false);
    for (const id of [
      "createAdminServiceBackup",
      "restoreAdminServiceBackup",
      "deleteAdminServiceBackup",
      "checkAdminServices",
      "startAdminCompose",
      "stopAdminCompose",
      "deleteAdminServiceCredential",
      "provisionAdminDawarich",
    ] as const) {
      expect(ops[id].request.body.safeParse(undefined).success).toBe(true);
      expect(ops[id].request.body.safeParse(null).success).toBe(false);
      expect(ops[id].request.body.safeParse({ unexpected: true }).success).toBe(false);
    }
    expect(
      ops.restoreAdminServiceBackup.request.body.parse({ serviceIds: [], stopRunning: true }),
    ).toEqual({ serviceIds: [], stopRunning: true });
    for (const body of [{ serviceIds: "sample" }, { serviceIds: [false] }, { stopRunning: "true" }])
      expect(ops.restoreAdminServiceBackup.request.body.safeParse(body).success).toBe(false);
    // Blank optional text retains the producer's auto-name/default-region intent.
    expect(ops.createAdminServiceBackup.request.body.parse({ name: "   " })).toEqual({ name: "" });
    expect(
      ops.runAdminServicesBulkAction.request.body.parse({
        action: "build",
        all: true,
        region: "   ",
      }),
    ).toEqual({ action: "build", all: true, region: "" });
    expect(ops.updateAdminServiceConfig.request.body.parse({ config: {} })).toEqual({ config: {} });
    // Operation-specific interpretation and normalization remain catalog-owned.
    expect(
      ops.previewAdminOperation.request.body.parse({ countries: "de,at", failFast: false }),
    ).toEqual({ countries: "de,at", failFast: false });
    expect(ops.previewAdminOperation.request.body.parse(null)).toBeNull();
    expect(ops.runAdminOperation.request.body.parse(undefined)).toBeUndefined();
  });
  it("keeps complete credential setup/audit and exclusive accepted versus needsRender results", () => {
    const credential = {
      key: "TOKEN",
      title: "Token",
      description: "Synthetic",
      source: "vault",
      managedBy: "dawarich-provisioning",
      updatedAt: at,
      updatedBy: null,
      setup: {
        url: "https://synthetic.invalid",
        urlLabel: "Request access",
        steps: ["Synthetic step"],
        cost: "Free",
        notes: "Synthetic",
        email: { to: "admin@synthetic.invalid", subject: "Access", body: "Synthetic request" },
      },
    };
    const result = { serviceId: "sample", secretsConfigured: true, credentials: [credential] };
    expect(response("getAdminServiceCredentials", 200, result)).toEqual(result);
    for (const id of ["setAdminServiceCredential", "deleteAdminServiceCredential"] as const) {
      for (const result of [
        { ok: true, jobId: "job" },
        { ok: true, needsRender: true },
      ])
        expect(response(id, 200, result)).toEqual(result);
      expect(contracts.adminServiceCredentialChangedSchema.safeParse({ ok: true }).success).toBe(
        false,
      );
      expect(
        contracts.adminServiceCredentialChangedSchema.safeParse({
          ok: true,
          jobId: "job",
          needsRender: true,
        }).success,
      ).toBe(false);
      const error = { code: "DAWARICH_CREDENTIAL_MANAGED", error: "Managed credential" };
      expect(response(id, 409, error)).toEqual(error);
    }
    expect(
      contracts.serviceAdminOperations.setAdminServiceCredential.request.body.parse({
        value: " synthetic ",
      }),
    ).toEqual({ value: " synthetic " });
  });
  it("preserves all provisioning flags, safe status-qualified errors, compose outcomes and header alternatives", () => {
    const ops = contracts.serviceAdminOperations;
    for (const id of [
      "getAdminDawarich",
      "provisionAdminDawarich",
      "rotateAdminDawarichOidcSecret",
    ] as const) {
      expect(response(id, 200, dawarich)).toEqual(dawarich);
      for (const [status, code] of [
        [409, "DAWARICH_OAUTH_CLIENT_CONFLICT"],
        [409, "DAWARICH_DATABASE_SECRET_CONFLICT"],
        [409, "DAWARICH_RAILS_SECRET_CONFLICT"],
        [422, "DAWARICH_INVALID_PUBLIC_HOST"],
        [503, "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED"],
        [503, "DAWARICH_PROVISIONING_FAILED"],
      ] as const)
        expect(response(id, status, { code })).toEqual({ code });
      expect(ops[id].responses[503].schema.safeParse({ code: "unexpected" }).success).toBe(false);
    }
    expect(
      response("provisionAdminDawarich", 409, { code: "DAWARICH_BUNDLE_NOT_INSTALLED" }),
    ).toEqual({ code: "DAWARICH_BUNDLE_NOT_INSTALLED" });
    expect(
      response("rotateAdminDawarichOidcSecret", 400, {
        code: "DAWARICH_ROTATION_CONFIRMATION_REQUIRED",
      }),
    ).toEqual({ code: "DAWARICH_ROTATION_CONFIRMATION_REQUIRED" });
    expect(
      ops.rotateAdminDawarichOidcSecret.request.body.parse({
        confirmation: "ROTATE DAWARICH OIDC SECRET",
      }),
    ).toEqual({ confirmation: "ROTATE DAWARICH OIDC SECRET" });
    expect(response("getAdminComposePreview", 200, "services:\n  synthetic: {}\n")).toBe(
      "services:\n  synthetic: {}\n",
    );
    expect(Object.keys(ops.stopAdminCompose.responses).some((status) => /^2/.test(status))).toBe(
      false,
    );
    expect(response("stopAdminCompose", 503, { ok: false, error: "Host guidance" })).toEqual({
      ok: false,
      error: "Host guidance",
    });
    expect(
      response("startAdminCompose", 200, {
        ok: false,
        stdout: "Failed",
        hardlinks: {
          applied: true,
          linked: 1,
          skipped: 2,
          pruned: 3,
          entries: 4,
          via: "synthetic",
        },
      }),
    ).toMatchObject({ ok: false });
    for (const id of ["startAdminCompose", "streamAdminServiceLogs"] as const) {
      const schema = ops[id].request.headers;
      expect(schema.safeParse({ "idempotency-key": "synthetic-intent-0001" }).success).toBe(true);
      for (const key of [undefined, "short", " synthetic-intent-0001", ["synthetic-intent-0001"]])
        expect(schema.safeParse({ "idempotency-key": key }).success).toBe(false);
    }
    expect(ops.streamAdminServiceLogs.responses[200]).toEqual({
      kind: "stream",
      mediaType: "text/plain",
    });
    expect(
      ops.runAdminServiceAction.responses[429].headers?.safeParse({ "retry-after": "10" }).success,
    ).toBe(true);
    expect(ops.runAdminServiceAction.responses[429].headers?.safeParse({}).success).toBe(false);
  });
  it("keeps catalogue presentation, transformed preview JSON, issues and signed shared-mobility deltas", () => {
    const operation = {
      id: "update",
      version: 1,
      group: "osm",
      title: "Update",
      description: "Synthetic",
      risk: "destructive",
      confirmation: { title: "Confirm", message: "Proceed" },
      fields: [
        {
          name: "region",
          label: "Region",
          kind: "select",
          placeholder: "Choose",
          helpText: "Synthetic",
          required: true,
          options: [{ value: "test", label: "Test" }],
        },
      ],
      defaults: { region: "test", failFast: false },
    };
    expect(response("listAdminOperations", 200, { operations: [operation] })).toEqual({
      operations: [operation],
    });
    const preview = {
      ok: true,
      input: { countries: ["DE", "AT"], failFast: false },
      preview: ["Synthetic plan"],
      risk: "normal",
    };
    expect(response("previewAdminOperation", 200, preview)).toEqual(preview);
    const invalid = {
      ok: false,
      error: "Invalid input",
      issues: [{ path: "region", message: "Required" }],
    };
    expect(response("runAdminOperation", 400, invalid)).toEqual(invalid);
    expect(
      response("previewAdminOperation", 404, { ok: false, error: "Unknown operation" }),
    ).toEqual({ ok: false, error: "Unknown operation" });
    const policy = {
      rollbackCategories: ["bike"],
      decisions: [
        {
          category: "bike",
          recordedAt: at,
          decision: {
            policy: "shadow",
            local: "partial",
            served: "fanout",
            calledAdapters: ["one"],
            skippedAdapters: ["two"],
            partial: true,
            stationDelta: -1,
            vehicleDelta: 2,
          },
        },
      ],
    };
    expect(response("getAdminSharedMobility", 200, policy)).toEqual(policy);
    expect(response("rollbackAdminSharedMobility", 200, policy)).toEqual(policy);
    expect(
      response("checkAdminServices", 200, {
        acquisition,
        statuses: [{ service: "sample", state: "paused" }],
        checkedAt: at,
      }),
    ).toEqual({ acquisition, statuses: [{ service: "sample", state: "paused" }], checkedAt: at });
    const deployment = {
      selfHosted: true,
      dockerAvailable: false,
      hostControlConfigured: true,
      hostDir: null,
      composeRendered: false,
      infraDir: "/synthetic/infra",
    };
    expect(response("getAdminDeployment", 200, deployment)).toEqual(deployment);
  });
});
