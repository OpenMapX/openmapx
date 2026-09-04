import { describe, expect, it } from "vitest";
import {
  assertAssemblyReady,
  assertValidRequestTransition,
  createSubjectRequestSchema,
  identityReviewSchema,
  isAssistedDeliveryAuthorized,
  isValidRequestTransition,
} from "./request-contracts.js";

describe("privacy request contracts", () => {
  it("allows only the documented lifecycle transitions", () => {
    expect(isValidRequestTransition("received", "preserving")).toBe(true);
    expect(isValidRequestTransition("received", "ready")).toBe(false);
    expect(isValidRequestTransition("ready", "withdrawn")).toBe(true);
    expect(isValidRequestTransition("delivered", "withdrawn")).toBe(false);
    expect(() => assertValidRequestTransition("ready", "ready")).toThrow();
  });

  it("defaults self-service requests to the combined package", () => {
    expect(createSubjectRequestSchema.parse({ userId: "u" })).toMatchObject({
      kind: "access_and_portability",
      channel: "self_service",
      locale: "en",
      timeZone: "UTC",
    });
  });

  it("rejects caller-controlled subject locators on self-service requests", () => {
    expect(
      createSubjectRequestSchema.safeParse({
        userId: "authoritative-user",
        channel: "self_service",
        subject: {
          locatorType: "user_id",
          locator: "different-user",
          accountState: "current",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts protected assisted locators without requiring an account", () => {
    expect(
      createSubjectRequestSchema.parse({
        channel: "email",
        subject: {
          locatorType: "email",
          locator: "former-user@example.test",
          accountState: "deleted",
        },
      }),
    ).toMatchObject({ userId: null, subject: { accountState: "deleted" } });
  });

  it("requires proportional identity evidence and separate representative authority review", () => {
    expect(
      identityReviewSchema.safeParse({ version: 1, party: "subject", outcome: "verified" }).success,
    ).toBe(false);
    expect(
      identityReviewSchema.safeParse({
        version: 1,
        party: "subject",
        outcome: "verified",
        method: "exceptional_evidence",
        reasonableDoubtCode: "account-records-conflict",
        evidenceAttachmentId: "c88e434c-1c1f-40e0-a975-17f4c8f062de",
      }).success,
    ).toBe(true);
    expect(
      identityReviewSchema.safeParse({
        version: 1,
        party: "representative",
        outcome: "verified",
        method: "verified_email_challenge",
        authorityOutcome: "approved",
        deliveryAuthorized: true,
      }).success,
    ).toBe(false);
    expect(
      identityReviewSchema.safeParse({
        version: 2,
        party: "representative",
        outcome: "verified",
        authorityOutcome: "approved",
        authorityAttachmentId: "c88e434c-1c1f-40e0-a975-17f4c8f062de",
        deliveryAuthorized: false,
      }).success,
    ).toBe(true);
  });

  it("fails closed for unresolved required tasks", () => {
    expect(() => assertAssemblyReady([{ required: true, status: "pending" }])).toThrow();
    expect(() => assertAssemblyReady([{ required: true, status: "operator_review" }])).toThrow();
    expect(() => assertAssemblyReady([{ required: false, status: "pending" }])).not.toThrow();
  });

  it("keeps representative identity, authority, and delivery permission separate", () => {
    const subject = {
      party: "subject",
      state: "verified",
      authorityState: "not_applicable",
      deliveryAuthorized: 0,
    };
    expect(isAssistedDeliveryAuthorized([subject], "assisted")).toBe(true);
    expect(
      isAssistedDeliveryAuthorized(
        [
          subject,
          {
            party: "representative",
            state: "verified",
            authorityState: "approved",
            deliveryAuthorized: 0,
          },
        ],
        "representative",
      ),
    ).toBe(false);
  });
});
