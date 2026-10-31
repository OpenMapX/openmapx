import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeterministicTarGz } from "../deterministic-tar";
import { installIntegration } from "../installer";

const calls = vi.hoisted(() => ({
  watched: "",
  wholeReads: 0,
  removeFault: "",
  unlinkFault: false,
}));
vi.mock("node:fs", async (actual) => {
  const fs = await actual<typeof import("node:fs")>();
  return {
    ...fs,
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      if (calls.removeFault && String(args[0]).endsWith(calls.removeFault)) {
        calls.removeFault = "";
        throw new Error("named private cleanup failure");
      }
      return Reflect.apply(fs.rmSync, fs, args);
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      const result = Reflect.apply(fs.unlinkSync, fs, args);
      if (calls.unlinkFault && String(args[0]).endsWith("/owner.json")) {
        calls.unlinkFault = false;
        throw new Error("named owner unlink acknowledgement loss");
      }
      return result;
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === calls.watched) calls.wholeReads++;
      return Reflect.apply(fs.readFileSync, fs, args);
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  calls.watched = "";
  calls.wholeReads = 0;
  calls.removeFault = "";
  calls.unlinkFault = false;
});
it("installs a valid existing artifact without whole-file archive reads or gzip allocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "openmapx-integration-stream-"));
  roots.push(root);
  mkdirSync(join(root, "services"));
  const archive = join(root, "public.tar.gz");
  const manifest = {
    id: "stream-fixture",
    name: "Stream fixture",
    version: "1.0.0",
    platform: "1.0",
    quality: "community",
    domains: ["map-overlay"],
  };
  const bytes = createDeterministicTarGz([
    { path: "manifest.json", contents: Buffer.from(JSON.stringify(manifest)) },
  ]);
  writeFileSync(archive, bytes);
  calls.watched = archive;
  const result = await installIntegration({
    rootDir: root,
    source: archive,
    sourceKind: "artifact",
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(result.id).toBe(manifest.id);
  expect(JSON.parse(readFileSync(join(result.directory, "manifest.json"), "utf8"))).toEqual(
    manifest,
  );
  expect(calls.wholeReads).toBe(0);
});
it("returns ownership of an unopened byte source when cancellation precedes extraction", async () => {
  const { extractIntegrationArtifactStream } = await import("../artifact-stream");
  const root = mkdtempSync(join(tmpdir(), "openmapx-integration-abort-"));
  roots.push(root);
  let returned = false,
    pulled = 0;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        pulled++;
        return { done: true, value: undefined };
      },
      return: async () => {
        returned = true;
        return { done: true, value: undefined };
      },
    }),
  };
  const abort = new AbortController();
  abort.abort();
  await expect(
    extractIntegrationArtifactStream({
      source,
      destination: root,
      maxArtifactBytes: 100,
      maxExpandedBytes: 100,
      signal: abort.signal,
    }),
  ).rejects.toBeDefined();
  expect(pulled).toBe(0);
  expect(returned).toBe(true);
});
it("prepares immutable bytes without publishing and refuses a changed retained preparation", async () => {
  const installer = await import("../installer");
  const root = mkdtempSync(join(tmpdir(), "openmapx-integration-prepare-"));
  roots.push(root);
  mkdirSync(join(root, "services"));
  const bytes = createDeterministicTarGz([
    {
      path: "manifest.json",
      contents: Buffer.from(
        JSON.stringify({
          id: "prepared-fixture",
          name: "Prepared",
          version: "1.0.0",
          platform: "1.0",
          quality: "community",
          domains: ["map-overlay"],
        }),
      ),
    },
  ]);
  const context = installer.createIntegrationArtifactPreparation({ rootDir: root });
  const prepared = await installer.prepareIntegrationArtifact(
    {
      source: (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 17)
          yield bytes.subarray(offset, offset + 17);
      })(),
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      maxArtifactBytes: 200 * 1024 ** 2,
      maxExpandedBytes: 200 * 1024 ** 2,
      signal: new AbortController().signal,
    },
    context,
  );
  expect(prepared.id).toBe("prepared-fixture");
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(root, "custom_integrations", "prepared-fixture"))).toBe(false);
  const receipt = installer.describePreparedIntegration(prepared);
  const restored = await installer.restorePreparedIntegration({
    rootDir: root,
    receipt,
    signal: new AbortController().signal,
  });
  expect(restored.contentDigest).toBe(prepared.contentDigest);
  writeFileSync(
    join(
      root,
      "custom_integrations",
      ".staging",
      `preparation-${receipt.preparationId}`,
      "content",
      "manifest.json",
    ),
    "{}",
  );
  await expect(
    installer.restorePreparedIntegration({
      rootDir: root,
      receipt,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  installer.discardIntegrationPreparation(context);
});
it("holds a shared component lock across publication and permits only exact-owner restoration", async () => {
  const installer = await import("../installer");
  const root = mkdtempSync(join(tmpdir(), "openmapx-integration-publish-"));
  roots.push(root);
  mkdirSync(join(root, "services"));
  const manifest = {
    id: "transaction-fixture",
    name: "Transaction",
    version: "1.0.0",
    platform: "1.0",
    quality: "community",
    domains: ["map-overlay"],
  };
  const bytes = createDeterministicTarGz([
    { path: "manifest.json", contents: Buffer.from(JSON.stringify(manifest)) },
  ]);
  const context = installer.createIntegrationArtifactPreparation({ rootDir: root });
  const prepared = await installer.prepareIntegrationArtifact(
    {
      source: (async function* () {
        yield bytes;
      })(),
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      maxArtifactBytes: 200 * 1024 ** 2,
      maxExpandedBytes: 200 * 1024 ** 2,
      signal: new AbortController().signal,
    },
    context,
  );
  const transaction = await installer.publishPreparedIntegration(prepared, {
    transactionId: "91a78b3e-208b-4ba4-9ddf-870fbdf1da22",
    expectedPreviousContentDigest: null,
    signal: new AbortController().signal,
  });
  expect(installer.describeIntegrationPublication(transaction)).toMatchObject({
    integrationId: manifest.id,
    outcome: "published",
    preparation: { contentDigest: prepared.contentDigest },
  });
  expect(() => installer.removeIntegration({ rootDir: root, id: manifest.id })).toThrow(/busy/);
  const saved = installer.describeIntegrationPublication(transaction);
  const recovered = await installer.restoreIntegrationPublication({
    rootDir: root,
    receipt: saved,
    signal: new AbortController().signal,
  });
  await installer.settleIntegrationPublication(recovered, "restore", new AbortController().signal);
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(root, "custom_integrations", manifest.id))).toBe(false);
  expect(() => installer.removeIntegration({ rootDir: root, id: manifest.id })).toThrow(
    /not installed/,
  );
});

