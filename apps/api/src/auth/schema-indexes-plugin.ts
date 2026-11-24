import type { BetterAuthPlugin } from "better-auth";

/**
 * Indexes Better Auth does not declare itself, added through its own schema
 * extension point so that `auth:generate` writes them into `auth-schema.ts`.
 *
 * Better Auth merges a plugin's `indexes` into the table of the same key, core
 * or plugin. The tables' fields come from Better Auth and the plugins that own
 * them, so this plugin must be registered after those plugins.
 *
 * - Social sign-in looks an account up by provider and provider account id and
 *   fails when it finds two; the unique index lets the database refuse the
 *   second one instead of an application check with a race window.
 * - Pruning expired sessions, OAuth tokens and client assertions selects by
 *   expiry.
 * - A WebAuthn credential id is globally unique.
 */
export function schemaIndexes() {
  return {
    id: "openmapx-schema-indexes",
    schema: {
      account: {
        fields: {},
        indexes: [
          {
            name: "account_provider_id_account_id_key",
            fields: ["providerId", "accountId"],
            unique: true,
          },
        ],
      },
      session: {
        fields: {},
        indexes: [{ name: "session_expires_at_idx", fields: ["expiresAt"] }],
      },
      oauthAccessToken: {
        fields: {},
        indexes: [{ name: "oauth_access_token_expires_at_idx", fields: ["expiresAt"] }],
      },
      oauthRefreshToken: {
        fields: {},
        indexes: [{ name: "oauth_refresh_token_expires_at_idx", fields: ["expiresAt"] }],
      },
      oauthClientAssertion: {
        fields: {},
        indexes: [{ name: "oauth_client_assertion_expires_at_idx", fields: ["expiresAt"] }],
      },
      passkey: {
        fields: {},
        indexes: [{ name: "passkey_credential_id_key", fields: ["credentialID"], unique: true }],
      },
    },
  } satisfies BetterAuthPlugin;
}
