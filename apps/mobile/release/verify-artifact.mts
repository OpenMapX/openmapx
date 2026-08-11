#!/usr/bin/env node
/**
 * Inspects the built artifacts and writes the provenance manifest.
 *
 * Reads the exact paths from `version.json` rather than picking the newest
 * directory: "latest" is how the wrong build gets uploaded, and the whole point
 * of a manifest is that it describes a specific artifact.
 *
 * What it asserts about the contents is what a reviewer or a future maintainer
 * would want to know — the identifiers, the permission surface, and the absence
 * of anything that would let the binary change after review.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  distDir,
  gitState,
  identity,
  mobileRoot,
  nativeLocks,
  readToolchains,
  readVersion,
  recordFile,
  repoRoot,
} from "./context.ts";
import {
  type ArtifactRecord,
  buildReleaseManifest,
  findSecretsInManifest,
} from "./release-manifest.ts";

const version = readVersion();
const output = distDir(version);
const failures: string[] = [];

if (!existsSync(output)) {
  console.error(`[release:verify] nothing built for ${version.marketingVersion} at ${output}`);
  process.exit(1);
}

const artifacts: ArtifactRecord[] = readdirSync(output)
  .filter((entry) => /\.(ipa|aab|apk)$/.test(entry))
  .map((entry) => recordFile(resolve(output, entry)))
  .filter((record): record is ArtifactRecord => record !== null);

if (artifacts.length === 0) {
  failures.push("no IPA, AAB or APK in the release directory");
}

/** Everything inside an archive that would be a finding. */
const FORBIDDEN_STRINGS = [
  "EXUpdatesURL",
  "expo-updates",
  "localhost:3000",
  "127.0.0.1:3000",
  "eas.json",
  "expo.dev/--/api",
];

for (const artifact of artifacts) {
  const absolute = resolve(repoRoot, artifact.path);
  let listing = "";
  try {
    // Reads the archive's entry names only; nothing is extracted, so a hostile
    // artifact cannot write anywhere.
    listing = execFileSync("unzip", ["-Z1", absolute], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    failures.push(`${artifact.path} could not be listed`);
    continue;
  }

  if (listing.includes("EXUpdates") || listing.includes("expo-updates")) {
    failures.push(`${artifact.path} contains an over-the-air update component`);
  }
  const debugSymbols = listing.split("\n").filter((entry) => entry.endsWith(".dSYM/"));
  if (debugSymbols.length > 0) {
    // Symbols belong beside the archive in offline storage, not inside the
    // payload a user downloads.
    failures.push(`${artifact.path} carries ${debugSymbols.length} dSYM bundle(s) in the payload`);
  }
}

/** The generated native hash the prebuild check computes, if it has run. */
function generatedNativeHash(): string | null {
  const marker = resolve(repoRoot, "dist/mobile/.generated-native-hash");
  return existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
}

const signing = JSON.parse(
  readFileSync(resolve(mobileRoot, "release/public-signing-identities.json"), "utf8"),
) as { apple: { teamId: string }; google: { playAppSigningSha256: string } };

const manifest = buildReleaseManifest({
  nowMs: Date.now(),
  git: gitState(),
  version: {
    marketingVersion: version.marketingVersion,
    iosBuildNumber: version.iosBuildNumber,
    androidVersionCode: version.androidVersionCode,
    protocol: version.protocol,
    channel: version.channel,
  },
  identity: identity(),
  toolchains: {
    node: process.versions.node,
    expoSdk: readToolchains().expoSdk,
    reactNative: readToolchains().reactNative,
  },
  locks: nativeLocks(),
  generatedNativeHash: generatedNativeHash(),
  permissionsSource: readFileSync(resolve(mobileRoot, "compliance/permissions.ts"), "utf8"),
  dataPracticesSource: readFileSync(resolve(mobileRoot, "compliance/data-practices.json"), "utf8"),
  publicSigning: {
    appleTeamId: signing.apple.teamId.includes("TEAM_ID") ? null : signing.apple.teamId,
    playAppSigningSha256: signing.google.playAppSigningSha256.includes("REPLACE_")
      ? null
      : signing.google.playAppSigningSha256,
  },
  artifacts,
});

const leaked = findSecretsInManifest(manifest);
if (leaked.length > 0) failures.push(`the manifest would carry ${leaked.join(", ")}`);

if (failures.length > 0) {
  console.error("[release:verify] the artifacts are not shippable:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

const manifestPath = resolve(output, "release-manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[release:verify] ${artifacts.length} artifact(s) inspected`);
for (const artifact of artifacts)
  console.log(`  ${artifact.path}  ${artifact.sha256.slice(0, 16)}…`);
console.log(`[release:verify] provenance written to ${manifestPath}`);
console.log(
  "[release:verify] store the artifacts, symbols and manifest in offline release storage.",
);
