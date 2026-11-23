import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./unique-violation";

const violation = (constraint: string, code = "23505") =>
  Object.assign(new Error("duplicate key"), { code, constraint_name: constraint });

describe("isUniqueViolation", () => {
  it("recognizes the named constraint directly and through driver wrapping", () => {
    expect(
      isUniqueViolation(violation("saved_list_user_id_name_key"), "saved_list_user_id_name_key"),
    ).toBe(true);
    const wrapped = new Error("Failed query", { cause: violation("saved_list_user_id_name_key") });
    expect(isUniqueViolation(wrapped, "saved_list_user_id_name_key")).toBe(true);
  });

  it("rejects other constraints, other error codes and non-database errors", () => {
    expect(isUniqueViolation(violation("saved_list_pkey"), "saved_list_user_id_name_key")).toBe(
      false,
    );
    expect(
      isUniqueViolation(
        violation("saved_list_user_id_name_key", "23503"),
        "saved_list_user_id_name_key",
      ),
    ).toBe(false);
    expect(isUniqueViolation(new Error("connection reset"), "saved_list_user_id_name_key")).toBe(
      false,
    );
    expect(isUniqueViolation(null, "saved_list_user_id_name_key")).toBe(false);
  });
});
