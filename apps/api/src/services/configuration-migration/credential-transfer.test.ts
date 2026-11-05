import { describe, expect, it } from "vitest";
import {
  decodeTransferredFeedCredentialMap,
  decryptCredentialTransfer,
  encryptCredentialTransfer,
} from "./credential-transfer";

describe("bounded authenticated credential envelopes", () => {
  const payload = {
    version: 1 as const,
    entries: [
      { scope: "integration" as const, id: "example", key: "TOKEN", value: "synthetic credential" },
    ],
  };
  it("round trips and authenticates all metadata and ciphertext", async () => {
    const envelope = await encryptCredentialTransfer("actor", payload, "synthetic passphrase");
    expect(await decryptCredentialTransfer("actor", envelope, "synthetic passphrase")).toEqual(
      payload,
    );
    await expect(
      decryptCredentialTransfer("actor", envelope, "wrong passphrase"),
    ).rejects.toThrow();
    await expect(
      decryptCredentialTransfer(
        "actor",
        { ...envelope, kdf: { ...envelope.kdf, N: 1048576 } },
        "synthetic passphrase",
      ),
    ).rejects.toThrow();
    await expect(
      decryptCredentialTransfer(
        "actor",
        { ...envelope, cipher: { ...envelope.cipher, tag: "A".repeat(22) } },
        "synthetic passphrase",
      ),
    ).rejects.toThrow();
  });
  it("rejects duplicate entries and expanded envelope overflow", async () => {
    await expect(
      encryptCredentialTransfer(
        "actor",
        { ...payload, entries: [payload.entries[0]!, payload.entries[0]!] },
        "synthetic passphrase",
      ),
    ).rejects.toThrow();
    await expect(
      encryptCredentialTransfer(
        "actor",
        {
          version: 1,
          entries: Array.from({ length: 60 }, (_, n) => ({
            scope: "integration",
            id: "example",
            key: `KEY${n}`,
            value: "x".repeat(16384),
          })),
        },
        "synthetic passphrase",
      ),
    ).rejects.toThrow();
  });
  it("rejects duplicate managed map members, unsafe names and UTF-8 overflow", () => {
    expect(() => decodeTransferredFeedCredentialMap('{"a":"1","a":"2"}')).toThrow();
    expect(() => decodeTransferredFeedCredentialMap('{"__proto__":"1"}')).toThrow();
    expect(() =>
      decodeTransferredFeedCredentialMap(JSON.stringify({ a: "é".repeat(4097) })),
    ).toThrow();
    expect(decodeTransferredFeedCredentialMap('{"a":"synthetic"}')).toEqual({ a: "synthetic" });
  });
  it("bounds KDF concurrency by actor and process and releases rejected slots", async () => {
    const first = encryptCredentialTransfer("actor-a", payload, "synthetic passphrase"),
      second = encryptCredentialTransfer("actor-b", payload, "synthetic passphrase");
    await expect(
      encryptCredentialTransfer("actor-a", payload, "synthetic passphrase"),
    ).rejects.toThrow();
    await expect(
      encryptCredentialTransfer("actor-c", payload, "synthetic passphrase"),
    ).rejects.toThrow();
    await Promise.all([first, second]);
    await expect(
      encryptCredentialTransfer("actor-c", payload, "synthetic passphrase"),
    ).resolves.toHaveProperty("format", "openmapx-vault-transfer");
  });
});
