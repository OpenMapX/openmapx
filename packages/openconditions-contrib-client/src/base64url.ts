/**
 * Minimal unpadded base64url (RFC 4648 section 5) codec over Uint8Array.
 *
 * This is plain data ENCODING, not cryptography. It exists because the package
 * must run identically in browsers and Node without `node:` imports (no
 * Buffer), and the platform `Uint8Array.prototype.toBase64` is not yet
 * available across every supported runtime/TS lib target.
 *
 * Mirrors @openconditions/contrib-core's base64url codec byte-for-byte so the
 * signed envelopes this client produces decode identically on the verifier.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const REVERSE = new Map<string, number>([...ALPHABET].map((char, index) => [char, index]));

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * Strict decode: rejects non-alphabet characters, impossible lengths, and
 * non-canonical trailing bits (two encodings never decode to the same bytes).
 *
 * @throws TypeError on any invalid input.
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || text.length % 4 === 1) {
    throw new TypeError("invalid base64url input");
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let outIndex = 0;
  for (let i = 0; i < text.length; i += 4) {
    const group = text.slice(i, i + 4);
    const values = [...group].map((char) => {
      const value = REVERSE.get(char);
      if (value === undefined) throw new TypeError("invalid base64url character");
      return value;
    });
    const [c0, c1, c2, c3] = values;
    out[outIndex++] = (c0 << 2) | (c1 >> 4);
    if (values.length === 2 && (c1 & 0x0f) !== 0) {
      throw new TypeError("non-canonical base64url trailing bits");
    }
    if (values.length >= 3) {
      out[outIndex++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
      if (values.length === 3 && (c2 & 0x03) !== 0) {
        throw new TypeError("non-canonical base64url trailing bits");
      }
    }
    if (values.length === 4) {
      out[outIndex++] = ((c2 & 0x03) << 6) | c3;
    }
  }
  return out;
}
