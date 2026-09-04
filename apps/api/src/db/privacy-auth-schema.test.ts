import { describe, expect, it } from "vitest";
import { dataExportReauthentication, sessionAuthAssurance } from "./privacy-auth-schema.js";

describe("privacy authentication schema", () => {
  it("keeps assurance tied to the Better Auth session and challenges artifact-scoped", () => {
    expect(sessionAuthAssurance.sessionId.primary).toBe(true);
    expect(dataExportReauthentication.requestId.notNull).toBe(true);
    expect(dataExportReauthentication.artifactId.notNull).toBe(true);
    expect(dataExportReauthentication.nonceDigest.notNull).toBe(true);
  });
});
