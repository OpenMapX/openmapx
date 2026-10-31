/** Fixed offline MOTIS paths and private materialization projection. No authority minting. */
import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ValidatedBuildBundle } from "./archive";
import { artifactFingerprint } from "./artifact-path";
import { AnchoredDirectory, identity, sameInode, withDirectories } from "./filesystem";
import type { BundleFile } from "./manifest";
import { parseBundleManifest } from "./manifest";
import type { MotisCandidateManifest } from "./motis-candidate";
import {
  MAX_MOTIS_MATERIALIZATION_BYTES,
  readVerifiedPortableMotisMaterialization,
  type VerifiedPortableMotisMaterialization,
} from "./motis-portable";

const inode = z.strictObject({ dev: z.string(), ino: z.string() });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const slotStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  activeSlot: z.enum(["A", "B"]),
  previousHealthySlot: z.enum(["A", "B"]).optional(),
  datasetEpoch: z.string().max(512).optional(),
  manifestHash: z.string().max(128).optional(),
  imageDigest: z.string().max(4096).optional(),
  activatedAt: z.string().max(128).optional(),
  retainedRollback: z
    .strictObject({
      proposalId: z.uuid(),
      validationId: z.uuid(),
      slot: z.enum(["A", "B"]),
      epoch: z.string().max(512),
      manifestHash: digest,
      filesDigest: digest,
    })
    .optional(),
});
export const motisPublicationLayoutSchema = z.strictObject({
  physicalLive: z.enum(["motis/live", "motis/slots/A", "motis/slots/B"]),
  aliases: z
    .array(
      z.strictObject({
        name: z.enum(["live", "staging"]),
        target: z.enum(["slots/A", "slots/B"]),
        inode,
      }),
    )
    .max(2),
  slotState: z.strictObject({ inode, digest, record: slotStateSchema }).nullable(),
});
export type MotisPublicationLayout = z.infer<typeof motisPublicationLayoutSchema>;
export function readMotisPublicationLayout(root: AnchoredDirectory): MotisPublicationLayout {
  let motis: AnchoredDirectory;
  try {
    motis = root.directory("motis", false, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { physicalLive: "motis/live", aliases: [], slotState: null };
    throw error;
  }
  try {
    const aliases: MotisPublicationLayout["aliases"] = [];
    for (const name of ["live", "staging"] as const) {
      let stat: import("node:fs").BigIntStats;
      try {
        stat = lstatSync(motis.name(name), { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isSymbolicLink()) {
        if (!stat.isDirectory()) throw Error("MOTIS alias type changed");
        continue;
      }
      const target = readlinkSync(motis.name(name));
      if (
        !["slots/A", "slots/B"].includes(target) ||
        !sameInode(identity(stat), identity(lstatSync(motis.name(name), { bigint: true })))
      )
        throw Error("MOTIS alias changed");
      aliases.push({ name, target: target as "slots/A" | "slots/B", inode: identity(stat) });
    }
    let slotState: MotisPublicationLayout["slotState"] = null;
    try {
      const stat = motis.fileIdentity("slot-state.json", false),
        bytes = motis.read("slot-state.json", 65536, false);
      slotState = {
        inode: stat,
        digest: createHash("sha256").update(bytes).digest("hex"),
        record: slotStateSchema.parse(JSON.parse(bytes.toString("utf8"))),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!aliases.length) {
      if (slotState) throw Error("MOTIS slot state has no matching aliases");
      return { physicalLive: "motis/live", aliases, slotState };
    }
    const live = aliases.find((alias) => alias.name === "live"),
      staging = aliases.find((alias) => alias.name === "staging");
    if (
      aliases.length !== 2 ||
      !live ||
      !staging ||
      live.target === staging.target ||
      !slotState ||
      live.target !== `slots/${slotState.record.activeSlot}`
    )
      throw Error("MOTIS slot aliases and state disagree");
    return {
      physicalLive: live.target === "slots/A" ? "motis/slots/A" : "motis/slots/B",
      aliases,
      slotState,
    };
  } finally {
    motis.close();
  }
}
export function assertMotisPublicationAliases(
  root: AnchoredDirectory,
  expected: MotisPublicationLayout,
): void {
  if (!expected.aliases.length) {
    const current = readMotisPublicationLayout(root);
    if (current.aliases.length || current.slotState) throw Error("Unexpected MOTIS slot layout");
    return;
  }
  const motis = root.directory("motis", false, false);
  try {
    for (const alias of expected.aliases) {
      const stat = lstatSync(motis.name(alias.name), { bigint: true });
      if (
        !stat.isSymbolicLink() ||
        !sameInode(alias.inode, identity(stat)) ||
        readlinkSync(motis.name(alias.name)) !== alias.target
      )
        throw Error("Original MOTIS alias changed");
    }
  } finally {
    motis.close();
  }
}
export async function materializedMotisBundle(
  bundle: ValidatedBuildBundle,
  stagingRoot: string,
  proof: VerifiedPortableMotisMaterialization,
  signal?: AbortSignal,
): Promise<ValidatedBuildBundle & { motisCandidate: MotisCandidateManifest }> {
  const portable = parseBundleManifest(JSON.stringify(bundle.manifest));
  if (portable.service !== "motis" || portable.schemaVersion !== 2)
    throw Error("Portable MOTIS source required");
  const metadata = portable.files.find((file) => file.path === "motis/live/portable-sources.json");
  if (!metadata) throw Error("Portable MOTIS metadata missing");
  const generated = await readVerifiedPortableMotisMaterialization(proof, {
    stagingDir: join(stagingRoot, "motis/live"),
    archiveFingerprint: bundle.artifactFingerprint,
    portableMetadataSha256: metadata.sha256,
    signal,
  });
  const files = new Map<string, BundleFile>(portable.files.map((file) => [file.path, file]));
  for (const file of generated.generatedArtifacts)
    files.set(`motis/live/${file.path}`, { ...file, path: `motis/live/${file.path}` });
  const root = new AnchoredDirectory(realpathSync(stagingRoot));
  try {
    // The consumer root is a separate copy. Candidate verification continues to
    // own its own .openmapx-feed-proxy files inside the live candidate.
    for (const name of ["feed-proxy-vars.json", "conf/default.conf"]) {
      const sourcePath = `.openmapx-feed-proxy/${name}`,
        expected = generated.generatedArtifacts.find((file) => file.path === sourcePath);
      if (!expected) throw Error("Materialized MOTIS proxy proof missing");
      const bytes = withDirectories(
        root,
        ["motis", "live", ".openmapx-feed-proxy", ...(name.startsWith("conf/") ? ["conf"] : [])],
        false,
        (dir) => dir.read(name.split("/").at(-1)!, MAX_MOTIS_MATERIALIZATION_BYTES, false),
      );
      if (
        bytes.length !== expected.sizeBytes ||
        createHash("sha256").update(bytes).digest("hex") !== expected.sha256
      )
        throw Error("Materialized MOTIS proxy changed");
      withDirectories(
        root,
        ["motis-feed-proxy", ...(name.startsWith("conf/") ? ["conf"] : [])],
        true,
        (dir) => dir.write(name.split("/").at(-1)!, bytes),
      );
      files.set(`motis-feed-proxy/${name}`, {
        path: `motis-feed-proxy/${name}`,
        sha256: expected.sha256,
        sizeBytes: expected.sizeBytes,
      });
    }
  } finally {
    root.close();
  }
  const directories = new Set(portable.directories);
  for (const file of files.values()) {
    const parts = file.path.split("/");
    parts.pop();
    while (parts.length) {
      const path = parts.join("/");
      if (portable.dirs.some((dir) => path === dir || path.startsWith(`${dir}/`)))
        directories.add(path);
      parts.pop();
    }
  }
  const inventory = [...files.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    fingerprint = artifactFingerprint(inventory);
  // This projection is deliberately private: public tar parsing still rejects
  // credential-bearing config/proxy files. Only the nominal producer supplied
  // this exact generated inventory and its verified source bytes.
  return {
    ...bundle,
    motisCandidate: generated.manifest,
    manifest: {
      ...portable,
      files: inventory,
      directories: [...directories].sort(),
      artifactFingerprint: fingerprint,
    },
    artifactFingerprint: fingerprint,
    expandedBytes: inventory.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}
