import { describe, expect, it } from "vitest";
import {
  inspectTrustedConfigurationSnapshot,
  OPS_TRUSTED_CONFIG_MAX_BYTES,
  OPS_TRUSTED_CONFIG_QUEUE_MAX_BYTES,
  OPS_TRUSTED_CONFIG_QUEUE_MAX_ENTRIES,
  openTrustedConfigurationSnapshot,
  sealTrustedConfigurationSnapshot,
  type TrustedConfigurationPayload,
  trustedConfigurationQueueFits,
} from "./trusted-config";

it("accepts exactly 524288 serialized sealed UTF-8 bytes and rejects the next byte", () => {
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
  const seal = () =>
    sealTrustedConfigurationSnapshot({
      role: "api",
      operationKey: "opk1_0123456789abcdef",
      operationForRevision: (revisionId) => ({
        kind: "stack.render",
        revisionId,
        expectedCurrentRevisionId: null,
        expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
        coordinatorMode: "ensure-running",
      }),
      payload: input,
      token,
      issuedAtMs: now,
      nonce: "nonce_0123456789abcdef",
    });
  const remaining = OPS_TRUSTED_CONFIG_MAX_BYTES - seal().bytes.length;
  input.serviceSecrets[0]!.values.PAD = "x".repeat(remaining);
  expect(seal().bytes.length).toBe(524288);
  input.serviceSecrets[0]!.values.PAD += "x";
  expect(() => seal()).toThrow();
});

const token = Buffer.alloc(32, 0x2a).toString("base64url");
const now = Date.parse("2026-08-24T08:00:00.000Z");

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