async function publicationFixture(version = "1.0.0", rootDir?: string) {
  const installer = await import("../installer");
  const root = rootDir ?? mkdtempSync(join(tmpdir(), "openmapx-integration-replacement-"));
  if (!rootDir) {
    roots.push(root);
    mkdirSync(join(root, "services"));
  }
  const manifest = {
    id: "replacement-fixture",
    name: "Replacement",
    version,
    platform: "1.0",
    quality: "community",
    domains: ["map-overlay"],
  };
  const bytes = createDeterministicTarGz([
    { path: "manifest.json", contents: Buffer.from(JSON.stringify(manifest)) },
  ]);
  const context = installer.createIntegrationArtifactPreparation({ rootDir: root });
  const prepared = await installer.prepareIntegrationArtifact(
    {
      source: (async function* () {
        yield bytes;
      })(),
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      maxArtifactBytes: 200 * 1024 ** 2,
      maxExpandedBytes: 200 * 1024 ** 2,
      signal: new AbortController().signal,
    },
    context,
  );
  const previous = installer.inspectInstalledIntegrationFingerprint({
    rootDir: root,
    id: manifest.id,
    signal: new AbortController().signal,
  });
  return { installer, root, prepared, previous, signal: new AbortController().signal };
}
it("replays a committed publication after restart without releasing a later writer's lock", async () => {
  const f = await publicationFixture();
  const publication = await f.installer.publishPreparedIntegration(f.prepared, {
    transactionId: "944c81db-75da-418a-aef8-f839174cf87f",
    expectedPreviousContentDigest: null,
    signal: f.signal,
  });
  const receipt = f.installer.describeIntegrationPublication(publication);
  await f.installer.settleIntegrationPublication(publication, "commit", f.signal);
  const later = f.installer.acquireIntegrationComponentLock({ rootDir: f.root, id: f.prepared.id });
  try {
    const recovered = await f.installer.restoreIntegrationPublication({
      rootDir: f.root,
      receipt,
      signal: f.signal,
    });
    expect(
      await f.installer.settleIntegrationPublication(recovered, "commit", f.signal),
    ).toMatchObject({ outcome: "committed", contentDigest: f.prepared.contentDigest });
    expect(() => f.installer.removeIntegration({ rootDir: f.root, id: f.prepared.id })).toThrow(
      /busy/,
    );
    await expect(
      f.installer.settleIntegrationPublication(recovered, "restore", f.signal),
    ).rejects.toThrow(/different decision/);
  } finally {
    f.installer.releaseIntegrationComponentLock(later);
  }
});
it("restores the exact prior directory on replacement and refuses changed published bytes", async () => {
  const first = await publicationFixture();
  const old = await first.installer.publishPreparedIntegration(first.prepared, {
    transactionId: "26ffcae8-e6d3-414d-bf09-a37162591a80",
    expectedPreviousContentDigest: null,
    signal: first.signal,
  });
  await first.installer.settleIntegrationPublication(old, "commit", first.signal);
  const next = await publicationFixture("2.0.0", first.root);
  const published = await next.installer.publishPreparedIntegration(next.prepared, {
    transactionId: "ff42f4ee-d8c9-4b4d-a94f-e5ced70e5356",
    expectedPreviousContentDigest: first.prepared.contentDigest,
    signal: next.signal,
  });
  const manifestPath = join(first.root, "custom_integrations", first.prepared.id, "manifest.json");
  const original = readFileSync(manifestPath);
  writeFileSync(manifestPath, "{}");
  await expect(
    next.installer.settleIntegrationPublication(published, "restore", next.signal),
  ).rejects.toThrow(/changed/);
  expect(() =>
    next.installer.removeIntegration({ rootDir: first.root, id: first.prepared.id }),
  ).toThrow(/busy/);
  writeFileSync(manifestPath, original);
  await next.installer.settleIntegrationPublication(published, "restore", next.signal);
  expect(
    next.installer.inspectInstalledIntegrationFingerprint({
      rootDir: first.root,
      id: first.prepared.id,
      signal: next.signal,
    }),
  ).toEqual(next.previous);
  const replay = await next.installer.restoreIntegrationPublication({
    rootDir: first.root,
    receipt: next.installer.describeIntegrationPublication(published),
    signal: next.signal,
  });
  expect(
    await next.installer.settleIntegrationPublication(replay, "restore", next.signal),
  ).toMatchObject({ outcome: "restored", contentDigest: first.prepared.contentDigest });
});

