import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./unique-violation";

const violation = (constraint: string, code = "23505") =>
  Object.assign(new Error("duplicate key"), { code, constraint_name: constraint });

describe("isUniqueViolation", () => {
  it("recognizes the named constraint directly and through driver wrapping", () => {
    expect(
      isUniqueViolation(violation("savedList_userId_name_unq"), "savedList_userId_name_unq"),
    ).toBe(true);
    const wrapped = new Error("Failed query", { cause: violation("savedList_userId_name_unq") });
    expect(isUniqueViolation(wrapped, "savedList_userId_name_unq")).toBe(true);
  });

  it("rejects other constraints, other error codes and non-database errors", () => {
    expect(isUniqueViolation(violation("savedList_pkey"), "savedList_userId_name_unq")).toBe(false);
    expect(
      isUniqueViolation(
        violation("savedList_userId_name_unq", "23503"),
        "savedList_userId_name_unq",
      ),
    ).toBe(false);
    expect(isUniqueViolation(new Error("connection reset"), "savedList_userId_name_unq")).toBe(
      false,
    );
    expect(isUniqueViolation(null, "savedList_userId_name_unq")).toBe(false);
  });
});
