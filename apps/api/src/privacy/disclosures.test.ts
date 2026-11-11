import { describe, expect, it } from "vitest";
import {
  disclosureInputSchema,
  sanitizeDisclosureInput,
  TRUSTED_RECIPIENTS,
} from "./disclosures.js";

describe("disclosure ledger", () => {
  it("snapshots recipient facts from the registry and rejects payload-like fields", () => {
    const value = sanitizeDisclosureInput({
      userId: "u",
      occurredAt: new Date(),
      recipientId: "osm",
      operationCode: "publish",
      categoryCode: "osm-publication",
      purposeCode: "publication",
      legalBasisCode: "consent",
    });
    expect(value).not.toHaveProperty("payload");
    expect(value).toMatchObject({
      userId: "u",
      recipientId: "osm",
      recipientName: TRUSTED_RECIPIENTS.osm?.name,
      recipientRole: "independent-controller",
    });
    expect(() =>
      sanitizeDisclosureInput({
        userId: "u",
        occurredAt: new Date(),
        recipientId: "osm",
        operationCode: "publish",
        categoryCode: "osm-publication",
        purposeCode: "publication",
        legalBasisCode: "consent",
        payload: "must-not-store",
      } as never),
    ).toThrow();
  });

  it("does not accept caller-supplied recipient facts or a second subject field", () => {
    const base = {
      userId: "u",
      occurredAt: new Date(),
      recipientId: "osm",
      operationCode: "publish",
      categoryCode: "osm-publication",
      purposeCode: "publication",
      legalBasisCode: "consent",
    };
    for (const extra of [
      { recipientName: "OpenStreetMap" },
      { recipientRole: "independent-controller" },
      { recipientCountry: "GB" },
      { recipientPrivacyUrl: "https://www.openstreetmap.org/privacy" },
      { subjectUserId: "u" },
    ]) {
      expect(() => sanitizeDisclosureInput({ ...base, ...extra } as never)).toThrow();
    }
  });

  it("rejects free-form identifiers", () => {
    expect(() =>
      disclosureInputSchema.parse({
        userId: "u",
        occurredAt: new Date(),
        recipientId: "bad id",
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
