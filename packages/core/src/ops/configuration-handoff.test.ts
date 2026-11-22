import { describe, expect, it } from "vitest";
import { configurationHandoffPrepareOperationSchema } from "./configuration-handoff-records";

const operation = () => ({
  kind: "configurationHandoff.prepare",
  handoffId: "11111111-1111-4111-8111-111111111111",
  maintenanceId: "22222222-2222-4222-8222-222222222222",
  candidateId: "33333333-3333-4333-8333-333333333333",
  planDigest: "a".repeat(64),
  previewFingerprint: "b".repeat(64),
  expectedCurrentRevisionId: `cfg1_${"c".repeat(43)}`,
  serviceIds: ["api"],
  expectedImageIdentities: { api: `sha256:${"1".repeat(64)}` },
  mode: { kind: "configuration" },
});
describe("handoff step body", () => {
  it("rejects extra paths, arbitrary images, unordered/duplicate targets and unbound target maps", () => {
    for (const value of [
      { ...operation(), path: "/other" },
      { ...operation(), image: "arbitrary/image" },
      { ...operation(), serviceIds: ["api", "api"] },
      { ...operation(), serviceIds: ["ops-agent", "api"] },
      { ...operation(), expectedImageIdentities: { "ops-agent": `sha256:${"2".repeat(64)}` } },
      {
        ...operation(),
        serviceIds: ["motis"],
        expectedImageIdentities: { motis: `sha256:${"2".repeat(64)}` },
      },
    ])
      expect(configurationHandoffPrepareOperationSchema.safeParse(value).success).toBe(false);
  });
  it("keeps release identity distinct from observed old image IDs without accepting caller pins", () => {
    const body = {
      ...operation(),
      serviceIds: ["motis"],
      expectedImageIdentities: { motis: `sha256:${"2".repeat(64)}` },
      mode: { kind: "release", releaseId: "v0.1.0-beta.1", manifestDigest: "d".repeat(64) },
    };
    expect(configurationHandoffPrepareOperationSchema.safeParse(body).success).toBe(true);
    expect(
      configurationHandoffPrepareOperationSchema.safeParse({
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
    affectedServiceIds: ["api"],
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
