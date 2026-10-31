import { expect, it } from "vitest";
import { assertAccountDeletionAllowed, mapAccountConstraint } from "./admin-invariant";

it("denies an erasure hook without the owning account transaction before any data access", async () => {
  await expect(assertAccountDeletionAllowed("untrusted-target")).rejects.toThrow(
    "Account deletion transaction required",
  );
});
it("maps only the named database invariant and keeps database diagnostics out of the public error", () => {
  let error: unknown;
  try {
    mapAccountConstraint({
      cause: { constraint_name: "LAST_ADMIN_REQUIRED", message: "sensitive SQL diagnostic" },
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ statusCode: 409, body: { code: "LAST_ADMIN_REQUIRED" } });
  expect(JSON.stringify(error)).not.toContain("sensitive SQL diagnostic");
  const other = { cause: { constraint_name: "some_other_constraint" } };
  try {
    mapAccountConstraint(other);
    throw Error("Expected failure");
  } catch (caught) {
    expect(caught).toBe(other);
  }
});
