/**
 * Base64 without `Buffer` or `btoa`.
 *
 * React Native provides neither reliably, and `btoa` would corrupt any non-ASCII
 * character anyway — stop names and cue text are routinely non-ASCII, so the
 * encoder works on UTF-8 bytes rather than on code units.
 */

const STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encode(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += alphabet[a >> 2];
    out += alphabet[((a & 0b11) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) {
      if (pad) out += "==";
      break;
    }
    out += alphabet[((b & 0b1111) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) {
      if (pad) out += "=";
      break;
    }
    out += alphabet[c & 0b111111];
  }
  return out;
}

/** Standard base64 with padding — what the page's `atob` expects. */
export function encodeBase64(bytes: Uint8Array): string {
  return encode(bytes, STANDARD, true);
}

/** URL-safe, unpadded. Used for the channel nonce, which travels in JSON. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return encode(bytes, URL_SAFE, false);
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