it("closes an unchanged pre-publication transaction when its retained callback fails", async () => {
  const f = await publicationFixture();
  const preparation = f.installer.describePreparedIntegration(f.prepared);
  await expect(
    f.installer.publishPreparedIntegration(f.prepared, {
      transactionId: "91b603d6-37d0-46c5-b3ed-5c1f72976fb8",
      expectedPreviousContentDigest: null,
      signal: f.signal,
      beforePublish: () => {
        throw Error("named retained checkpoint failure");
      },
    }),
  ).rejects.toThrow("named retained checkpoint failure");
  const receipt = f.installer.inspectIntegrationPublication({
    rootDir: f.root,
    preparation,
    transactionId: "91b603d6-37d0-46c5-b3ed-5c1f72976fb8",
  });
  expect(receipt.outcome).toBe("restored");
  const restored = await f.installer.restoreIntegrationPublication({
    rootDir: f.root,
    receipt,
    signal: f.signal,
  });
  expect(
    await f.installer.settleIntegrationPublication(restored, "restore", f.signal),
  ).toMatchObject({ outcome: "restored" });
});
it("retries only original private cleanup after a restored terminal was durably written", async () => {
  const f = await publicationFixture();
  const published = await f.installer.publishPreparedIntegration(f.prepared, {
    transactionId: "7cc570a9-17b6-4905-b0a2-2da4cbd5c2cf",
    expectedPreviousContentDigest: null,
    signal: f.signal,
  });
  calls.removeFault = "/rejected";
  await expect(
    f.installer.settleIntegrationPublication(published, "restore", f.signal),
  ).rejects.toThrow("named private cleanup failure");
  const receipt = f.installer.describeIntegrationPublication(published);
  expect(receipt.outcome).toBe("restored");
  const recovered = await f.installer.restoreIntegrationPublication({
    rootDir: f.root,
    receipt,
    signal: f.signal,
  });
  await f.installer.settleIntegrationPublication(recovered, "restore", f.signal);
  const { existsSync } = await import("node:fs");
  expect(
    existsSync(
      join(
        f.root,
        "custom_integrations/.staging",
        `preparation-${receipt.preparation.preparationId}`,
        "rejected",
      ),
    ),
  ).toBe(false);
});
it("finishes original empty lock removal after owner unlink acknowledgement loss", async () => {
  const f = await publicationFixture();
  const published = await f.installer.publishPreparedIntegration(f.prepared, {
    transactionId: "ac23034b-553c-4c01-97c4-a0b1c67bb029",
    expectedPreviousContentDigest: null,
    signal: f.signal,
  });
  calls.unlinkFault = true;
  await expect(
    f.installer.settleIntegrationPublication(published, "commit", f.signal),
  ).rejects.toThrow("named owner unlink acknowledgement loss");
  const receipt = f.installer.describeIntegrationPublication(published);
  expect(receipt.outcome).toBe("committed");
  const recovered = await f.installer.restoreIntegrationPublication({
    rootDir: f.root,
    receipt,
    signal: f.signal,
  });
  await f.installer.settleIntegrationPublication(recovered, "commit", f.signal);
  const later = f.installer.acquireIntegrationComponentLock({ rootDir: f.root, id: f.prepared.id });
  f.installer.releaseIntegrationComponentLock(later);
});
it("observes a committed publication without adopting a different owner on the retained inode", async () => {
  const f = await publicationFixture();
  const published = await f.installer.publishPreparedIntegration(f.prepared, {
    transactionId: "ac23034b-553c-4c01-97c4-a0b1c67bb029",
    expectedPreviousContentDigest: null,
    signal: f.signal,
  });
  calls.unlinkFault = true;
  await expect(
    f.installer.settleIntegrationPublication(published, "commit", f.signal),
  ).rejects.toThrow("named owner unlink acknowledgement loss");
  const ownerPath = join(
    f.root,
    "custom_integrations",
    ".installation-locks",
    f.prepared.id,
    "owner.json",
  );
  const differentOwner = JSON.stringify({
    version: 1,
    transactionId: "944c81db-75da-418a-aef8-f839174cf87f",
  });
  writeFileSync(ownerPath, differentOwner, { mode: 0o600 });
  const recovered = await f.installer.restoreIntegrationPublication({
    rootDir: f.root,
    receipt: f.installer.describeIntegrationPublication(published),
    signal: f.signal,
  });
  await expect(
    f.installer.settleIntegrationPublication(recovered, "commit", f.signal),
  ).resolves.toMatchObject({ outcome: "committed" });
  expect(readFileSync(ownerPath, "utf8")).toBe(differentOwner);
  expect(() => f.installer.removeIntegration({ rootDir: f.root, id: f.prepared.id })).toThrow(
    /busy/,
  );
});
it("rejects oversized JSON metadata before parsing or whole-file reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "openmapx-large-manifest-"));
  roots.push(root);
  mkdirSync(join(root, "services"));
  const manifest =
    JSON.stringify({
      id: "oversized-json",
      name: "Oversized",
      version: "1.0.0",
      platform: "1.0",
      quality: "community",
      domains: ["map-overlay"],
    }) + " ".repeat(1024 * 1024);
  const bytes = createDeterministicTarGz([
    { path: "manifest.json", contents: Buffer.from(manifest) },
  ]);
  const archive = join(root, "oversized.tar.gz");
  writeFileSync(archive, bytes);
  await expect(
    installIntegration({
      rootDir: root,
      source: archive,
      sourceKind: "artifact",
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  ).rejects.toThrow(/manifest|large|limit/i);
});
