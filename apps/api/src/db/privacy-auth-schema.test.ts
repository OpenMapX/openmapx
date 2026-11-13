import { describe, expect, it } from "vitest";
import { sessionAuthAssurance } from "./privacy-auth-schema.js";

describe("privacy authentication schema", () => {
  it("keeps assurance tied to the Better Auth session", () => {
    expect(sessionAuthAssurance.sessionId.primary).toBe(true);
    expect(sessionAuthAssurance.authenticatedAt.notNull).toBe(true);
  });
});
