#!/usr/bin/env node
/**
 * Fails when the generated native projects ask for something nobody reviewed.
 *
 * The app config states what the app should request; this reads what it actually
 * requests, after every config plugin and every transitive dependency has had
 * its say. Those are different things, and the gap between them is where an
 * unwanted permission arrives — a library adds `RECORD_AUDIO` to its manifest,
 * the merge pulls it in, and nothing in the committed source mentions it.
 *
 * Run after `expo prebuild`:
 *
 *   pnpm -C apps/mobile exec tsx scripts/assert-release-permissions.mts --generated
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { diffPermissionSurface, type PermissionSurface } from "../compliance/permissions.ts";

const mobileRoot = resolve(import.meta.dirname, "..");

function fail(lines: string[]): never {
  console.error("[assert-release-permissions] the signed surface is not the reviewed surface:\n");
  for (const line of lines) console.error(`  ${line}`);
  console.error(
    "\nFix the app config or the config plugin and prebuild again. Do not edit the\n" +
      "generated project: it is rebuilt from scratch on the next generation.",
  );
  process.exit(1);
}

/** Every `<uses-permission>` in the merged manifest. */
function androidPermissions(manifestPath: string): string[] {
  const manifest = readFileSync(manifestPath, "utf8");
  return (
    [...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)]
      .map((match) => match[1])
      // `tools:node="remove"` marks a permission the merge strips rather than one
      // the app requests.
      .filter((_id, index) => {
        const occurrence = [...manifest.matchAll(/<uses-permission[^>]*\/?>/g)][index]?.[0] ?? "";
        return !occurrence.includes('tools:node="remove"');
      })
  );
}

/** The Info.plist keys and background modes, read without a plist parser. */
function iosSurface(
  plistPath: string,
): Pick<PermissionSurface, "iosUsageDescriptionKeys" | "iosBackgroundModes"> {
  const plist = readFileSync(plistPath, "utf8");
  const keys = [...plist.matchAll(/<key>([A-Za-z]+UsageDescription)<\/key>/g)].map(
    (match) => match[1],
  );

  const modesBlock = plist.match(/<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const modes = modesBlock
    ? [...modesBlock[1].matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1])
    : [];

  return { iosUsageDescriptionKeys: keys, iosBackgroundModes: modes };
}

function findFile(root: string, name: string, depth = 0): string | null {
  if (depth > 4 || !existsSync(root)) return null;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (entry === name) return path;
    if (statSync(path).isDirectory() && !entry.startsWith(".") && entry !== "Pods") {
      const found = findFile(path, name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const androidManifest = resolve(mobileRoot, "android/app/src/main/AndroidManifest.xml");
const iosPlist = findFile(resolve(mobileRoot, "ios"), "Info.plist");

if (!existsSync(androidManifest) && !iosPlist) {
  fail([
    "no generated native project found",
    "run `pnpm -C apps/mobile prebuild` first; this check reads the generated output,",
    "which is exactly the thing the app config alone cannot tell you",
  ]);
}

const observed: Partial<PermissionSurface> = {};
const inspected: string[] = [];

if (existsSync(androidManifest)) {
  observed.androidPermissions = androidPermissions(androidManifest);
  inspected.push("android/app/src/main/AndroidManifest.xml");
}
if (iosPlist) {
  Object.assign(observed, iosSurface(iosPlist));
  inspected.push(iosPlist.replace(`${mobileRoot}/`, ""));
}

const violations = diffPermissionSurface(observed);

/** Things that would let a reviewed binary change after review. */
const extraChecks: string[] = [];

if (existsSync(androidManifest)) {
  const manifest = readFileSync(androidManifest, "utf8");
  if (manifest.includes('android:usesCleartextTraffic="true"')) {
    extraChecks.push("AndroidManifest permits cleartext traffic");
  }
  if (manifest.includes('android:debuggable="true"')) {
    extraChecks.push("AndroidManifest marks the app debuggable");
  }
  if (manifest.includes('android:allowBackup="true"')) {
    extraChecks.push("AndroidManifest allows backup of the app's private data");
  }
  // The generated manifest always writes these keys; what matters is the value.
  // Matching on the key alone would flag the declaration that *disables* updates.
  if (/expo\.modules\.updates\.ENABLED"\s+android:value="true"/.test(manifest)) {
    extraChecks.push("AndroidManifest enables expo-updates, an over-the-air native update path");
  }
  if (manifest.includes("expo.modules.updates.EXPO_UPDATE_URL")) {
    extraChecks.push("AndroidManifest configures an over-the-air update URL");
  }
}

if (iosPlist) {
  const plist = readFileSync(iosPlist, "utf8");
  // Again the value, not the key: the generated plist states the policy
  // explicitly, and `NSAllowsArbitraryLoads` set to false is the safe answer.
  if (/<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>/.test(plist)) {
    extraChecks.push("Info.plist relaxes App Transport Security");
  }
  if (plist.includes("<key>EXUpdatesURL</key>")) {
    extraChecks.push("Info.plist configures an over-the-air update URL");
  }
  if (/<key>EXUpdatesEnabled<\/key>\s*<true\/>/.test(plist)) {
    extraChecks.push("Info.plist enables expo-updates, an over-the-air native update path");
  }
}

if (violations.length > 0 || extraChecks.length > 0) {
  fail([
    ...violations.map(
      (violation) =>
        `${violation.platform} ${violation.kind}: ${violation.id} — ${violation.reason}`,
    ),
    ...extraChecks,
  ]);
}

console.log(
  `[assert-release-permissions] ${inspected.join(", ")} match the reviewed surface exactly`,
);
