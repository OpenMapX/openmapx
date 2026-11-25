import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  secretAad,
  secretsKeyProblem,
  setSecret,
} from "../secrets.js"; // NOTE: `.js` extension — this package's TS imports use it (see sibling tests)

const AAD = secretAad.integrationSecret("int", "k");

const KEY_A = Buffer.alloc(32, 1).toString("base64url"); // obviously-fake 32-byte key
const KEY_B = Buffer.alloc(32, 2).toString("base64url"); // different obviously-fake key

/** Base64-decode, flip one byte, re-encode — used to corrupt a ciphertext/tag/iv field. */
function flipByte(base64: string): string {
  const buf = Buffer.from(base64, "base64");
  buf[0] = (buf[0] ?? 0) ^ 0xff;
  return buf.toString("base64");
}

beforeEach(() => {
  h.state.selectRows = [];
  h.state.inserted = [];
});

afterEach(() => vi.unstubAllEnvs());

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
      const sealed = encrypt(plaintext, AAD);
      expect(sealed.keyVersion).toBe(1);
      expect(decrypt(sealed, AAD)).toBe(plaintext);
    });
  });

  it("uses a fresh IV and ciphertext per encryption of the same plaintext", () => {
    const plaintext = "same-value";
    const a = encrypt(plaintext, AAD);
    const b = encrypt(plaintext, AAD);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decrypt(a, AAD)).toBe(plaintext);
    expect(decrypt(b, AAD)).toBe(plaintext);
  });

  describe("tamper rejection", () => {
    it("throws when the ciphertext is corrupted", () => {
      const sealed = encrypt("secret-value", AAD);
      expect(() => decrypt({ ...sealed, ciphertext: flipByte(sealed.ciphertext) }, AAD)).toThrow();
    });

    it("throws when the auth tag is corrupted", () => {
      const sealed = encrypt("secret-value", AAD);
      expect(() => decrypt({ ...sealed, tag: flipByte(sealed.tag) }, AAD)).toThrow();
    });

    it("throws when the IV is corrupted", () => {
      const sealed = encrypt("secret-value", AAD);
      expect(() => decrypt({ ...sealed, iv: flipByte(sealed.iv) }, AAD)).toThrow();
    });
  });

  describe("row binding", () => {
    it("refuses a ciphertext moved to another row of the same table", () => {
      const sealed = encrypt("smtp-password", secretAad.systemSecret("smtp.password"));
      expect(() => decrypt(sealed, secretAad.systemSecret("maptiler.apiKey"))).toThrow(
        /cannot be decrypted with the configured secrets key/,
      );
    });

    it("refuses a ciphertext moved into another table", () => {
      const sealed = encrypt("smtp-password", secretAad.systemSecret("smtp.password"));
      expect(() => decrypt(sealed, secretAad.integrationSecret("weather", "apiKey"))).toThrow(
        /cannot be decrypted with the configured secrets key/,
      );
      const vault = encrypt("vault", secretAad.integrationSecret("weather", "apiKey"));
      expect(() => decrypt(vault, secretAad.serviceSecret("weather", "apiKey"))).toThrow();
      expect(() => decrypt(vault, secretAad.integrationSecret("weather", "token"))).toThrow();
    });
  });

  it("refuses an unknown key version", () => {
    const sealed = encrypt("secret-value", AAD);
    expect(() => decrypt({ ...sealed, keyVersion: 2 }, AAD)).toThrow(
      /cannot be decrypted with the configured secrets key/,
    );
    expect(() => decrypt({ ...sealed, keyVersion: 0 }, AAD)).toThrow();
  });

  it("throws when decrypting with the wrong key", () => {
    const sealed = encrypt("secret-value", AAD);
    vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_B);
    expect(() => decrypt(sealed, AAD)).toThrow();
  });

  it("refuses a truncated tag or an IV of another length before decrypting", () => {
    const sealed = encrypt("secret-value", AAD);
    const truncated = Buffer.from(sealed.tag, "base64").subarray(0, 4).toString("base64");
    expect(() => decrypt({ ...sealed, tag: truncated }, AAD)).toThrow(
      /cannot be decrypted with the configured secrets key/,
    );
    const longIv = Buffer.concat([Buffer.from(sealed.iv, "base64"), Buffer.alloc(4)]).toString(
      "base64",
    );
    expect(() => decrypt({ ...sealed, iv: longIv }, AAD)).toThrow(
      /cannot be decrypted with the configured secrets key/,
    );
  });

  it("names the key mismatch when decryption fails", () => {
    const sealed = encrypt("secret-value", AAD);
    vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_B);
    expect(() => decrypt(sealed, AAD)).toThrow(
      /cannot be decrypted with the configured secrets key/,
    );
  });

  describe("isSecretsConfigured", () => {
    it("returns true for a canonical base64url 32-byte key", () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_A);
      expect(isSecretsConfigured()).toBe(true);
    });

    it("returns false for a too-short key", () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(16, 1).toString("base64url"));
      expect(isSecretsConfigured()).toBe(false);
    });

    it("refuses the former 64-character hex format", () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(32, 1).toString("hex"));
      expect(isSecretsConfigured()).toBe(false);
      expect(() => encrypt("x", AAD)).toThrow(/64-character hex format is not accepted/);
    });

    it("returns false when the key is unset", () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", undefined);
      expect(isSecretsConfigured()).toBe(false);
      expect(() => encrypt("x", AAD)).toThrow(/run `pnpm openmapx compose render`/);
    });

    it("reads the key from the file OPENMAPX_SECRETS_KEY_FILE names", () => {
      const directory = mkdtempSync(join(tmpdir(), "openmapx-secrets-key-"));
      try {
        const path = join(directory, "secrets-key");
        writeFileSync(path, KEY_A, { mode: 0o444 });
        vi.stubEnv("OPENMAPX_SECRETS_KEY", undefined);
        vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", path);
        const sealed = encrypt("from-file", AAD);
        vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", undefined);
        vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_A);
        expect(decrypt(sealed, AAD)).toBe("from-file");
        vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", path);
        expect(isSecretsConfigured()).toBe(false);

        // The render's rule exactly: no trailing newline, mode 0444, no symlink.
        vi.stubEnv("OPENMAPX_SECRETS_KEY", undefined);
        const newline = join(directory, "newline-key");
        writeFileSync(newline, `${KEY_B}\n`, { mode: 0o444 });
        vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", newline);
        expect(() => encrypt("x", AAD)).toThrow(/invalid size/);
        const link = join(directory, "link-key");
        symlinkSync(path, link);
        vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", link);
        expect(() => encrypt("x", AAD)).toThrow(/must be a regular file/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  describe("secretsKeyProblem", () => {
    it("is null for a usable key", () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_A);
      expect(secretsKeyProblem()).toBeNull();
    });

    it("names a missing key and how to generate it", () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", undefined);
      vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", undefined);
      expect(secretsKeyProblem()).toMatch(/not configured.*pnpm openmapx compose render/);
    });

    it("names both variables when both are set", () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_A);
      vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", "/synthetic/secrets-key");
      expect(secretsKeyProblem()).toMatch(
        /Set either OPENMAPX_SECRETS_KEY_FILE or OPENMAPX_SECRETS_KEY, not both/,
      );
    });

    it("names a malformed variable without repeating its value", () => {
      const short = Buffer.alloc(16, 7).toString("base64url");
      vi.stubEnv("OPENMAPX_SECRETS_KEY", short);
      const problem = secretsKeyProblem();
      expect(problem).toMatch(/^OPENMAPX_SECRETS_KEY must hold 32 random bytes/);
      expect(problem).not.toContain(short);
    });

    it("names the file rule that failed without its contents", () => {
      const directory = mkdtempSync(join(tmpdir(), "openmapx-secrets-key-problem-"));
      try {
        vi.stubEnv("OPENMAPX_SECRETS_KEY", undefined);
        const loose = join(directory, "loose-key");
        writeFileSync(loose, KEY_B, { mode: 0o600 });
        vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", loose);
        const mode = secretsKeyProblem();
        expect(mode).toMatch(/^Secrets key file must have mode 0444 \(OPENMAPX_SECRETS_KEY_FILE\)/);
        expect(mode).not.toContain(KEY_B);

        const owned = join(directory, "owned-key");
        writeFileSync(owned, KEY_B, { mode: 0o444 });
        vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", owned);
        vi.stubEnv("OPENMAPX_SECRETS_KEY_UID", String((process.getuid?.() ?? 0) + 1));
        expect(secretsKeyProblem()).toMatch(/^Secrets key file has an invalid owner/);

        vi.stubEnv("OPENMAPX_SECRETS_KEY_UID", undefined);
        vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", join(directory, "absent-key"));
        expect(secretsKeyProblem()).toMatch(
          /^Secrets key file is missing or unreadable.*pnpm openmapx compose render/,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});

describe("service layer swallow behavior", () => {
  beforeEach(() => {
    vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_A);
  });

  describe("getSecret", () => {
    it("returns the decrypted value on the happy path", async () => {
      h.state.selectRows = [encrypt("plaintext-value", AAD)];
      await expect(getSecret("int", "k")).resolves.toBe("plaintext-value");
    });

    it("swallows a tampered ciphertext and resolves to null", async () => {
      const sealed = encrypt("plaintext-value", AAD);
      const bad = { ...sealed, ciphertext: flipByte(sealed.ciphertext) };
      // Crypto layer: the corrupted row throws when decrypted directly.
      expect(() => decrypt(bad, AAD)).toThrow();
      // Service layer: the same corruption is swallowed to null, not thrown.
      h.state.selectRows = [bad];
      await expect(getSecret("int", "k")).resolves.toBeNull();
    });

    it("refuses a value sealed for another integration's row", async () => {
      h.state.selectRows = [encrypt("plaintext-value", secretAad.integrationSecret("other", "k"))];
      await expect(getSecret("int", "k")).resolves.toBeNull();
    });

    it("swallows a wrong-key row and resolves to null", async () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_B);
      const sealed = encrypt("plaintext-value", AAD);
      vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY_A);
      h.state.selectRows = [sealed];
      await expect(getSecret("int", "k")).resolves.toBeNull();
    });

    it("returns null when no row exists", async () => {
      h.state.selectRows = [];
      await expect(getSecret("int", "k")).resolves.toBeNull();
    });
  });

  describe("resolveVaultSecrets", () => {
    it("omits an undecryptable key but keeps the rest", async () => {
      const good = encrypt("v1", secretAad.integrationSecret("int", "good"));
      const bad = encrypt("v2", secretAad.integrationSecret("int", "bad"));
      const moved = encrypt("v3", secretAad.integrationSecret("int", "good"));
      h.state.selectRows = [
        { key: "good", ...good },
        { key: "bad", ...bad, ciphertext: flipByte(bad.ciphertext) },
        { key: "moved", ...moved },
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

    expect(first.keyVersion).toBe(1);
    expect(decrypt(first as never, AAD)).toBe("first");
    expect(decrypt(second as never, AAD)).toBe("second");
  });
});
