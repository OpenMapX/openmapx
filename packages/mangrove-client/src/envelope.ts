/**
 * Envelope encryption for Mangrove keypairs, backed by age-encryption.js
 * (https://github.com/FiloSottile/typage). Uses the age v1 spec (scrypt
 * passphrase stanzas, ChaCha20-Poly1305 AEAD) plus the `fido2prf` age plugin
 * for WebAuthn passkey recipients.
 *
 * Why two ciphertexts: the age spec forbids mixing a scrypt (passphrase)
 * recipient with any other recipient in the same ciphertext (anti-key-stuffing
 * per the original age RFC). To let a user unlock with *either* their
 * passphrase *or* any registered passkey, we store TWO armored ciphertexts of
 * the same plaintext:
 *   - `passphrase` ciphertext: scrypt-only
 *   - `recipients` ciphertext: 1..N WebAuthnRecipient entries (any one unlocks)
 *
 * Both decrypt to the same JSON-stringified private JWK.
 */

import * as age from "age-encryption";

/**
 * Default "name" shown by the browser when a passkey is created for review
 * signing. Hosts should override this per-deployment by passing a `keyName` to
 * {@link createWebAuthnIdentity} so the credential is identifiable in the
 * user's password manager / OS keychain.
 */
export const WEBAUTHN_CREDENTIAL_KEY_NAME = "Mangrove Reviews";

// ── base64url helpers (still used by signing / JWK plumbing) ─────────────

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = typeof Buffer !== "undefined" ? Buffer.from(bytes).toString("base64") : btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const padded = b64
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const source =
    typeof Buffer !== "undefined"
      ? new Uint8Array(Buffer.from(padded, "base64"))
      : (() => {
          const binary = atob(padded);
          const out = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
          return out;
        })();
  const ab = new ArrayBuffer(source.length);
  const out = new Uint8Array(ab);
  out.set(source);
  return out;
}

// ── plaintext helpers ────────────────────────────────────────────────────

function jwkToBytes(jwk: JsonWebKey): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(jwk));
}

function bytesToJwk(bytes: Uint8Array): JsonWebKey {
  return JSON.parse(new TextDecoder().decode(bytes)) as JsonWebKey;
}

// ── passphrase ciphertext (scrypt-only) ──────────────────────────────────

/**
 * Encrypt the private JWK with a passphrase using age's scrypt stanza.
 *
 * Per the age spec this MUST be the only recipient — to also allow passkey
 * unlock, encrypt a second copy via {@link encryptForWebAuthnIdentities}.
 */
export async function encryptWithPassphrase(
  privateJwk: JsonWebKey,
  passphrase: string,
): Promise<string> {
  if (!passphrase) throw new Error("Passphrase cannot be empty");
  const encrypter = new age.Encrypter();
  encrypter.setPassphrase(passphrase);
  const ct = await encrypter.encrypt(jwkToBytes(privateJwk));
  return age.armor.encode(ct);
}

export async function decryptWithPassphrase(
  armoredCiphertext: string,
  passphrase: string,
): Promise<JsonWebKey> {
  const decrypter = new age.Decrypter();
  decrypter.addPassphrase(passphrase);
  const pt = await decrypter.decrypt(age.armor.decode(armoredCiphertext));
  return bytesToJwk(pt);
}

// ── WebAuthn (passkey) recipients ────────────────────────────────────────

/**
 * Register a new WebAuthn credential and return its age identity string
 * (begins with `AGE-PLUGIN-FIDO2PRF-1...`). The string encodes the credential
 * id, RP id, and transport hints — no secret material — so it's safe to store
 * server-side for later `allowCredentials` hints.
 *
 * `type: "passkey"` (default) creates a discoverable credential — any
 * registered passkey can unlock without us having to send its id first.
 * `type: "security-key"` targets hardware tokens (e.g. YubiKey) and the user
 * MUST retain the identity string since the credential is not discoverable.
 */
export async function createWebAuthnIdentity(options: {
  rpId?: string;
  keyName?: string;
  type?: "passkey" | "security-key";
}): Promise<string> {
  return age.webauthn.createCredential({
    keyName: options.keyName ?? WEBAUTHN_CREDENTIAL_KEY_NAME,
    rpId: options.rpId,
    type: options.type ?? "passkey",
  });
}

/**
 * Encrypt the private JWK for one or more WebAuthn passkey recipients. Any
 * single listed credential can decrypt the resulting ciphertext.
 */
export async function encryptForWebAuthnIdentities(
  privateJwk: JsonWebKey,
  identityStrings: string[],
  rpId?: string,
): Promise<string> {
  if (identityStrings.length === 0) {
    throw new Error("At least one WebAuthn identity is required");
  }
  const encrypter = new age.Encrypter();
  for (const identity of identityStrings) {
    encrypter.addRecipient(new age.webauthn.WebAuthnRecipient({ identity, rpId }));
  }
  const ct = await encrypter.encrypt(jwkToBytes(privateJwk));
  return age.armor.encode(ct);
}

/**
 * Decrypt a WebAuthn-wrapped ciphertext. When `identityString` is omitted,
 * the browser surfaces the standard discoverable-credential picker, so the
 * user can choose between any of their registered passkeys.
 */
export async function decryptWithWebAuthn(
  armoredCiphertext: string,
  options: { rpId?: string; identityString?: string } = {},
): Promise<JsonWebKey> {
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(
    new age.webauthn.WebAuthnIdentity({
      identity: options.identityString,
      rpId: options.rpId,
    }),
  );
  const pt = await decrypter.decrypt(age.armor.decode(armoredCiphertext));
  return bytesToJwk(pt);
}

/** Feature-detect WebAuthn + PRF-capable authenticator availability. */
export function isWebAuthnAvailable(): boolean {
  return (
    typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials?.get
  );
}
