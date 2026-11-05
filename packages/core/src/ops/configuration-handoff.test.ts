import { describe, expect, it } from "vitest";
import { authorizeOpsOperation, opsOperationSchema, parseOpsResult } from "./contract";
import { opsExecutionBudget } from "./execution-identity";

const operation = () => ({
  kind: "configurationHandoff.prepare",
  handoffId: "11111111-1111-4111-8111-111111111111",
  maintenanceId: "22222222-2222-4222-8222-222222222222",
  candidateId: "33333333-3333-4333-8333-333333333333",
  planDigest: "a".repeat(64),
  previewFingerprint: "b".repeat(64),
  expectedCurrentRevisionId: `cfg1_${"c".repeat(43)}`,
  serviceIds: ["app-api"],
  expectedImageIdentities: { "app-api": `sha256:${"1".repeat(64)}` },
  mode: { kind: "configuration" },
});
describe("fixed protected handoff wire data", () => {
  it("has API-only mutation authority and a terminal prepared result, not an applied claim", () => {
    const body = opsOperationSchema.parse(operation());
    if (body.kind !== "configurationHandoff.prepare") throw Error("Unexpected operation");
    expect(authorizeOpsOperation("api", body.kind)).toBe(true);
    expect(authorizeOpsOperation("data-manager", body.kind)).toBe(false);
    expect(
      parseOpsResult("configurationHandoff.prepare", {
        handoffId: body.handoffId,
        phase: "prepared",
      }),
    ).toEqual({ handoffId: body.handoffId, phase: "prepared" });
    expect(() =>
      parseOpsResult("configurationHandoff.prepare", {
        handoffId: body.handoffId,
        phase: "applied",
      }),
    ).toThrow();
    expect(opsExecutionBudget("configuration-helper").processMs).toBe(3600000);
  });
  it("rejects extra paths, arbitrary images, unordered/duplicate targets and unbound target maps", () => {
    for (const value of [
      { ...operation(), path: "/other" },
      { ...operation(), image: "arbitrary/image" },
      { ...operation(), serviceIds: ["app-api", "app-api"] },
      { ...operation(), serviceIds: ["ops-agent", "app-api"] },
      { ...operation(), expectedImageIdentities: { "ops-agent": `sha256:${"2".repeat(64)}` } },
      {
        ...operation(),
        serviceIds: ["motis"],
        expectedImageIdentities: { motis: `sha256:${"2".repeat(64)}` },
      },
    ])
      expect(opsOperationSchema.safeParse(value).success).toBe(false);
  });
  it("keeps release identity distinct from observed old image IDs without accepting caller pins", () => {
    const body = {
      ...operation(),
      serviceIds: ["motis"],
      expectedImageIdentities: { motis: `sha256:${"2".repeat(64)}` },
      mode: { kind: "release", releaseId: "v0.1.0-beta.1", manifestDigest: "d".repeat(64) },
    };
    expect(opsOperationSchema.safeParse(body).success).toBe(true);
    expect(
      opsOperationSchema.safeParse({
        ...body,
        mode: { ...body.mode, imageReferences: { motis: "arbitrary/image" } },
      }).success,
    ).toBe(false);
  });
});

it("bounds private platform intent without admitting plaintext recovery credentials", async () => {
  const { platformConfigurationIntentSchema } = await import("./configuration-preparation-records");
  const value = {
    version: 1,
    handoffId: operation().handoffId,
    previewId: operation().candidateId,
    previewFingerprint: "a".repeat(64),
    authPolicyRevision: "b".repeat(64),
    sourceRevision: operation().maintenanceId,
    expectedCurrentRevisionId: operation().expectedCurrentRevisionId,
    expectedDesiredRowVersion: null,
    sourceSnapshot: {
      revisionId: operation().expectedCurrentRevisionId,
      sourceRevision: operation().maintenanceId,
      services: [],
    },
    configuration: { version: 1, domain: { source: "host" } },
    affectedServiceIds: ["app-api"],
    confirmations: {
      domain: false,
      dnsTls: false,
      oauth: false,
      passkeys: false,
      alternateLogin: false,
    },
  };
  expect(platformConfigurationIntentSchema.parse(value)).toEqual(value);
  expect(
    platformConfigurationIntentSchema.safeParse({ ...value, proof: { nonce: "raw" } }).success,
  ).toBe(false);
  expect(
    platformConfigurationIntentSchema.safeParse({
      ...value,
      authorization: { ciphertext: "a".repeat(8193), iv: "x", tag: "x" },
    }).success,
  ).toBe(false);
});
