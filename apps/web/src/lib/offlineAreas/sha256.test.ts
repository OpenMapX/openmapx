import { describe, expect, it } from "vitest";
import { Sha256 } from "./sha256";

function digest(value: string): string {
  return new Sha256().update(new TextEncoder().encode(value)).digestHex();
}

describe("Sha256", () => {
  it("matches standard vectors", () => {
    expect(digest("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(digest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("supports incremental chunks and does not consume the digest", () => {
    const hash = new Sha256();
    hash.update(new TextEncoder().encode("a"));
    hash.update(new TextEncoder().encode("b"));
    hash.update(new TextEncoder().encode("c"));
    expect(hash.digestHex()).toBe(hash.digestHex());
    expect(hash.digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
