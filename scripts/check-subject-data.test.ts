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

  it("reports a direct user foreign key without an erasure/catalogue classification", () => {
    const result = validateSubjectDataInventory({
      directUserForeignKeys: ["new_table.user_id"],
    });
    expect(result.errors.some((error) => error.includes("new_table.user_id"))).toBe(true);
  });
});
