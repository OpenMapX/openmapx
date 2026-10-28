import { expect, it } from "vitest";
import { dataConfigurationFenceSettleSchema } from "../services/data-manager/contracts/configuration-maintenance";
import { configurationNoGuardEvidenceSchema } from "./configuration-fence-settlement-records";

const binding = {
  maintenanceId: "11111111-1111-4111-8111-111111111111",
  candidateId: "22222222-2222-4222-8222-222222222222",
  planDigest: "a".repeat(64),
};
it("accepts the complete root-fixed version2 reference without late owner outcome fields", () => {
  const body = { version: 2, ...binding, settlementId: "b".repeat(64) };
  expect(dataConfigurationFenceSettleSchema.parse(body)).toEqual(body);
});
it("rejects fresh legacy inline outcome authority at the current service-auth mutation schema", () => {
  expect(
    dataConfigurationFenceSettleSchema.safeParse({
      ...binding,
      decisionId: "33333333-3333-4333-8333-333333333333",
      expectedSequence: 0,
      outcome: "applied",
      ownerReceiptDigest: "c".repeat(64),
    }).success,
  ).toBe(false);
});
it("requires the actual issuer freeze proof reference in receiver-refused NoGuard data", () => {
  // Decoder coverage only: these digests do not constitute signed authority.
  const refusal = {
    kind: "receiver_refused",
    prepareExecutionDigest: "a".repeat(64),
    prepareAdmissionDigest: "b".repeat(64),
    refusalProjectionDigest: "c".repeat(64),
    effectSettlementDigest: "d".repeat(64),
    canonicalTerminalDigest: "e".repeat(64),
    canonicalTerminalAt: 1,
    dmUnusedIntentDigest: "f".repeat(64),
    dmUnusedConfirmationDigest: "0".repeat(64),
    capacityReceiptDigest: null,
  };
  expect(configurationNoGuardEvidenceSchema.safeParse(refusal).success).toBe(false);
  expect(
    configurationNoGuardEvidenceSchema.safeParse({
      ...refusal,
      issuerFreezeProofDigest: "1".repeat(64),
    }).success,
  ).toBe(true);
});
