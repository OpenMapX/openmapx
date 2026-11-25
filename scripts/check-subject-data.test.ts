import { describe, expect, it } from "vitest";
import { SUBJECT_DATA_CATALOGUE } from "../apps/api/src/privacy/catalogue";
import { validateSubjectDataInventory } from "./check-subject-data";

describe("subject-data policy gate", () => {
  it("classifies encrypted migration preview actor attribution", () => {
    expect(
      validateSubjectDataInventory({
        directUserForeignKeys: ["configuration_migration_preview.actor_user_id"],
      }).errors,
    ).toEqual([]);
  });

  it("reports unknown manifest registration ids", () => {
    const result = validateSubjectDataInventory({
      manifestSubjects: [
        {
          source: "integration",
          id: "fixture",
          subjectData: {
            storesPersonalData: true,
            strategy: "collector",
            registrationIds: ["does-not-exist"],
            operatorInstructions: null,
          },
        },
      ],
    });
    expect(result.errors.some((error) => error.includes("does-not-exist"))).toBe(true);
  });

  it("treats an integration without a declaration as storing no personal data", () => {
    const result = validateSubjectDataInventory({
      directUserForeignKeys: [],
      manifestSubjects: [{ source: "integration", id: "fixture", subjectData: undefined }],
    });
    expect(result.errors).toEqual([]);
  });

  it("still requires every service to declare its personal-data storage", () => {
    const result = validateSubjectDataInventory({
      directUserForeignKeys: [],
      manifestSubjects: [{ source: "service", id: "fixture", subjectData: undefined }],
    });
    expect(result.errors).toEqual(["service/fixture: missing subjectData declaration"]);
  });

  it("classifies each located column under the registration that locates it", () => {
    expect(validateSubjectDataInventory({ manifestSubjects: [] }).errors).toEqual([]);
    const result = validateSubjectDataInventory({
      directUserForeignKeys: ["oauth_access_token.user_id", "account_action_receipt.actor_user_id"],
      directUserForeignKeyClassifications: {
        "oauth_access_token.user_id": "auth-oauth-resources",
        "account_action_receipt.actor_user_id": "admin-audit-attribution",
      },
      manifestSubjects: [],
    });
    expect(result.errors).toEqual([
      "direct user foreign key oauth_access_token.user_id is classified under auth-oauth-resources, but the catalogue locates it under auth-oauth-tokens",
      "direct user foreign key account_action_receipt.actor_user_id is classified under admin-audit-attribution, but the catalogue locates it under administrative-receipts",
    ]);
  });

  it("refuses a classified column that no registration locates", () => {
    const result = validateSubjectDataInventory({
      catalogue: SUBJECT_DATA_CATALOGUE.filter(
        (item) => item.id !== "privacy-case-handling-attribution",
      ),
      directUserForeignKeys: ["data_subject_request_event.actor_user_id"],
      directUserForeignKeyClassifications: {
        "data_subject_request_event.actor_user_id": "privacy-case-records",
      },
      manifestSubjects: [],
    });
    expect(result.errors).toEqual([
      "direct user foreign key data_subject_request_event.actor_user_id is classified under privacy-case-records, which does not locate it",
    ]);
  });

  it("locates the OAuth client and consent columns under the OAuth resources registration", () => {
    const result = validateSubjectDataInventory({
      directUserForeignKeys: ["oauth_client.user_id", "oauth_consent.user_id"],
      directUserForeignKeyClassifications: {
        "oauth_client.user_id": "auth-oauth-tokens",
        "oauth_consent.user_id": "auth-oauth-tokens",
      },
      manifestSubjects: [],
    });
    expect(result.errors).toEqual([
      "direct user foreign key oauth_client.user_id is classified under auth-oauth-tokens, but the catalogue locates it under auth-oauth-resources",
      "direct user foreign key oauth_consent.user_id is classified under auth-oauth-tokens, but the catalogue locates it under auth-oauth-resources",
    ]);
  });

  it("reports a database locator of an account id that names no known column", () => {
    const registration = SUBJECT_DATA_CATALOGUE.find((item) => item.id === "auth-oauth-resources");
    if (!registration) throw new Error("auth-oauth-resources is missing");
    const result = validateSubjectDataInventory({
      catalogue: [
        {
          ...registration,
          locators: [
            { type: "user_id", field: "oauth-client.user_id" },
            { type: "user_id", field: "user.id" },
            { type: "exact_identifier", field: "verification.identifier", format: "email" },
          ],
        },
      ],
      directUserForeignKeys: [],
      manifestSubjects: [],
    });
    expect(result.errors).toEqual([
      "catalogue: auth-oauth-resources locates oauth-client.user_id, which is no known account column",
    ]);
  });

  it("reports a direct user foreign key without an erasure/catalogue classification", () => {
    const result = validateSubjectDataInventory({
      directUserForeignKeys: ["new_table.user_id"],
    });
    expect(result.errors.some((error) => error.includes("new_table.user_id"))).toBe(true);
  });
});
