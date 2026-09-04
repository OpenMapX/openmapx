import { describe, expect, it } from "vitest";
import {
  type SubjectDataRegistration,
  subjectDataRegistrationSchema,
  validateSubjectDataRegistrations,
} from "./contracts";

const completeRegistration: SubjectDataRegistration = {
  id: "account-profile",
  version: 1,
  category: "account",
  source: "openmapx-db",
  strategy: "collector",
  locators: [{ type: "user_id", field: "user.id" }],
  purposes: ["account-management"],
  legalBases: ["contract"],
  origin: { kind: "subject", descriptionCode: "subject-provided" },
  retention: { kind: "account-lifetime", daysAfterClosure: 0 },
  recipients: [{ id: "openmapx-controller", roleCode: "controller" }],
  article15: "include",
  portability: { decision: "include", format: "json" },
  secretPolicy: { mode: "redact", code: "credential-redacted" },
  rightsOfOthers: { mode: "none" },
  collectorId: "openmapx-account",
};

describe("subject data contracts", () => {
  it("accepts a complete strict registration", () => {
    expect(subjectDataRegistrationSchema.parse(completeRegistration)).toEqual(completeRegistration);
  });

  it.each([
    ["unknown key", { ...completeRegistration, unexpected: true }],
    ["non-positive version", { ...completeRegistration, version: 0 }],
    ["empty purposes", { ...completeRegistration, purposes: [] }],
    [
      "not personal with article 15",
      { ...completeRegistration, strategy: "not_personal", article15: "include" },
    ],
    ["collector without locator", { ...completeRegistration, locators: [] }],
    ["duplicate ids", [completeRegistration, completeRegistration]],
  ])("rejects %s", (_name, value) => {
    const result = Array.isArray(value)
      ? validateSubjectDataRegistrations(value)
      : subjectDataRegistrationSchema.safeParse(value);
    expect(result.success).toBe(false);
  });
});
