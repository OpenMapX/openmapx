import { beforeEach, describe, expect, it, vi } from "vitest";

// Inline drizzle-builder stub kept in vi.hoisted so the vi.mock factory (hoisted
// above imports) can reference it. `selectRows` is what the next select()...
// await resolves to; `inserted` captures rows passed to insert().values() so the
// upsert test can inspect the ciphertext/iv/tag that were written.
const h = vi.hoisted(() => {
  const state: { selectRows: unknown[]; inserted: Array<Record<string, unknown>> } = {
    selectRows: [],
    inserted: [],
  };
  const chain = (resolveWith: unknown): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where", "limit", "set", "onConflictDoUpdate"]) {
      c[m] = () => c;
    }
    c.values = (row: Record<string, unknown>) => {
      state.inserted.push(row);
      return c;
    };
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; the stub must mirror that.
    c.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolveWith).then(onF, onR);
    return c;
  };
  return { state, chain };
});

vi.mock("../../db", () => ({
  db: {
    select: () => h.chain(h.state.selectRows),
    insert: () => h.chain(undefined),
    delete: () => h.chain(undefined),
  },
}));
vi.mock("../../db/schema", () => ({ integrationSecret: {} }));

import {
  decrypt,
  encrypt,
  getSecret,
  isSecretsConfigured,
  resolveVaultSecrets,
  setSecret,
} from "../secrets.js"; // NOTE: `.js` extension — this package's TS imports use it (see sibling tests)

const KEY_A = Buffer.alloc(32, 1).toString("hex"); // obviously-fake 32-byte key
const KEY_B = Buffer.alloc(32, 2).toString("hex"); // different obviously-fake key

/** Base64-decode, flip one byte, re-encode — used to corrupt a ciphertext/tag/iv field. */
function flipByte(base64: string): string {
  const buf = Buffer.from(base64, "base64");
  buf[0] = (buf[0] ?? 0) ^ 0xff;
  return buf.toString("base64");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  h.state.selectRows = [];
  h.state.inserted = [];
});

describe("crypto layer", () => {
  beforeEach(() => {
    vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_A);
  });

  describe("round-trip", () => {
    it.each([
      ["empty string", ""],
      ["unicode", "café ☕ 日本語"],
      ["long value", "x".repeat(10_000)],
    ])("decrypts what encrypt produced (%s)", (_label, plaintext) => {
      const { ciphertext, iv, tag } = encrypt(plaintext);
      expect(decrypt(ciphertext, iv, tag)).toBe(plaintext);
    });
  });

  it("uses a fresh IV and ciphertext per encryption of the same plaintext", () => {
    const plaintext = "same-value";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decrypt(a.ciphertext, a.iv, a.tag)).toBe(plaintext);
    expect(decrypt(b.ciphertext, b.iv, b.tag)).toBe(plaintext);
  });

  describe("tamper rejection", () => {
    it("throws when the ciphertext is corrupted", () => {
      const { ciphertext, iv, tag } = encrypt("secret-value");
      expect(() => decrypt(flipByte(ciphertext), iv, tag)).toThrow();
    });

    it("throws when the auth tag is corrupted", () => {
      const { ciphertext, iv, tag } = encrypt("secret-value");
      expect(() => decrypt(ciphertext, iv, flipByte(tag))).toThrow();
    });

    it("throws when the IV is corrupted", () => {
      const { ciphertext, iv, tag } = encrypt("secret-value");
      expect(() => decrypt(ciphertext, flipByte(iv), tag)).toThrow();
    });
  });

  it("throws when decrypting with the wrong key", () => {
    const { ciphertext, iv, tag } = encrypt("secret-value");
    vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_B);
    expect(() => decrypt(ciphertext, iv, tag)).toThrow();
  });

  describe("isSecretsConfigured", () => {
    it("returns true for a valid 64-hex-char (32-byte) key", () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_A);
      expect(isSecretsConfigured()).toBe(true);
    });

    it("returns false for a too-short key", () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(16, 1).toString("hex"));
      expect(isSecretsConfigured()).toBe(false);
    });

    it("returns false when the key is unset", () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", undefined);
      expect(isSecretsConfigured()).toBe(false);
    });
  });
});

describe("service layer swallow behavior", () => {
  beforeEach(() => {
    vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_A);
  });

  describe("getSecret", () => {
    it("returns the decrypted value on the happy path", async () => {
      const { ciphertext, iv, tag } = encrypt("plaintext-value");
      h.state.selectRows = [{ ciphertext, iv, tag }];
      await expect(getSecret("int", "k")).resolves.toBe("plaintext-value");
    });

    it("swallows a tampered ciphertext and resolves to null", async () => {
      const { ciphertext, iv, tag } = encrypt("plaintext-value");
      const bad = flipByte(ciphertext);
      // Crypto layer: the corrupted row throws when decrypted directly.
      expect(() => decrypt(bad, iv, tag)).toThrow();
      // Service layer: the same corruption is swallowed to null, not thrown.
      h.state.selectRows = [{ ciphertext: bad, iv, tag }];
      await expect(getSecret("int", "k")).resolves.toBeNull();
    });

    it("swallows a wrong-key row and resolves to null", async () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_B);
      const { ciphertext, iv, tag } = encrypt("plaintext-value");
      vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_A);
      h.state.selectRows = [{ ciphertext, iv, tag }];
      await expect(getSecret("int", "k")).resolves.toBeNull();
    });

    it("returns null when no row exists", async () => {
      h.state.selectRows = [];
      await expect(getSecret("int", "k")).resolves.toBeNull();
    });
  });

  describe("resolveVaultSecrets", () => {
    it("omits an undecryptable key but keeps the rest", async () => {
      const good = encrypt("v1");
      const bad = encrypt("v2");
      h.state.selectRows = [
        { key: "good", ciphertext: good.ciphertext, iv: good.iv, tag: good.tag },
        { key: "bad", ciphertext: flipByte(bad.ciphertext), iv: bad.iv, tag: bad.tag },
      ];
      await expect(resolveVaultSecrets("int")).resolves.toEqual({ good: "v1" });
    });

    it("early-returns {} when the key is unconfigured", async () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", undefined);
      h.state.selectRows = [{ key: "any", ciphertext: "x", iv: "y", tag: "z" }];
      await expect(resolveVaultSecrets("int")).resolves.toEqual({});
    });
  });
});

describe("setSecret", () => {
  beforeEach(() => {
    vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_A);
  });

  it("writes a fresh IV/ciphertext per call and each row decrypts to its own value", async () => {
    await setSecret("int", "k", "first");
    await setSecret("int", "k", "second");

    expect(h.state.inserted).toHaveLength(2);
    const [first, second] = h.state.inserted as [Record<string, unknown>, Record<string, unknown>];

    expect(String(first.iv)).not.toBe(String(second.iv));
    expect(String(first.ciphertext)).not.toBe(String(second.ciphertext));

    expect(decrypt(String(first.ciphertext), String(first.iv), String(first.tag))).toBe("first");
    expect(decrypt(String(second.ciphertext), String(second.iv), String(second.tag))).toBe(
      "second",
    );
  });
});
