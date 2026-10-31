import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  closeControlInstallation,
  installationState,
  openControlInstallation,
  readPrivateRecord,
  retainedExecutionOrigin,
  writePrivateRecord,
} from "../build-artifacts/control-authority";
import { controlDigest, signControl, verifyControl } from "../build-artifacts/control-records";
import { AnchoredDirectory, identity, sameInode } from "../build-artifacts/filesystem";
import {
  verifyCatalogPinReceiptRepairPreimage,
  verifyFamilyOwnedRecord,
} from "../build-artifacts/retention-family";
import {
  assertArtifactTargetLeaseExecution,
  catalogPinTargetOwner,
  type TargetLeaseAuthority,
} from "../build-artifacts/target-lease";
import { canonicalJson } from "../ops/canonical-json";
import { createCatalogPinSet, parseCatalogPinSet } from "./generation";
import {
  catalogPinCommitIdentitySchema,
  catalogPinCommitReceiptSchema,
  catalogPinPointerSchema,
  decodeLegacyPin,
  gbfsPinSchema,
  MAX_CATALOG_PIN_BYTES,
  transitousPinSchema,
} from "./schemas";
import type { CatalogPinCommitIdentity, CatalogPinCommitReceipt, CatalogPinSet } from "./types";

const DOMAIN = "openmapx-catalog-pin-commit-v1";
const journalSchema = z.strictObject({
  version: z.literal(1),
  receipt: catalogPinCommitReceiptSchema,
  previous: catalogPinPointerSchema.nullable(),
  next: catalogPinPointerSchema,
});
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function optionalRead(
  dir: AnchoredDirectory,
  name: string,
  max: number,
  privateMode = true,
): Buffer | null {
  try {
    return dir.read(name, max, privateMode);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
function directories<T>(
  rootDir: string,
  create: boolean,
  run: (docker: AnchoredDirectory, pins: AnchoredDirectory | null) => T,
): T {
  const opened: AnchoredDirectory[] = [];
  try {
    let dir = new AnchoredDirectory(rootDir);
    opened.push(dir);
    for (const part of ["infra", "docker"]) {
      dir = dir.directory(part);
      opened.push(dir);
    }
    const docker = dir;
    let pins: AnchoredDirectory;
    try {
      pins = docker.directory("catalog-pins", create, true);
      opened.push(pins);
    } catch (error) {
      if (!create && missing(error)) return run(docker, null);
      throw error;
    }
    return run(docker, pins);
  } finally {
    for (const dir of opened.reverse()) dir.close();
  }
}
function pointer(dir: AnchoredDirectory) {
  const bytes = optionalRead(dir, "current.json", 4096);
  return bytes ? catalogPinPointerSchema.parse(JSON.parse(bytes.toString("utf8"))) : null;
}
function selected(pins: AnchoredDirectory): CatalogPinSet | null {
  const current = pointer(pins);
  if (!current) return null;
  const generations = pins.directory("generations");
  try {
    const pair = parseCatalogPinSet(
      JSON.parse(
        generations.read(`${current.generationId}.json`, MAX_CATALOG_PIN_BYTES).toString("utf8"),
      ),
    );
    if (pair.generationId !== current.generationId)
      throw Error("Catalog pin pointer/generation mismatch");
    return pair;
  } finally {
    generations.close();
  }
}
export function readCatalogPinSet(rootDir: string): CatalogPinSet | null {
  return directories(rootDir, false, (_docker, pins) => (pins ? selected(pins) : null));
}
function assertCatalogRoot(rootDir: string, installation: Parameters<typeof installationState>[0]) {
  const expected = new AnchoredDirectory(installationState(installation).dataRoot);
  let actual: AnchoredDirectory | undefined;
  try {
    actual = new AnchoredDirectory(join(rootDir, "infra/docker/data"));
    if (!sameInode(identity(expected.stat), identity(actual.stat)))
      throw Error("Foreign catalog checkout/data root");
  } finally {
    actual?.close();
    expected.close();
  }
}
function writeGeneration(pins: AnchoredDirectory, pair: CatalogPinSet) {
  const generations = pins.directory("generations", true, true);
  try {
    const name = `${pair.generationId}.json`,
      existing = optionalRead(generations, name, MAX_CATALOG_PIN_BYTES);
    if (existing) {
      if (
        canonicalJson(parseCatalogPinSet(JSON.parse(existing.toString("utf8")))) !==
        canonicalJson(pair)
      )
        throw Error("Immutable catalog generation changed");
    } else generations.write(name, canonicalJson(pair), true);
  } finally {
    generations.close();
  }
}
export function preflightCatalogPinInitialization(rootDir: string): boolean {
  return directories(rootDir, false, (docker, _pins) => {
    const transitous = optionalRead(docker, "transitous.lock.json", 256 * 1024, false),
      gbfs = optionalRead(docker, "gbfs-catalog.lock.json", 256 * 1024, false);
    if (!transitous && !gbfs) return false;
    if (!transitous || !gbfs)
      throw Error("Both legacy catalog locks are required for paired initialization");
    createCatalogPinSet(
      decodeLegacyPin(transitous, transitousPinSchema),
      decodeLegacyPin(gbfs, gbfsPinSchema),
    );
    return true;
  });
}
/** Bootstrap is separate from validation/activation and never creates an approval receipt. */
export async function initializeCatalogPinSet(options: {
  rootDir: string;
  lease: TargetLeaseAuthority;
}): Promise<CatalogPinSet | null> {
  const owner = catalogPinTargetOwner(options.lease);
  assertCatalogRoot(options.rootDir, owner.installation);
  return directories(options.rootDir, true, (docker, pins) => {
    if (!pins) throw Error("Catalog pin directory unavailable");
    const record = (pair: CatalogPinSet | null) => {
      const state = installationState(owner.installation),
        marker = pointer(pins);
      writePrivateRecord(
        state,
        "catalog-commits",
        `initialization-${owner.execution.operationKey}.json`,
        signControl(state.privateKey, "openmapx-catalog-pin-initialization-v1", {
          version: 1,
          execution: owner.execution,
          generationId: pair?.generationId ?? null,
          pointerDigest: marker ? controlDigest(marker) : null,
        }),
        false,
        owner.origin,
      );
      return pair;
    };
    const current = selected(pins);
    if (current) return record(current);
    const transitous = optionalRead(docker, "transitous.lock.json", 256 * 1024, false),
      gbfs = optionalRead(docker, "gbfs-catalog.lock.json", 256 * 1024, false);
    if (!transitous && !gbfs) return record(null);
    if (!transitous || !gbfs)
      throw Error("Both legacy catalog locks are required for paired initialization");
    const tIdentity = docker.fileIdentity("transitous.lock.json", false),
      gIdentity = docker.fileIdentity("gbfs-catalog.lock.json", false);
    const pair = createCatalogPinSet(
      decodeLegacyPin(transitous, transitousPinSchema),
      decodeLegacyPin(gbfs, gbfsPinSchema),
    );
    writeGeneration(pins, pair);
    catalogPinTargetOwner(options.lease);
    if (
      canonicalJson(tIdentity) !==
        canonicalJson(docker.fileIdentity("transitous.lock.json", false)) ||
      canonicalJson(gIdentity) !==
        canonicalJson(docker.fileIdentity("gbfs-catalog.lock.json", false)) ||
      !transitous.equals(docker.read("transitous.lock.json", 256 * 1024, false)) ||
      !gbfs.equals(docker.read("gbfs-catalog.lock.json", 256 * 1024, false))
    )
      throw Error("Legacy catalog locks changed during initialization");
    pins.write(
      "current.json",
      canonicalJson(
        catalogPinPointerSchema.parse({
          version: 1,
          generationId: pair.generationId,
          commitId: randomUUID(),
          operationKey: owner.execution.operationKey,
          fingerprint: owner.execution.fingerprint,
          committedAt: new Date().toISOString(),
        }),
      ),
    );
    return record(pair);
  });
}
function readJournal(rootDir: string, commit: CatalogPinCommitIdentity) {
  if (commit.execution.executor !== "ops-agent") throw Error("Agent-owned catalog commit required");
  const installation = openControlInstallation({
    infraDir: join(rootDir, "infra/docker"),
    role: "ops-agent",
    serviceIds: ["motis"],
    container: existsSync("/run/secrets/openmapx-control-verifiers"),
  });
  try {
    const state = installationState(installation),
      origin = retainedExecutionOrigin(state, commit.execution);
    if (!origin) throw Error("Retained catalog execution origin required");
    const read = (name: string) => {
      const raw = readPrivateRecord(state, "catalog-commits", name, 65536);
      verifyFamilyOwnedRecord(
        state,
        origin,
        { scope: "private", namespace: "catalog-commits", name, container: "" },
        canonicalJson(raw),
      );
      const journal = verifyControl(state.installation.publicKey, DOMAIN, raw, journalSchema);
      if (canonicalJson(journal.receipt.identity) !== canonicalJson(commit))
        throw Error("Catalog commit identity conflict");
      return journal;
    };
    let intent: z.infer<typeof journalSchema>;
    try {
      intent = read(`${commit.execution.operationKey}.intent.json`);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (intent.receipt.phase !== "prepared") throw Error("Invalid immutable catalog intent");
    const name = `${commit.execution.operationKey}.json`;
    try {
      const receipt = read(name);
      if (canonicalJson({ ...receipt, receipt: intent.receipt }) !== canonicalJson(intent))
        throw Error("Catalog receipt intent mismatch");
      return receipt;
    } catch (error) {
      if (missing(error)) return intent;
      // The immutable intent and exact pointer prove publication. A copied
      // terminal receipt is refused; only the indexed, not-yet-published
      // terminal preimage can replace the original prepared cache.
      const raw = readPrivateRecord(state, "catalog-commits", name, 65536);
      const prior = verifyControl(state.installation.publicKey, DOMAIN, raw, journalSchema);
      if (canonicalJson(prior) !== canonicalJson(intent)) throw error;
      const marker = directories(rootDir, false, (_docker, pins) => (pins ? pointer(pins) : null));
      if (canonicalJson(marker) !== canonicalJson(intent.next)) throw error;
      const repaired = {
        ...intent,
        receipt: {
          ...intent.receipt,
          phase: "committed" as const,
          committedAt: intent.next.committedAt,
        },
      };
      const signed = signControl(state.privateKey, DOMAIN, repaired),
        bytes = canonicalJson(signed);
      verifyCatalogPinReceiptRepairPreimage(state, origin, commit.execution.operationKey, bytes);
      writePrivateRecord(state, "catalog-commits", name, signed, false, origin);
      return read(name);
    }
  } finally {
    closeControlInstallation(installation);
  }
}
function reconcile(
  journal: z.infer<typeof journalSchema>,
  current: z.infer<typeof catalogPinPointerSchema> | null,
): CatalogPinCommitReceipt {
  if (journal.receipt.phase === "committed" || journal.receipt.phase === "not_committed")
    return journal.receipt;
  if (canonicalJson(current) === canonicalJson(journal.next))
    return { ...journal.receipt, phase: "committed", committedAt: journal.next.committedAt };
  return { ...journal.receipt, phase: "unknown", committedAt: null };
}
export async function readCatalogPinCommit(options: {
  rootDir: string;
  commit: CatalogPinCommitIdentity;
}): Promise<CatalogPinCommitReceipt | null> {
  const commit = catalogPinCommitIdentitySchema.parse(options.commit),
    journal = readJournal(options.rootDir, commit);
  if (!journal) return null;
  return directories(options.rootDir, false, (_docker, pins) => {
    const receipt = reconcile(journal, pins ? pointer(pins) : null);
    if (receipt.phase === "committed" && journal.receipt.phase !== "committed") {
      const installation = openControlInstallation({
        infraDir: join(options.rootDir, "infra/docker"),
        role: "ops-agent",
        serviceIds: ["motis"],
        container: existsSync("/run/secrets/openmapx-control-verifiers"),
      });
      try {
        const state = installationState(installation),
          origin = retainedExecutionOrigin(state, commit.execution);
        if (!origin) throw Error("Original catalog receipt origin required");
        writePrivateRecord(
          state,
          "catalog-commits",
          `${commit.execution.operationKey}.json`,
          signControl(state.privateKey, DOMAIN, { ...journal, receipt }),
          false,
          origin,
        );
      } finally {
        closeControlInstallation(installation);
      }
    }
    if (pins && (receipt.phase === "committed" || receipt.phase === "not_committed")) {
      const pending = optionalRead(pins, "pending.json", 65536);
      if (pending) {
        if (
          canonicalJson(JSON.parse(pending.toString("utf8"))) !==
          canonicalJson({ identity: commit, generationId: receipt.generationId })
        )
          throw Error("Foreign pending catalog commit");
        // Only attempt metadata is repaired; current.json is never rewritten.
        pins.removeFile("pending.json");
      }
    }
    return receipt;
  });
}
/** Local CAS only. The agent's validation-bound activation is its only production caller. */
export async function publishCatalogPinSet(options: {
  rootDir: string;
  lease: TargetLeaseAuthority;
  pins: CatalogPinSet;
  expectedGenerationId: string | null;
  commit: CatalogPinCommitIdentity;
}): Promise<CatalogPinCommitReceipt> {
  const pair = parseCatalogPinSet(options.pins),
    commit = catalogPinCommitIdentitySchema.parse(options.commit);
  const owner = catalogPinTargetOwner(options.lease);
  assertCatalogRoot(options.rootDir, owner.installation);
  if (owner.installation.role !== "ops-agent")
    throw Error("Only the agent may activate catalog pins");
  assertArtifactTargetLeaseExecution(options.lease, commit.execution);
  const state = installationState(owner.installation);
  const save = (journal: z.infer<typeof journalSchema>, intent = false) => {
    const signed = signControl(state.privateKey, DOMAIN, journal);
    if (Buffer.byteLength(canonicalJson(signed)) > 65536)
      throw Error("Catalog commit receipt is too large");
    writePrivateRecord(
      state,
      "catalog-commits",
      `${commit.execution.operationKey}${intent ? ".intent" : ""}.json`,
      signed,
      intent,
      owner.origin,
    );
  };
  return directories(options.rootDir, true, (_docker, store) => {
    if (!store) throw Error("Catalog pin store unavailable");
    const current = pointer(store),
      retained = readJournal(options.rootDir, commit);
    if (retained) {
      if (
        retained.receipt.generationId !== pair.generationId ||
        retained.receipt.previousGenerationId !== options.expectedGenerationId
      )
        throw Error("Catalog commit intent conflict");
      const receipt = reconcile(retained, current);
      save({ ...retained, receipt });
      const pending = optionalRead(store, "pending.json", 65536);
      if (receipt.phase === "committed" && pending) {
        if (
          canonicalJson(JSON.parse(pending.toString("utf8"))) !==
          canonicalJson({ identity: commit, generationId: pair.generationId })
        )
          throw Error("Foreign pending catalog commit");
        store.removeFile("pending.json");
      }
      return receipt;
    }
    // A pending attempt is a global fence, not permission to copy or replay its pointer.
    if (optionalRead(store, "pending.json", 65536))
      throw Error("Catalog pin publication requires reconciliation");
    if ((current?.generationId ?? null) !== options.expectedGenerationId)
      throw Error("Catalog pin generation changed");
    const next = catalogPinPointerSchema.parse({
      version: 1,
      generationId: pair.generationId,
      commitId: commit.commitId,
      operationKey: commit.execution.operationKey,
      fingerprint: commit.execution.fingerprint,
      committedAt: new Date().toISOString(),
    });
    const receipt: CatalogPinCommitReceipt = {
      version: 1,
      identity: commit,
      previousGenerationId: options.expectedGenerationId,
      generationId: pair.generationId,
      phase: "prepared",
      committedAt: null,
    };
    const journal = { version: 1 as const, receipt, previous: current, next };
    save(journal, true);
    save(journal);
    store.write(
      "pending.json",
      canonicalJson({ identity: commit, generationId: pair.generationId }),
      true,
    );
    try {
      writeGeneration(store, pair);
      catalogPinTargetOwner(options.lease);
      if (canonicalJson(pointer(store)) !== canonicalJson(current))
        throw Error("Catalog pin pointer changed");
      store.write("current.json", canonicalJson(next));
      const committed = { ...receipt, phase: "committed" as const, committedAt: next.committedAt };
      save({ ...journal, receipt: committed });
      store.removeFile("pending.json");
      return committed;
    } catch (error) {
      // The live synchronous writer has unwound. Exact unchanged predecessor
      // proves nonpublication; a foreign/missing/changed pointer proves nothing.
      if (canonicalJson(pointer(store)) === canonicalJson(current)) {
        save({ ...journal, receipt: { ...receipt, phase: "not_committed" } });
        store.removeFile("pending.json");
      }
      throw error;
    }
  });
}
