#!/usr/bin/env node
/**
 * Archives and exports the iOS app locally.
 *
 * `xcodebuild` on the generated workspace, then `-exportArchive` with the
 * committed App Store Connect export options. No credential is ever passed as
 * an argument: signing comes from the Keychain and from Xcode-managed profiles,
 * so nothing sensitive lands in shell history or a process listing.
 *
 * The archive is written into the ignored dist directory for this version, not
 * into a "latest" folder — `verify-artifact` reads the exact path from
 * `version.json`, and "latest" is how the wrong build gets uploaded.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { distDir, mobileRoot, readVersion } from "./context.ts";

const version = readVersion();
const output = distDir(version);
mkdirSync(output, { recursive: true });

const workspace = resolve(mobileRoot, "ios");
if (!existsSync(workspace)) {
  console.error("[release:ios] no generated iOS project; run `pnpm mobile:prebuild:check` first");
  process.exit(1);
}

const schemeIndex = process.argv.indexOf("--scheme");
const scheme = schemeIndex >= 0 ? process.argv[schemeIndex + 1] : "OpenMapX";
const archivePath = resolve(output, `${scheme}.xcarchive`);

function run(command: string, args: string[]): void {
  console.log(`[release:ios] ${command} ${args.slice(0, 4).join(" ")}…`);
  execFileSync(command, args, { cwd: workspace, stdio: "inherit" });
}

run("xcodebuild", [
  "-workspace",
  `${scheme}.xcworkspace`,
  "-scheme",
  scheme,
  "-configuration",
  "Release",
  // The generic destination, so the archive is device-bound rather than
  // simulator-bound. A simulator archive cannot be uploaded and the error only
  // appears at validation.
  "-destination",
  "generic/platform=iOS",
  "-archivePath",
  archivePath,
  "archive",
  "DEBUG_INFORMATION_FORMAT=dwarf-with-dsym",
]);

run("xcodebuild", [
  "-exportArchive",
  "-archivePath",
  archivePath,
  "-exportPath",
  output,
  "-exportOptionsPlist",
  resolve(mobileRoot, "release/ExportOptions.app-store-connect.plist"),
]);

console.log(`\n[release:ios] archive and IPA in ${output}`);
console.log("[release:ios] validate and upload through Xcode Organizer or Transporter.");
console.log("[release:ios] nothing has been uploaded; that step is deliberately manual.");
