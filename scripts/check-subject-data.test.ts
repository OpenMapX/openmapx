import { describe, expect, it } from "vitest";
import { validateSubjectDataInventory } from "./check-subject-data";

describe("subject-data policy gate", () => {
  it("classifies encrypted migration preview actor attribution", () => {
    expect(
      validateSubjectDataInventory({
        directUserForeignKeys: ["configuration_migration_preview.actor_id"],
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
      directUserForeignKeys: ["oauth_access_token.user_id", "account_action_receipt.actor_id"],
      directUserForeignKeyClassifications: {
        "oauth_access_token.user_id": "auth-oauth-resources",
        "account_action_receipt.actor_id": "admin-audit-attribution",
      },
      manifestSubjects: [],
    });
    expect(result.errors).toEqual([
      "direct user foreign key oauth_access_token.user_id is classified under auth-oauth-resources, but the catalogue locates it under auth-oauth-tokens",
      "direct user foreign key account_action_receipt.actor_id is classified under admin-audit-attribution, but the catalogue locates it under administrative-receipts",
    ]);
  });

  it("reports a direct user foreign key without an erasure/catalogue classification", () => {
    const result = validateSubjectDataInventory({
      directUserForeignKeys: ["new_table.user_id"],
    });
    expect(result.errors.some((error) => error.includes("new_table.user_id"))).toBe(true);
  });
});
