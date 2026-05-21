/**
 * ECDSA P-256 keypair utilities for the Mangrove Open Reviews Standard.
 *
 * Works in both browser and Node (WebCrypto via globalThis.crypto) so we can
 * share the same code between the review submission form (client) and the
 * Better Auth keypair storage endpoint (server).
 *
 * Spec references:
 *  - Algorithm: ES256 (ECDSA P-256 + SHA-256)
 *  - `kid` header: single-line PEM of the public key — NO newlines between
 *    the BEGIN/END markers (a Mangrove-specific quirk).
 *  - `jwk` header: stringified JSON Web Key of the public key (x + y only).
 */

export interface MangroveKeypair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface SerializedMangroveKeypair {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

/** WebCrypto algorithm identifier shared by generateKey and importKey. */
const ALGO: EcKeyGenParams & EcKeyImportParams = {
  name: "ECDSA",
  namedCurve: "P-256",
};

const SUBTLE = globalThis.crypto?.subtle;

function assertSubtle(): SubtleCrypto {
  if (!SUBTLE) {
    throw new Error(
      "globalThis.crypto.subtle is unavailable. Node 16+ or a modern browser is required.",
    );
  }
  return SUBTLE;
}

/** Generate a fresh extractable ECDSA P-256 keypair. */
export async function generateKeypair(): Promise<MangroveKeypair> {
  const subtle = assertSubtle();
  const kp = (await subtle.generateKey(ALGO, true, ["sign", "verify"])) as CryptoKeyPair;
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/** Export a keypair to a pair of JWK objects for storage (Better Auth). */
export async function keypairToJwk(kp: MangroveKeypair): Promise<SerializedMangroveKeypair> {
  const subtle = assertSubtle();
  const privateJwk = await subtle.exportKey("jwk", kp.privateKey);
  const publicJwk = await subtle.exportKey("jwk", kp.publicKey);
  return { privateJwk, publicJwk };
}

/** Re-import a stored JWK pair back into CryptoKey objects ready for signing. */
export async function jwkToKeypair(
  serialized: SerializedMangroveKeypair,
): Promise<MangroveKeypair> {
  const subtle = assertSubtle();
  const privateKey = await subtle.importKey("jwk", serialized.privateJwk, ALGO, true, ["sign"]);
  const publicKey = await subtle.importKey("jwk", serialized.publicJwk, ALGO, true, ["verify"]);
  return { privateKey, publicKey };
}

/** Re-import just the public JWK — used when the private key is locked but we still need the PEM. */
export async function importPublicJwk(publicJwk: JsonWebKey): Promise<CryptoKey> {
  const subtle = assertSubtle();
  return subtle.importKey("jwk", publicJwk, ALGO, true, ["verify"]);
}

/**
 * Mangrove's `metadata` magic marker — the mangrove.reviews importer rejects
 * JWKs that don't carry this exact string, even though it isn't part of the
 * standard JWK shape. Using the same constant keeps exported keys
 * round-trippable between OpenMapX and the official client.
 */
export const MANGROVE_JWK_METADATA = "Mangrove private key";

/** JWK shape mangrove.reviews expects for import. */
export type MangroveExportJwk = JsonWebKey & {
  alg: "ES256";
  ext: true;
  key_ops: ["sign"];
  metadata: typeof MANGROVE_JWK_METADATA;
};

/**
 * Decorate a raw private JWK with the fields mangrove.reviews' importer
 * requires (`alg`, `ext`, `key_ops`, `metadata`). Safe to reapply — all of
 * these are either normative JWK fields or Mangrove-specific markers.
 */
export function toMangroveExportJwk(privateJwk: JsonWebKey): MangroveExportJwk {
  return {
    ...privateJwk,
    alg: "ES256",
    ext: true,
    key_ops: ["sign"],
    metadata: MANGROVE_JWK_METADATA,
  };
}

/**
 * Derive the Mangrove-style single-line PEM used as the JWT `kid` header.
 * The public key is exported as SPKI DER, base64-encoded and wrapped with
 * `-----BEGIN PUBLIC KEY-----` / `-----END PUBLIC KEY-----` with NO newlines
 * in between — matching the `publicToPem` behaviour of the Mangrove JS lib.
 */
export async function publicKeyToPem(publicKey: CryptoKey): Promise<string> {
  const subtle = assertSubtle();
  const spki = await subtle.exportKey("spki", publicKey);
  const b64 = toBase64(new Uint8Array(spki));
  return `-----BEGIN PUBLIC KEY-----${b64}-----END PUBLIC KEY-----`;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
