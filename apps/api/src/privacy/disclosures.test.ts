import { describe, expect, it } from "vitest";
import {
  disclosureInputSchema,
  sanitizeDisclosureInput,
  TRUSTED_RECIPIENTS,
} from "./disclosures.js";

describe("disclosure ledger", () => {
  it("accepts controlled recipient facts and rejects payload-like fields", () => {
    const value = sanitizeDisclosureInput({
      userId: "u",
      occurredAt: new Date(),
      recipientId: "osm",
      recipientName: "OpenStreetMap",
      recipientRole: "independent-controller",
      recipientCountry: "GB",
      operationCode: "publish",
      categoryCode: "osm-publication",
      purposeCode: "publication",
      legalBasisCode: "consent",
    });
    expect(value).not.toHaveProperty("payload");
    expect(value.recipientId).toBe("osm");
    expect(() =>
      sanitizeDisclosureInput({
        userId: "u",
        occurredAt: new Date(),
        recipientId: "osm",
        recipientName: "OpenStreetMap",
        recipientRole: "independent-controller",
        operationCode: "publish",
        categoryCode: "osm-publication",
        purposeCode: "publication",
        legalBasisCode: "consent",
        payload: "must-not-store",
      } as never),
    ).toThrow();
  });

  it("rejects free-form identifiers", () => {
    expect(() =>
      disclosureInputSchema.parse({
        userId: "u",
        occurredAt: new Date(),
        recipientId: "bad id",
        recipientName: "x",
        recipientRole: "processor",
        operationCode: "op",
        categoryCode: "cat",
        purposeCode: "purpose",
        legalBasisCode: "contract",
      }),
    ).toThrow();
  });

  it("keeps deployment-specific recipient facts unasserted in the static registry", () => {
    expect(TRUSTED_RECIPIENTS["openmapx-controller"]).toMatchObject({
      name: "Deployment controller",
      country: null,
    });
    expect(TRUSTED_RECIPIENTS["dawarich-managed"]?.country).toBeNull();
    expect(TRUSTED_RECIPIENTS["email-processor"]?.country).toBeNull();
  });
});
