import { expect, it } from "vitest";
import { artifactTransferPolicySchema, DEFAULT_TRANSFER_POLICY, purposeByteLimit } from "./policy";

it("uses ceilings, purpose caps and explicit memory accounting", () => {
  expect(DEFAULT_TRANSFER_POLICY.maxUploadBytes).toBe(1024 ** 4);
  expect(purposeByteLimit(DEFAULT_TRANSFER_POLICY, "integration-artifact")).toBe(200 * 1024 ** 2);
  expect(purposeByteLimit(DEFAULT_TRANSFER_POLICY, "instance-migration")).toBe(64 * 1024 ** 2);
  expect(
    artifactTransferPolicySchema.safeParse({ maxManifestBytes: 256 * 1024 ** 2 }).success,
  ).toBe(false);
  expect(artifactTransferPolicySchema.safeParse({ maxUploadBytes: 9 * 1024 ** 4 }).success).toBe(
    false,
  );
  expect(artifactTransferPolicySchema.safeParse({ unknown: true }).success).toBe(false);
});
