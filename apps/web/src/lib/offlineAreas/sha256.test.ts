import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

// Offline package downloads hash the archive incrementally with this library.
function digest(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

describe("SHA-256 for offline package archives", () => {
  it("matches standard vectors", () => {
    expect(digest("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(digest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("gives the same digest over incremental chunks", () => {
    const hash = sha256.create();
    hash.update(new TextEncoder().encode("a"));
    hash.update(new TextEncoder().encode("b"));
    hash.update(new TextEncoder().encode("c"));
    expect(bytesToHex(hash.digest())).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