describe("trusted configuration snapshot protocol", () => {
  it("refuses to seal a read-only hardlink preview as a generation apply", () => {
    expect(() =>
      sealTrustedConfigurationSnapshot({
        role: "api",
        operationKey: "opk1_candidatekind123456",
        token,
        issuedAtMs: now,
        nonce: "nonce_candidate_kind_123456",
        payload: payload(),
        operationForRevision: (revisionId) => ({
          kind: "configuration.hardlinks.preview",
          candidateId: "031d2b04-4494-443b-8a70-5d1c44b4d951",
          revisionId,
          expectedCurrentRevisionId: null,
          expectedSourceRevision: "d1daa4b7-1c11-47e7-88af-5442be6a3ae7",
          coordinatorMode: "require-running",
        }),
      }),
    ).toThrow();
  });
  it("uses one retained queue budget for ready, claimed, and in-flight reservations", () => {
    expect(
      trustedConfigurationQueueFits({
        retainedEntries: OPS_TRUSTED_CONFIG_QUEUE_MAX_ENTRIES - 1,
        retainedBytes: OPS_TRUSTED_CONFIG_QUEUE_MAX_BYTES - OPS_TRUSTED_CONFIG_MAX_BYTES,
        reservedEntries: 1,
        reservedBytes: OPS_TRUSTED_CONFIG_MAX_BYTES,
      }),
    ).toBe(true);
    expect(
      trustedConfigurationQueueFits({
        retainedEntries: OPS_TRUSTED_CONFIG_QUEUE_MAX_ENTRIES,
        retainedBytes: 1,
        reservedEntries: 1,
        reservedBytes: 1,
      }),
    ).toBe(false);
    expect(
      trustedConfigurationQueueFits({
        retainedEntries: 4,
        retainedBytes: OPS_TRUSTED_CONFIG_MAX_BYTES * 4,
        reservedEntries: 1,
        reservedBytes: OPS_TRUSTED_CONFIG_MAX_BYTES,
      }),
    ).toBe(true);
    expect(
      trustedConfigurationQueueFits({
        retainedEntries: 32,
        retainedBytes: OPS_TRUSTED_CONFIG_QUEUE_MAX_BYTES,
        reservedEntries: 1,
        reservedBytes: 1,
      }),
    ).toBe(false);
    expect(
      trustedConfigurationQueueFits({
        retainedEntries: -1,
        retainedBytes: 0,
        reservedEntries: 0,
        reservedBytes: 0,
      }),
    ).toBe(false);
  });

  it("authenticates bounded expiry metadata without disclosing the payload", () => {
    const sealed = sealTrustedConfigurationSnapshot({
      role: "api",
      operationKey: "opk1_0123456789abcdef",
      operationForRevision: (revisionId) => ({
        expectedCurrentRevisionId: null,
        expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
        coordinatorMode: "ensure-running" as const,
        kind: "stack.render",
        revisionId,
      }),
      payload: payload(),
      token,
      issuedAtMs: now,
      nonce: "nonce_0123456789abcdef",
    });
    expect(inspectTrustedConfigurationSnapshot(sealed.bytes, { token })).toEqual({
      revisionId: sealed.revisionId,
      role: "api",
      operationKey: "opk1_0123456789abcdef",
      operationFingerprint: sealed.operationFingerprint,
      issuedAtMs: now,
      expiresAtMs: now + 5 * 60_000,
    });
    const tampered = Buffer.from(sealed.bytes);
    tampered[tampered.length - 3] = tampered[tampered.length - 3] === 65 ? 66 : 65;
    expect(() => inspectTrustedConfigurationSnapshot(tampered, { token })).toThrow(
      "Trusted configuration snapshot rejected",
    );
  });

  it("content- and MAC-binds an immutable typed payload to role, key, operation, and revision", () => {
    const sealed = sealTrustedConfigurationSnapshot({
      role: "api",
      operationKey: "opk1_0123456789abcdef",
      operationForRevision: (revisionId) => ({
        expectedCurrentRevisionId: null,
        expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
        coordinatorMode: "ensure-running" as const,
        kind: "serviceConfig.apply",
        serviceId: "redis",
        revisionId,
      }),
      payload: payload(),
      token,
      issuedAtMs: now,
      nonce: "nonce_0123456789abcdef",
    });

    const opened = openTrustedConfigurationSnapshot(sealed.bytes, {
      role: "api",
      operationKey: "opk1_0123456789abcdef",
      operation: sealed.operation,
      fingerprint: sealed.operationFingerprint,
      token,
      nowMs: now + 1,
    });
    expect(opened.revisionId).toBe(sealed.revisionId);
    expect(opened.payload).toEqual(payload());
    expect(Object.isFrozen(opened.payload)).toBe(true);
    expect(sealed.bytes.byteLength).toBeLessThanOrEqual(OPS_TRUSTED_CONFIG_MAX_BYTES);
  });

  it.each([
    ["role", { role: "data-manager" }],
    ["owner key", { operationKey: "opk1_fedcba9876543210" }],
    [
      "operation fingerprint",
      {
        operation: {
          expectedCurrentRevisionId: null,
          expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
          coordinatorMode: "ensure-running" as const,
          kind: "serviceConfig.apply" as const,
          serviceId: "postgis",
          revisionId: "cfg1_0123456789abcdef0123456789abcdef0123456789a",
        },
      },
    ],
    ["claimed fingerprint", { fingerprint: "0".repeat(64) }],
    ["MAC key", { token: Buffer.alloc(32, 0x2b).toString("base64url") }],
    ["expiry", { nowMs: now + 5 * 60_000 + 1 }],
  ] as const)(
    "rejects a mismatched or stale %s without returning payload data",
    (_label, change) => {
      const sealed = sealTrustedConfigurationSnapshot({
        role: "api",
        operationKey: "opk1_0123456789abcdef",
        operationForRevision: (revisionId) => ({
          expectedCurrentRevisionId: null,
          expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
          coordinatorMode: "ensure-running" as const,
          kind: "stack.render",
          revisionId,
        }),
        payload: payload(),
        token,
        issuedAtMs: now,
        nonce: "nonce_0123456789abcdef",
      });
      expect(() =>
        openTrustedConfigurationSnapshot(sealed.bytes, {
          role: "api",
          operationKey: "opk1_0123456789abcdef",
          operation: sealed.operation,
          fingerprint: sealed.operationFingerprint,
          token,
          nowMs: now + 1,
          ...change,
        }),
      ).toThrow("Trusted configuration snapshot rejected");
    },
  );

  it("rejects unknown fields, malformed UTF-8, hostile identifiers, and oversized payloads", () => {
    const base = {
      role: "api" as const,
      operationKey: "opk1_0123456789abcdef",
      operationForRevision: (revisionId: string) => ({
        expectedCurrentRevisionId: null,
        expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
        coordinatorMode: "ensure-running" as const,
        kind: "stack.render" as const,
        revisionId,
      }),
      payload: payload(),
      token,
      issuedAtMs: now,
      nonce: "nonce_0123456789abcdef",
    };
    expect(() =>
      sealTrustedConfigurationSnapshot({
        ...base,
        payload: { ...payload(), callerPath: "/tmp/escape" } as TrustedConfigurationPayload,
      }),
    ).toThrow("Trusted configuration snapshot rejected");
    expect(() =>
      sealTrustedConfigurationSnapshot({
        ...base,
        payload: {
          ...payload(),
          serviceConfigs: [{ serviceId: "../escape", values: {} }],
        },
      }),
    ).toThrow("Trusted configuration snapshot rejected");
    expect(() =>
      sealTrustedConfigurationSnapshot({
        ...base,
        payload: {
          ...payload(),
          serviceSecrets: [
            {
              serviceId: "redis",
              values: { ACCESS_TOKEN: "x".repeat(OPS_TRUSTED_CONFIG_MAX_BYTES) },
            },
          ],
        },
      }),
    ).toThrow("Trusted configuration snapshot rejected");
    expect(() =>
      openTrustedConfigurationSnapshot(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), {
        role: "api",
        operationKey: "opk1_0123456789abcdef",
        operation: {
          expectedCurrentRevisionId: null,
          expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
          coordinatorMode: "ensure-running" as const,
          kind: "stack.render",
          revisionId: "cfg1_0123456789abcdef0123456789abcdef0123456789a",
        },
        fingerprint: "0".repeat(64),
        token,
        nowMs: now,
      }),
    ).toThrow("Trusted configuration snapshot rejected");
  });

  it("accepts bounded nested JSON config but rejects duplicate identities and invalid validity ordering", () => {
    const nested = payload();
    nested.integrationConfigs = [
      {
        integrationId: "routing",
        values: { profiles: [{ mode: "rail", options: ["fast", "accessible"] }] },
      },
    ];
    expect(() =>
      sealTrustedConfigurationSnapshot({
        role: "api",
        operationKey: "opk1_0123456789abcdef",
        operationForRevision: (revisionId) => ({
          expectedCurrentRevisionId: null,
          expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
          coordinatorMode: "ensure-running" as const,
          kind: "stack.render",
          revisionId,
        }),
        payload: nested,
        token,
        issuedAtMs: now,
        nonce: "nonce_0123456789abcdef",
      }),
    ).not.toThrow();

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
    ]) {
      expect(() =>
        sealTrustedConfigurationSnapshot({
          role: "api",
          operationKey: "opk1_0123456789abcdef",
          operationForRevision: (revisionId) => ({
            expectedCurrentRevisionId: null,
            expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
            coordinatorMode: "ensure-running" as const,
            kind: "stack.render",
            revisionId,
          }),
          payload: duplicate,
          token,
          issuedAtMs: now,
          nonce: "nonce_0123456789abcdef",
        }),
      ).toThrow("Trusted configuration snapshot rejected");
    }
    expect(() =>
      sealTrustedConfigurationSnapshot({
        role: "api",
        operationKey: "opk1_0123456789abcdef",
        operationForRevision: (revisionId) => ({
          expectedCurrentRevisionId: null,
          expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
          coordinatorMode: "ensure-running" as const,
          kind: "stack.render",
          revisionId,
        }),
        payload: payload(),
        token,
        issuedAtMs: now,
        ttlMs: 0,
        nonce: "nonce_0123456789abcdef",
      }),
    ).toThrow("Trusted configuration snapshot rejected");
  });

  it("accepts canonical hyphenated and nested manifest keys but rejects path and prototype keys", () => {
    const base = {
      role: "api" as const,
      operationKey: "opk1_0123456789abcdef",
      operationForRevision: (revisionId: string) => ({
        expectedCurrentRevisionId: null,
        expectedSourceRevision: "11111111-1111-4111-8111-111111111111",
        coordinatorMode: "ensure-running" as const,
        kind: "stack.render" as const,
        revisionId,
      }),
      token,
      issuedAtMs: now,
      nonce: "nonce_0123456789abcdef",
    };
    expect(() =>
      sealTrustedConfigurationSnapshot({
        ...base,
        payload: {
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
            {
              integrationId: "routing-valhalla",
              values: { "bidirectional-alternates": true },
            },
          ],
        },
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
          sealTrustedConfigurationSnapshot({
            ...base,
            payload: {
              ...payload(),
              integrationConfigs: [{ integrationId: "routing", values }],
            },
          }),
        hostileKey,
      ).toThrow("Trusted configuration snapshot rejected");
    }
  });
});
