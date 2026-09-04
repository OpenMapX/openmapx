import { describe, expect, it } from "vitest";
import { validateSubjectDataInventory } from "./check-subject-data";

describe("subject-data policy gate", () => {
  it("passes the checked-in catalogue and manifests", () => {
    const result = validateSubjectDataInventory();
    expect(result.errors).toEqual([]);
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

  it("reports a direct user foreign key without an erasure/catalogue classification", () => {
    const result = validateSubjectDataInventory({
      directUserForeignKeys: ["new_table.user_id"],
    });
    expect(result.errors.some((error) => error.includes("new_table.user_id"))).toBe(true);
  });
});
