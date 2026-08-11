#!/usr/bin/env node
/**
 * Builds and signs the Android App Bundle locally.
 *
 * Keystore path, alias and passwords come from a mode-0600 properties file
 * outside the repository, never from command-line arguments — arguments land in
 * shell history and in every process listing on the machine.
 *
 * The keystore itself is never copied into the project. Gradle reads it from
 * wherever the properties file points.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { distDir, mobileRoot, readToolchains, readVersion } from "./context.ts";

const version = readVersion();
const toolchains = readToolchains();
const output = distDir(version);
mkdirSync(output, { recursive: true });

const androidDir = resolve(mobileRoot, "android");
if (!existsSync(androidDir)) {
  console.error("[release:android] no generated project; run `pnpm mobile:prebuild:check` first");
  process.exit(1);
}

/** Where the signing properties live. Outside the tree, always. */
const propertiesPath =
  process.env.OPENMAPX_ANDROID_SIGNING_PROPERTIES ??
  resolve(homedir(), ".openmapx/android-release.properties");

const unsigned = process.argv.includes("--unsigned");

if (!unsigned) {
  if (!existsSync(propertiesPath)) {
    console.error(`[release:android] no signing properties at ${propertiesPath}`);
    console.error("  Create it with mode 0600 containing:");
    console.error("    storeFile=/absolute/path/to/openmapx-upload.jks");
    console.error("    storePassword=…");
    console.error("    keyAlias=openmapx-upload");
    console.error("    keyPassword=…");
    console.error("  Or pass --unsigned to rehearse the build without signing.");
    process.exit(1);
  }
  // A world-readable secrets file is the same as no secrets file.
  const mode = statSync(propertiesPath).mode & 0o777;
  if (mode & 0o077) {
    console.error(
      `[release:android] ${propertiesPath} is mode ${mode.toString(8)}; it must be 0600`,
    );
    process.exit(1);
  }
  copyFileSync(propertiesPath, resolve(androidDir, "release-signing.properties"));
}

const javaHome = process.env.JAVA_HOME;
if (!javaHome) {
  console.error(
    `[release:android] set JAVA_HOME to a JDK ${toolchains.android.javaMajor.join(" or ")} installation`,
  );
  console.error("  AGP's JdkImageTransform fails on newer JDKs with an unrelated-looking error.");
  process.exit(1);
}

const task = unsigned ? "assembleRelease" : "bundleRelease";
console.log(`[release:android] gradle :app:${task}`);
execFileSync("./gradlew", [`:app:${task}`, "--no-daemon"], {
  cwd: androidDir,
  stdio: "inherit",
  env: { ...process.env, JAVA_HOME: javaHome },
});

const built = unsigned
  ? resolve(androidDir, "app/build/outputs/apk/release/app-release.apk")
  : resolve(androidDir, "app/build/outputs/bundle/release/app-release.aab");

if (!existsSync(built)) {
  console.error(`[release:android] expected ${built} and it is not there`);
  process.exit(1);
}

const destination = resolve(output, built.split("/").pop() as string);
copyFileSync(built, destination);

console.log(`\n[release:android] ${destination}`);
console.log(`[release:android] ${readFileSync(built).byteLength} bytes`);
console.log("[release:android] nothing has been uploaded; that step is deliberately manual.");
