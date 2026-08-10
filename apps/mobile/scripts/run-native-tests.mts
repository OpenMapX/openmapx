#!/usr/bin/env node
/**
 * Runs the project-owned native unit tests.
 *
 * Both suites cover the framework-free half of the navigation audio module —
 * cue deduplication, audio-session and audio-focus transitions, locale
 * selection, rate clamping and input bounds. The platform-touching half is
 * exercised by the local Release builds instead, because committing an XCTest
 * or instrumentation target inside a generated project would contradict the
 * rule that those projects are disposable.
 *
 *   - Swift: a SwiftPM package that compiles only `NavigationAudioPolicy.swift`.
 *   - Kotlin: a JVM unit-test source set inside the committed module, run
 *     through the regenerated Gradle project.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const audioModule = join(mobileRoot, "modules/openmapx-navigation-audio");

// The repository augments `NodeJS.ProcessEnv` with required keys, so extra
// variables are typed as a plain record and merged onto the real environment.
function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): void {
  execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

function capture(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function runSwiftTests(): void {
  if (process.platform !== "darwin") {
    throw new Error("the Swift policy tests require macOS with the Xcode toolchain");
  }
  console.log("\n[native-tests] swift test — navigation audio policy");
  run("swift", ["test"], audioModule);
}

/**
 * The Android Gradle Plugin does not support every JDK the machine may default
 * to, so a supported one is selected explicitly rather than inherited.
 */
function resolveJavaHome(): string {
  if (process.env.JAVA_HOME && existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  for (const version of ["21", "17"]) {
    const home = capture("/usr/libexec/java_home", ["-v", version]);
    if (home && existsSync(home)) return home;
  }
  throw new Error(
    "no supported JDK found; install JDK 17 or 21, or set JAVA_HOME before running the native tests",
  );
}

function resolveAndroidSdk(): string {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(process.env.HOME ?? "", "Library/Android/sdk"),
    join(process.env.HOME ?? "", "Android/Sdk"),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("no Android SDK found; set ANDROID_HOME before running the native tests");
  }
  return found;
}

function runKotlinTests(): void {
  const androidProject = join(mobileRoot, "android");
  if (!existsSync(androidProject)) {
    // The Gradle project is build output; regenerate it rather than requiring a
    // developer to remember a prior step. Pods are irrelevant here.
    console.log("\n[native-tests] generating the Android project for the JVM test run");
    run("npx", ["--no-install", "expo", "prebuild", "-p", "android", "--no-install"], mobileRoot);
  }
  console.log("\n[native-tests] gradle — navigation audio policy");
  const androidSdk = resolveAndroidSdk();
  run(
    "./gradlew",
    [":openmapx-navigation-audio:testDebugUnitTest", "--no-daemon"],
    androidProject,
    {
      JAVA_HOME: resolveJavaHome(),
      ANDROID_HOME: androidSdk,
      ANDROID_SDK_ROOT: androidSdk,
    },
  );
}

function main(): number {
  try {
    runSwiftTests();
    runKotlinTests();
    console.log("\n[native-tests] Swift and Kotlin policy suites passed");
    return 0;
  } catch (error) {
    console.error(`\n[native-tests] ${(error as Error).message}`);
    return 1;
  }
}

process.exitCode = main();
