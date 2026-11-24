import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const AUTH_SCHEMA = join(import.meta.dirname, "..", "db", "auth-schema.ts");

describe("Better Auth schema indexes", () => {
  it("the generated auth schema declares the plugin's indexes", () => {
    const schema = readFileSync(AUTH_SCHEMA, "utf8");

    expect(schema).toContain(
      'uniqueIndex("account_provider_id_account_id_key").on(table.providerId, table.accountId)',
    );
    expect(schema).toContain('index("session_expires_at_idx").on(table.expiresAt)');
    expect(schema).toContain('index("oauth_access_token_expires_at_idx").on(table.expiresAt)');
    expect(schema).toContain('index("oauth_refresh_token_expires_at_idx").on(table.expiresAt)');
    expect(schema).toContain('index("oauth_client_assertion_expires_at_idx").on(table.expiresAt)');
    expect(schema).toContain('uniqueIndex("passkey_credential_id_key").on(table.credentialID)');
    // Better Auth's own non-unique credential index stays as generated.
    expect(schema).toContain('index("passkey_credentialID_idx").on(table.credentialID)');
  });
});
