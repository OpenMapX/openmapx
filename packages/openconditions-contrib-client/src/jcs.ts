import canonicalize from "canonicalize";

/**
 * Upper bound on the canonical (JCS) byte length of a claim or sub-claim body.
 * Anything larger is rejected before signing. Mirrors contrib-core.
 */
export const MAX_CANONICAL_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/**
 * RFC 8785 (JCS) canonical UTF-8 bytes of a claim tree — the exact bytes the
 * ES256 signatures cover. Exported so the conformance test can pin signature
 * inputs byte-for-byte. Canonicalization is delegated entirely to the pinned
 * `canonicalize` package (the JCS reference implementation, EXACT version
 * @openconditions/contrib-core uses); nothing here is hand-rolled.
 *
 * @throws TypeError when the value contains a non-finite number, is nested too
 *   deeply to canonicalize, or is not JSON-serializable at all
 *   (undefined, function, symbol); Error on a circular reference.
 */
export function canonicalClaimBytes(claim: unknown): Uint8Array<ArrayBuffer> {
  let text: string | undefined;
  try {
    text = canonicalize(claim);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new TypeError("canonicalClaimBytes: value is nested too deeply to canonicalize");
    }
    if (err instanceof Error && /NaN|Infinity/.test(err.message)) {
      throw new TypeError("canonicalClaimBytes: non-finite number in value");
    }
    throw err;
  }
  if (text === undefined) {
    throw new TypeError("canonicalClaimBytes: value is not JSON-serializable");
  }
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

/**
 * Canonical bytes with the {@link MAX_CANONICAL_BYTES} wire cap applied.
 *
 * @throws TypeError when the canonical form exceeds the cap.
 */
export function boundedCanonicalBytes(value: unknown, label: string): Uint8Array<ArrayBuffer> {
  const bytes = canonicalClaimBytes(value);
  if (bytes.byteLength > MAX_CANONICAL_BYTES) {
    throw new TypeError(
      `${label} exceeds the 64 KiB canonical size limit: ${bytes.byteLength} bytes`,
    );
  }
  return bytes;
}
