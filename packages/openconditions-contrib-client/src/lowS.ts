/**
 * Low-S signature canonicalization for P-256 ECDSA (COSE / BIP-62 style).
 *
 * ECDSA is inherently malleable: for any valid signature (r, s) the pair
 * (r, n - s) verifies too. Enforcing the low-S form (s <= n/2) on the signing
 * side leaves exactly one accepted encoding per signature — the encoding the
 * OpenConditions verifier requires.
 *
 * This module is canonical-form NORMALIZATION of WebCrypto's raw r||s output,
 * not new cryptography: signatures are still produced exclusively by
 * `crypto.subtle`; the only arithmetic here is a big-integer compare and one
 * subtraction against the public curve constant n. Copied byte-for-byte from
 * @openconditions/contrib-core (the parity-critical bit).
 */

/** P-256 (secp256r1) group order n, from SEC 2 / FIPS 186-4. */
export const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** floor(n / 2): the largest s allowed in canonical (low-S) form. */
export const P256_HALF_ORDER = P256_ORDER >> 1n;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function writeBigIntTo32(value: bigint, target: Uint8Array, offset: number): void {
  let rest = value;
  for (let i = offset + 31; i >= offset; i--) {
    target[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

/**
 * Return the low-S form of a raw 64-byte r||s signature: if s > n/2, s is
 * replaced by n - s (an equally valid signature over the same bytes under the
 * same key); a signature already in low-S form is returned as-is.
 *
 * @throws TypeError when the input is not exactly 64 bytes.
 */
export function normalizeLowS(raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (raw.length !== 64) {
    throw new TypeError(`normalizeLowS requires a raw 64-byte r||s signature, got ${raw.length}`);
  }
  const s = bytesToBigInt(raw.subarray(32));
  if (s <= P256_HALF_ORDER) return raw;
  const normalized = new Uint8Array(raw) as Uint8Array<ArrayBuffer>;
  writeBigIntTo32(P256_ORDER - s, normalized, 32);
  return normalized;
}

/** The s component of a raw 64-byte r||s signature, as a bigint. */
export function signatureS(raw: Uint8Array): bigint {
  return bytesToBigInt(raw.subarray(32));
}
