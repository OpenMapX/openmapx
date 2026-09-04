import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { startArtifactStream } from "./artifact-download.js";
import { EncryptedBlobStore } from "./artifact-storage.js";
import { loadMasterKeyRing } from "./crypto.js";

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "openmapx-export-test-"));
  const ring = loadMasterKeyRing({
    env: {
      NODE_ENV: "development",
      OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 3).toString("base64url"),
    },
  });
  return { root, ring };
}

describe("EncryptedBlobStore", () => {
  it("probes private writable storage and encryption without leaving an object", async () => {
    const { root, ring } = await storeFixture();
    const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
    expect(await store.probeHealth()).toBe(true);
    expect(await readdir(root, { recursive: true })).toEqual(["health"]);
  });

  it("writes only ciphertext and decrypts a streamed source", async () => {
    const { root, ring } = await storeFixture();
    const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
    const source = Readable.from([Buffer.from("alpha"), Buffer.from("-"), Buffer.from("beta")]);
    const result = await store.write({
      requestId: "request-1",
      blobId: "blob-1",
      purpose: "export-artifact",
      storageKey: "objects/blob-1.bin",
      source,
    });
    expect(result.plaintextBytes).toBe(10);
    expect(result.ciphertextBytes).toBe(10);
    expect((await readFile(result.path)).toString()).not.toContain("alpha");
    const chunks: Buffer[] = [];
    await store.decryptTo(result, async (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    expect(Buffer.concat(chunks).toString()).toBe("alpha-beta");
    expect((await stat(result.path)).mode & 0o777).toBe(0o400);
  });

  it("rejects path traversal and replacement links", async () => {
    const { root, ring } = await storeFixture();
    const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
    await expect(
      store.write({
        requestId: "r",
        blobId: "b",
        purpose: "attachment",
        storageKey: "../x",
        source: Buffer.from("x"),
      }),
    ).rejects.toThrow("storage key");
    const outside = join(root, "outside");
    await writeFile(outside, "x");
    await symlink(outside, join(root, "link")).catch(() => {});
    await expect(store.assertSafePath("link")).rejects.toThrow();
    const hard = join(root, "hard");
    await link(outside, hard);
    await expect(store.assertSafePath("hard")).rejects.toThrow();

    const parentTarget = join(root, "parent-target");
    await mkdir(parentTarget);
    await writeFile(join(parentTarget, "placeholder"), "x");
    await symlink(parentTarget, join(root, "objects"));
    await expect(
      store.write({
        requestId: "r2",
        blobId: "b2",
        purpose: "attachment",
        storageKey: "objects/blob.bin",
        source: Buffer.from("x"),
      }),
    ).rejects.toThrow();
  });
  it("publishes exactly one object when independent stores race on a key", async () => {
    const { root, ring } = await storeFixture();
    const stores = [0, 1].map(() => new EncryptedBlobStore({ root, ring, deploymentId: "test" }));
    const results = await Promise.allSettled(
      stores.map((store, index) =>
        store.write({
          requestId: "r",
          blobId: `b-${index}`,
          purpose: "export-artifact",
          storageKey: "objects/shared.bin",
          source: Buffer.from(`value-${index}`),
        }),
      ),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    if (winners[0].status === "fulfilled") await stores[0].verify(winners[0].value);
  });

  it("releases the delivery lock when an unconsumed stream is canceled", async () => {
    const { root, ring } = await storeFixture();
    const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
    const artifact = await store.write({
      requestId: "r",
      blobId: "b",
      purpose: "export-artifact",
      storageKey: "objects/cancel.bin",
      source: Buffer.alloc(1024 * 1024),
    });
    const prepared = startArtifactStream(store, artifact);
    await prepared.verified;
    prepared.stream.destroy();
    await store.delete(artifact.storageKey);
    await expect(readFile(artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
