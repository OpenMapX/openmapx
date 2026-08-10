import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * One in-flight transfer of a session from the system browser into the WebView.
 *
 * The installed app never holds a session. When a sign-in has to happen in the
 * system browser — because embedded user agents are not a durable contract for
 * OAuth or WebAuthn — the browser establishes the session, and this row is the
 * only thing that crosses back. It is deliberately not a token: it is a lookup
 * key that can be redeemed exactly once, by whoever proves they started the
 * attempt.
 *
 * What is stored, and what is not:
 *
 *  - The callback code is stored **hashed**. The raw code travels through a
 *    custom-scheme URL the OS routes, which is the least private part of this
 *    whole exchange; a database read must not yield something redeemable.
 *  - The PKCE challenge is stored, the verifier never is. That is the entire
 *    point of PKCE: another app that intercepted the callback still cannot
 *    redeem it, because it never had the verifier.
 *  - The one-time token is stored, because the exchange has to hand it back.
 *    It is already single-use and already expires in two minutes, and the row
 *    holding it is deleted the instant it is consumed.
 *
 * Nothing here is a session cookie, a password, an OAuth token, or a passkey
 * assertion, and none of those may ever be added.
 */
export const mobileAuthHandoff = pgTable(
  "mobile_auth_handoff",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the raw callback code, base64url. Never the code itself. */
    callbackCodeHash: text("callback_code_hash").notNull().unique(),
    /** The S256 PKCE challenge. The verifier is never stored. */
    codeChallenge: text("code_challenge").notNull(),
    /** Per-attempt random value, echoed back so a stray callback is detectable. */
    state: text("state").notNull(),
    /** `sign-in` | `link-provider` | `add-passkey`. */
    purpose: text("purpose").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The Better Auth one-time token, itself single-use and short-lived. */
    oneTimeToken: text("one_time_token").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    /** Set the moment it is redeemed, so a replay finds a consumed row. */
    consumedAt: timestamp("consumed_at"),
  },
  (table) => [
    // Expiry scrubbing walks this, and it also bounds how many outstanding
    // attempts one account can accumulate.
    index("mobile_auth_handoff_user_expires_idx").on(table.userId, table.expiresAt),
  ],
);
