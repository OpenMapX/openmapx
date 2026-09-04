import { chmodSync, linkSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  loadMasterKeyRing,
  loadMasterKeyRingAsync,
  makeAad,
  masterKeyRingConfigurationMatches,
  masterKeyRingMetadata,
  unwrapDataKey,
  wrapDataKey,
} from "./crypto.js";

describe("privacy crypto", () => {
  const ring = {
    activeVersion: 7,
    activeKey: Buffer.alloc(32, 0x11),
    keys: new Map([[7, Buffer.alloc(32, 0x11)]]),
  };

  it("encrypts and authenticates a domain-separated envelope", () => {
    const aad = makeAad({
      deploymentId: "dev",
      requestId: "r",
      blobId: "b",
      purpose: "request-locator",
    });
    const envelope = encryptEnvelope(Buffer.from("secret"), ring, "request-locator", aad);
    expect(envelope.cipherVersion).toBe(1);
    expect(decryptEnvelope(envelope, ring, "request-locator", aad).toString()).toBe("secret");
    expect(() => decryptEnvelope(envelope, ring, "protected-note", aad)).toThrow();
    expect(() => decryptEnvelope(envelope, ring, "request-locator", `${aad}:changed`)).toThrow();
  });

  it("wraps a random DEK under the versioned master key", () => {
    const dek = Buffer.alloc(32, 0x42);
    const wrapped = wrapDataKey(dek, ring, "export-artifact", "request-id");
    expect(unwrapDataKey(wrapped, ring, "export-artifact", "request-id")).toEqual(dek);
    expect(() => unwrapDataKey(wrapped, ring, "attachment", "request-id")).toThrow();
  });

  it("only accepts a canonical 32-byte key from a file or development env", () => {
    const encoded = Buffer.alloc(32, 0x19).toString("base64url");
    expect(
      loadMasterKeyRing({
        env: { OPENMAPX_EXPORTS_KEY: encoded, NODE_ENV: "development" },
        readFile: async () => encoded,
      }).activeKey.equals(Buffer.alloc(32, 0x19)),
    ).toBe(true);
    expect(() =>
      loadMasterKeyRing({
        env: { OPENMAPX_EXPORTS_KEY: encoded, NODE_ENV: "production" },
        readFile: async () => encoded,
      }),
    ).toThrow();
  });

  it("loads a bounded versioned ring, reads old ciphertext, and writes with the active key", async () => {
    const oldKey = Buffer.alloc(32, 0x31);
    const newKey = Buffer.alloc(32, 0x32);
    const oldRing = {
      activeVersion: 3,
      activeKey: oldKey,
      keys: new Map([[3, oldKey]]),
    };
    const aad = makeAad({
      deploymentId: "test",
      requestId: "request",
      blobId: "locator",
      purpose: "request-locator",
    });
    const oldEnvelope = encryptEnvelope(
      Buffer.from("persisted locator"),
      oldRing,
      "request-locator",
      aad,
    );
    const oldWrappedDek = wrapDataKey(
      Buffer.alloc(32, 0x55),
      oldRing,
      "export-artifact",
      "artifact-context",
    );
    const persisted = JSON.stringify({
      formatVersion: 1,
      activeVersion: 4,
      keys: [
        { version: 3, key: oldKey.toString("base64url") },
        { version: 4, key: newKey.toString("base64url") },
      ],
    });

    const overlapRing = await loadMasterKeyRingAsync({
      env: { NODE_ENV: "production", OPENMAPX_EXPORTS_KEY_FILE: "/managed/exports-key" },
      readFile: async () => persisted,
    });

    expect(masterKeyRingMetadata(overlapRing)).toEqual({
      activeVersion: 4,
      availableVersions: [3, 4],
    });
    expect(decryptEnvelope(oldEnvelope, overlapRing, "request-locator", aad).toString("utf8")).toBe(
      "persisted locator",
    );
    expect(
      unwrapDataKey(oldWrappedDek, overlapRing, "export-artifact", "artifact-context"),
    ).toEqual(Buffer.alloc(32, 0x55));

    const newEnvelope = encryptEnvelope(
      Buffer.from("new locator"),
      overlapRing,
      "request-locator",
      aad,
    );
    const newWrappedDek = wrapDataKey(
      Buffer.alloc(32, 0x56),
      overlapRing,
      "export-artifact",
      "artifact-context",
    );
    expect(newEnvelope.masterKeyVersion).toBe(4);
    expect(newWrappedDek.masterKeyVersion).toBe(4);

    const newOnlyRing = {
      activeVersion: 4,
      activeKey: newKey,
      keys: new Map([[4, newKey]]),
    };
    expect(() => decryptEnvelope(oldEnvelope, newOnlyRing, "request-locator", aad)).toThrow(
      /key version is unavailable/,
    );
    expect(() =>
      unwrapDataKey(oldWrappedDek, newOnlyRing, "export-artifact", "artifact-context"),
    ).toThrow(/master version is unavailable/);
  });

  it("rejects malformed, ambiguous, unsupported, or oversized persisted rings without echoing keys", async () => {
    const secret = Buffer.alloc(32, 0x41).toString("base64url");
    const load = (contents: string) =>
      loadMasterKeyRingAsync({
        env: { NODE_ENV: "production", OPENMAPX_EXPORTS_KEY_FILE: "/managed/exports-key" },
        readFile: async () => contents,
      });
    const invalid = [
      "{}",
      JSON.stringify({ formatVersion: 2, activeVersion: 1, keys: [{ version: 1, key: secret }] }),
      JSON.stringify({
        formatVersion: 1,
        activeVersion: 2,
        keys: [{ version: 1, key: secret }],
      }),
      JSON.stringify({
        formatVersion: 1,
        activeVersion: 1,
        keys: [
          { version: 1, key: secret },
          { version: 1, key: Buffer.alloc(32, 0x42).toString("base64url") },
        ],
      }),
      JSON.stringify({
        formatVersion: 1,
        activeVersion: 1,
        keys: Array.from({ length: 9 }, (_, index) => ({ version: index + 1, key: secret })),
      }),
      JSON.stringify({
        formatVersion: 1,
        activeVersion: 1,
        keys: [{ version: 1, key: `${secret}=` }],
      }),
      JSON.stringify({
        formatVersion: 1,
        activeVersion: 1,
        keys: [{ version: 1, key: secret }],
        fallbackKey: secret,
      }),
      "x".repeat(2_049),
    ];

    for (const contents of invalid) {
      const error = await load(contents).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("loads a managed key through a descriptor and enforces file boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-privacy-key-"));
    const path = join(root, "subject-exports-master-key");
    const encoded = Buffer.alloc(32, 0x27).toString("base64url");
    writeFileSync(path, encoded, { mode: 0o400 });
    const uid = process.getuid?.();
    const ring = await loadMasterKeyRingAsync({
      env: {
        NODE_ENV: "production",
        OPENMAPX_EXPORTS_KEY_FILE: path,
        ...(uid === undefined ? {} : { OPENMAPX_EXPORTS_KEY_UID: String(uid) }),
      },
    });
    expect(ring.activeKey).toEqual(Buffer.alloc(32, 0x27));

    for (const mode of [0o440, 0o444, 0o600]) {
      chmodSync(path, mode);
      await expect(
        loadMasterKeyRingAsync({
          env: { NODE_ENV: "production", OPENMAPX_EXPORTS_KEY_FILE: path },
        }),
      ).rejects.toThrow(/permissions/);
    }

    chmodSync(path, 0o600);
    writeFileSync(path, `${encoded}\n`);
    chmodSync(path, 0o400);
    await expect(
      loadMasterKeyRingAsync({
        env: { NODE_ENV: "production", OPENMAPX_EXPORTS_KEY_FILE: path },
      }),
    ).rejects.toThrow(/invalid/);

    chmodSync(path, 0o600);
    writeFileSync(path, "x".repeat(2_049));
    chmodSync(path, 0o400);
    await expect(
      loadMasterKeyRingAsync({
        env: { NODE_ENV: "production", OPENMAPX_EXPORTS_KEY_FILE: path },
      }),
    ).rejects.toThrow(/size limit/);
  });

  it("rejects a managed key file that changes while its descriptor is read", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-privacy-key-change-"));
    const path = join(root, "subject-exports-master-key");
    const encoded = Buffer.alloc(32, 0x29).toString("base64url");
    writeFileSync(path, encoded, { mode: 0o400 });

    await expect(
      loadMasterKeyRingAsync({
        env: { NODE_ENV: "production", OPENMAPX_EXPORTS_KEY_FILE: path },
        fileReadHooks: {
          afterRead: () => {
            chmodSync(path, 0o600);
            writeFileSync(path, Buffer.alloc(32, 0x2a).toString("base64url"));
            chmodSync(path, 0o400);
          },
        },
      }),
    ).rejects.toThrow(/changed while it was read/);
  });

  it("detects managed ring replacement against the exact in-memory startup ring", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-privacy-key-health-"));
    const path = join(root, "subject-exports-master-key");
    const oldKey = Buffer.alloc(32, 0x35).toString("base64url");
    const newKey = Buffer.alloc(32, 0x36).toString("base64url");
    writeFileSync(path, oldKey, { mode: 0o400 });
    const env = { NODE_ENV: "production", OPENMAPX_EXPORTS_KEY_FILE: path };
    const startupRing = await loadMasterKeyRingAsync({ env });
    expect(await masterKeyRingConfigurationMatches(startupRing, { env })).toBe(true);

    chmodSync(path, 0o600);
    writeFileSync(
      path,
      JSON.stringify({
        formatVersion: 1,
        activeVersion: 2,
        keys: [
          { version: 1, key: oldKey },
          { version: 2, key: newKey },
        ],
      }),
    );
    chmodSync(path, 0o400);
    expect(await masterKeyRingConfigurationMatches(startupRing, { env })).toBe(false);
    const replacementRing = await loadMasterKeyRingAsync({ env });
    expect(await masterKeyRingConfigurationMatches(replacementRing, { env })).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o400);

    chmodSync(path, 0o444);
    expect(await masterKeyRingConfigurationMatches(replacementRing, { env })).toBe(false);
  });

  it("rejects symlinked and hardlinked managed key files", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-privacy-key-links-"));
    const encoded = Buffer.alloc(32, 0x28).toString("base64url");
    const real = join(root, "real");
    const symlink = join(root, "symlink");
    writeFileSync(real, encoded, { mode: 0o400 });
    symlinkSync(real, symlink);
    await expect(
      loadMasterKeyRingAsync({
        env: { NODE_ENV: "production", OPENMAPX_EXPORTS_KEY_FILE: symlink },
      }),
    ).rejects.toThrow(/unavailable/);

    const hardlink = join(root, "hardlink");
    linkSync(real, hardlink);
    await expect(
      loadMasterKeyRingAsync({
        env: { NODE_ENV: "production", OPENMAPX_EXPORTS_KEY_FILE: hardlink },
      }),
    ).rejects.toThrow(/single regular file/);
  });
});
