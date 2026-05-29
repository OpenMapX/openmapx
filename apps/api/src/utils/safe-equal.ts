import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Returns false immediately on a length
 * mismatch (the length is not secret), otherwise compares the bytes without an
 * early-out so the timing does not leak how many characters matched.
 */
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
