import { describe, expect, it } from "vitest";
import {
  inspectPreparedConfigurationRecord,
  prepareConfigurationCandidate,
} from "./configuration-preparation";
import { parseOpsRequest } from "./contract";
import {
  configurationPayloadDigest,
  createConfigurationSnapshot,
  OPS_TRUSTED_CONFIG_MAX_BYTES,
  parseTrustedConfigurationPayload,
  type TrustedConfigurationPayload,
  verifyConfigurationSnapshot,
} from "./trusted-config";

const now = Date.parse("2026-08-24T08:00:00.000Z");
const operationKey = "opk1_0123456789abcdef";

function payload(): TrustedConfigurationPayload {
  return {
    domain: "maps.example.test",
    selectedRoots: ["app-web", "redis"],
    serviceConfigs: [{ serviceId: "redis", values: { MEMORY_LIMIT: "256m" } }],
    integrationConfigs: [{ integrationId: "routing", values: { enabled: true } }],
    serviceSecrets: [
      {
        serviceId: "redis",
        values: { ACCESS_TOKEN: Buffer.from([1, 2, 3]).toString("base64url") },
      },
    ],
  };
}

function snapshot(input: TrustedConfigurationPayload, ttlMs?: number) {
  return createConfigurationSnapshot({
    role: "api",
    operationKey,
    payload: input,
    issuedAtMs: now,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    nonce: "nonce_0123456789abcdef",
  });
}

function render(revisionId: string, payloadDigest: string) {
  return {
    kind: "stack.render" as const,
    revisionId,
    payloadDigest,
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
    coordinatorMode: "ensure-running" as const,
  };
}

function request(operation: unknown, body?: unknown) {
  return {
    version: 2,
    requestId: "ops1_0123456789abcdef0123456789ab",
    operationKey,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 20_000).toISOString(),
    operation,
    ...(body === undefined ? {} : { payload: body }),
  };
}

