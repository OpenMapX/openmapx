let lastMs = 0;
let sequence = 0;

/**
 * An RFC 9562 version 7 UUID, the kind PostgreSQL's `uuidv7()` makes: 48 bits
 * of Unix milliseconds, then random bits. Ids taken from the clock sort in
 * creation order within this process: inside one millisecond the 12-bit
 * `rand_a` field counts up from a random start, and a clock that steps back
 * keeps the last millisecond. An explicit `now` sets the timestamp and leaves
 * that order alone.
 */
export function uuidv7(now?: number): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer);
  let ms = now ?? Date.now();
  let randA = view.getUint16(6) & 0xfff;
  if (now === undefined) {
    if (ms > lastMs) {
      lastMs = ms;
      sequence = randA >> 1;
    } else if (++sequence > 0xfff) {
      lastMs += 1;
      sequence = 0;
    }
    ms = lastMs;
    randA = sequence;
  }
  view.setUint16(0, Math.floor(ms / 2 ** 32));
  view.setUint32(2, ms % 2 ** 32);
  view.setUint16(6, 0x7000 | randA);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
