import { expect, it } from "vitest";
import { dataExecutionDiagnostic } from "./diagnostics";

it("scrubs credentials and host paths before bounding complete UTF-8 characters", () => {
  const value = dataExecutionDiagnostic(
    "\u001b[31mAuthorization: Bearer synthetic-secret /Users/operator/private/data C:\\private\\artifact " +
      "🗺".repeat(2000),
  );
  expect(value.message).not.toContain("synthetic-secret");
  expect(value.message).not.toContain("/Users/");
  expect(value.message).not.toContain("C:\\private");
  expect(value.message).not.toContain("\u001b");
  expect(value.message).not.toContain("�");
  expect(Buffer.byteLength(value.message)).toBeLessThanOrEqual(4096);
  expect(value.truncated).toBe(true);
});