describe("configuration payload", () => {
  it("accepts a payload of exactly the size limit and rejects the next byte", () => {
    const input = payload();
    input.serviceSecrets = [
      {
        serviceId: "motis",
        values: {
          ...Object.fromEntries(
            Array.from({ length: 8 }, (_, i) => [`TOKEN_${i}`, "x".repeat(60000)]),
          ),
          PAD: "",
        },
      },
    ];
    const size = () => Buffer.byteLength(JSON.stringify(input), "utf8");
    input.serviceSecrets[0]!.values.PAD = "x".repeat(OPS_TRUSTED_CONFIG_MAX_BYTES - size());
    expect(size()).toBe(OPS_TRUSTED_CONFIG_MAX_BYTES);
    expect(() => parseTrustedConfigurationPayload(input)).not.toThrow();
    input.serviceSecrets[0]!.values.PAD += "x";
    expect(() => parseTrustedConfigurationPayload(input)).toThrow("Configuration payload rejected");
  });

  it("names the generation after the payload, key and nonce, and verifies only that payload", () => {
    const first = snapshot(payload());
    expect(first.revisionId).toMatch(/^cfg1_[A-Za-z0-9_-]{43}$/);
    expect(first.payloadDigest).toBe(configurationPayloadDigest(payload()));
    expect(snapshot(payload())).toEqual(first);
    expect(verifyConfigurationSnapshot(first, payload())).toEqual({
      issuedAtMs: now,
      expiresAtMs: now + 5 * 60_000,
    });
    const changed = { ...payload(), domain: "other.example.test" };
    expect(snapshot(changed).revisionId).not.toBe(first.revisionId);
    expect(() => verifyConfigurationSnapshot(first, changed)).toThrow();
    expect(() =>
      verifyConfigurationSnapshot(
        { ...first, expiresAt: new Date(now + 6 * 60_000).toISOString() },
        payload(),
      ),
    ).toThrow();
    expect(() => snapshot(payload(), 0)).toThrow("Configuration payload rejected");
  });

  it("binds a candidate's apply operation to the payload digest and refuses a read-only kind", () => {
    const candidate = prepareConfigurationCandidate({
      role: "api",
      operationKey,
      payload: payload(),
      issuedAtMs: now,
      nonce: "nonce_0123456789abcdef",
      operationForRevision: render,
    });
    expect(candidate.operation).toMatchObject({
      revisionId: candidate.revisionId,
      payloadDigest: configurationPayloadDigest(payload()),
    });
    expect(() =>
      prepareConfigurationCandidate({
        role: "api",
        operationKey,
        payload: payload(),
        issuedAtMs: now,
        nonce: "nonce_0123456789abcdef",
        operationForRevision: (revisionId) =>
          ({
            kind: "configuration.hardlinks.preview",
            candidateId: "22222222-2222-4222-8222-222222222222",
            revisionId,
            expectedCurrentRevisionId: null,
            expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
            coordinatorMode: "ensure-running",
          }) as never,
      }),
    ).toThrow("Prepared configuration unavailable");
  });

  it("refuses a stored candidate whose payload no longer matches its snapshot", () => {
    const candidate = prepareConfigurationCandidate({
      role: "api",
      operationKey,
      payload: payload(),
      issuedAtMs: now,
      nonce: "nonce_0123456789abcdef",
      operationForRevision: render,
    });
    const record = {
      version: 1,
      candidateId: "22222222-2222-4222-8222-222222222222",
      operationKey,
      operation: candidate.operation,
      sourceFingerprint: "0".repeat(64),
      expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
      snapshot: candidate.snapshot,
      payload: payload(),
      privateOverlay: {},
      apiJobId: "33333333-3333-4333-8333-333333333333",
      actorId: "admin",
      parentOperationKey: operationKey,
      parentFingerprint: "0".repeat(64),
      parentDeadlineAt: now,
      affectedServiceIds: [],
      maintenanceId: null,
      prepareOperationKey: null,
    };
    expect(inspectPreparedConfigurationRecord(record).snapshot.revisionId).toBe(
      candidate.revisionId,
    );
    expect(() =>
      inspectPreparedConfigurationRecord({
        ...record,
        payload: { ...payload(), domain: "x.test" },
      }),
    ).toThrow();
  });

  it("requires exactly the digested payload beside an apply and none beside other kinds", () => {
    const digest = configurationPayloadDigest(payload());
    const apply = render(snapshot(payload()).revisionId, digest);
    expect(parseOpsRequest(request(apply, payload()), { role: "api" }).payload).toEqual(payload());
    expect(() => parseOpsRequest(request(apply), { role: "api" })).toThrow();
    expect(() =>
      parseOpsRequest(request(apply, { ...payload(), domain: "x.test" }), { role: "api" }),
    ).toThrow();
    expect(() =>
      parseOpsRequest(request({ kind: "docker.status" }, payload()), { role: "api" }),
    ).toThrow();
  });

  it("accepts bounded nested JSON config but rejects duplicate identities", () => {
    const nested = payload();
    nested.integrationConfigs = [
      {
        integrationId: "routing",
        values: { profiles: [{ mode: "rail", options: ["fast", "accessible"] }] },
      },
    ];
    expect(() => parseTrustedConfigurationPayload(nested)).not.toThrow();
    for (const duplicate of [
      {
        ...payload(),
        serviceConfigs: [
          { serviceId: "redis", values: {} },
          { serviceId: "redis", values: {} },
        ],
      },
      {
        ...payload(),
        integrationConfigs: [
          { integrationId: "routing", values: {} },
          { integrationId: "routing", values: {} },
        ],
      },
      {
        ...payload(),
        serviceSecrets: [
          { serviceId: "redis", values: {} },
          { serviceId: "redis", values: {} },
        ],
      },
    ])
      expect(() => parseTrustedConfigurationPayload(duplicate)).toThrow();
    expect(() =>
      parseTrustedConfigurationPayload({ ...payload(), callerPath: "/tmp/escape" }),
    ).toThrow();
    expect(() =>
      parseTrustedConfigurationPayload({
        ...payload(),
        serviceConfigs: [{ serviceId: "../escape", values: {} }],
      }),
    ).toThrow();
  });

  it("accepts canonical hyphenated and nested manifest keys but rejects path and prototype keys", () => {
    expect(() =>
      parseTrustedConfigurationPayload({
        ...payload(),
        integrationConfigs: [
          {
            integrationId: "ev-charging",
            values: {
              "at-econtrol-referer-domain": "maps.example.test",
              providers: [
                {
                  type: "remote",
                  headers: { "User-Agent": "OpenMapX", "X-API-Key": "reference" },
                },
              ],
            },
          },
          { integrationId: "routing-valhalla", values: { "bidirectional-alternates": true } },
        ],
      }),
    ).not.toThrow();
    for (const hostileKey of [
      "../escape",
      "a/b",
      "a\\b",
      "__proto__",
      "prototype",
      "constructor",
    ]) {
      const values = Object.create(
        null,
      ) as TrustedConfigurationPayload["integrationConfigs"][number]["values"];
      values[hostileKey] = "blocked";
      expect(
        () =>
          parseTrustedConfigurationPayload({
            ...payload(),
            integrationConfigs: [{ integrationId: "routing", values }],
          }),
        hostileKey,
      ).toThrow();
    }
  });
});
