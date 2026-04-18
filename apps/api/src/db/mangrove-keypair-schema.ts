import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * Per-user Mangrove.reviews ECDSA P-256 keypair.
 *
 * Encryption is done via age (https://age-encryption.org) using the
 * `age-encryption` npm package. The age spec forbids mixing a scrypt
 * (passphrase) recipient with any other recipient in a single ciphertext,
 * so we store TWO ciphertexts of the same plaintext when a user has both
 * a passphrase and at least one passkey:
 *   - `passphraseCiphertext`: age scrypt-only ciphertext.
 *   - `recipientsCiphertext`: age ciphertext with one WebAuthn PRF
 *     recipient per registered passkey (any single passkey unlocks).
 *
 * Either ciphertext decrypts to the same private JWK bytes, so the user
 * can unlock with a passphrase OR any registered passkey.
 *
 * Adding or removing a passkey requires the user to be currently
 * unlocked (we need the plaintext to re-encrypt with the new recipient
 * set). Same for changing the passphrase.
 */
export const mangroveKeypair = pgTable("mangrove_keypair", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** "unencrypted" | "encrypted" */
  encryptionMode: text("encryption_mode").notNull(),
  publicJwk: jsonb("public_jwk").notNull(),
  /** Cleartext private JWK — only when encryptionMode = "unencrypted". */
  privateJwk: jsonb("private_jwk"),
  /** age-encoded ciphertext with a single scrypt recipient. Null if user has no passphrase wrap. */
  passphraseCiphertext: text("passphrase_ciphertext"),
  /** age-encoded ciphertext with N WebAuthn PRF recipients. Null if user has no passkey wraps. */
  recipientsCiphertext: text("recipients_ciphertext"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Metadata for each unlock method. Server enforces:
 *   - at most one passphrase wrap per user
 *   - at least one wrap per user (the LAST one cannot be removed)
 *   - when encryptionMode = "encrypted", at least one wrap must exist
 *
 * `identityString` for webauthn wraps is the age plugin identity returned
 * from `age.webauthn.createCredential` (begins with `AGE-PLUGIN-FIDO2PRF-1...`).
 * It encodes the credential id, RP id, and transport hint — no secret
 * material — so it's safe to store cleartext.
 */
export const mangroveKeypairWrap = pgTable("mangrove_keypair_wrap", {
  id: text("id").primaryKey(),
  // FK points at `mangrove_keypair.user_id` (not directly at `user.id`) so
  // deleting a keypair also drops its wraps. `mangrove_keypair.user_id` itself
  // cascades from `user.id`, so user deletion still propagates all the way.
  userId: text("user_id")
    .notNull()
    .references((): AnyPgColumn => mangroveKeypair.userId, { onDelete: "cascade" }),
  /** "passphrase" | "webauthn" */
  wrapType: text("wrap_type").notNull(),
  /** User-friendly label ("Main passphrase", "iPhone", "YubiKey primary"). */
  label: text("label").notNull(),
  /**
   * age plugin identity string (webauthn only). Not a secret — but handing
   * it out to the wrong origin would let a passkey with PRF on that origin
   * attempt to unlock, so we only ever surface it to the authenticated user.
   */
  identityString: text("identity_string"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
