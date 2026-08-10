/**
 * Reads the generated `ios/` and `android/` projects into the plain documents
 * the policy checks operate on. Kept separate from the checks so the rules stay
 * testable without a prebuild, and separate from the CLI so other release
 * scripts can reuse the same reader.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
// `@expo/plist` is CommonJS with a `default` export, so the interop shape
// differs between the ESM script runner and Vitest. Normalise it once.
import plistModule from "@expo/plist";

const plist = ((plistModule as { default?: unknown }).default ?? plistModule) as {
  parse: (contents: string) => unknown;
};

import { XML } from "expo/config-plugins";
import type { AndroidManifestLike } from "../plugins/nativeConfigTransforms.ts";
import { EXPO_LOCATION_SERVICE_NAMES } from "../plugins/nativeConfigTransforms.ts";
import type { GeneratedNativeSurface } from "./generatedNativeChecks.ts";

export class MissingGeneratedProjectError extends Error {}

function readText(path: string): string {
  if (!existsSync(path)) {
    throw new MissingGeneratedProjectError(
      `${path} does not exist — run \`pnpm mobile:prebuild\` first`,
    );
  }
  return readFileSync(path, "utf8");
}

/** The single `ios/<AppName>/` source directory Expo generates. */
function iosAppDirectory(mobileRoot: string): string {
  const iosRoot = join(mobileRoot, "ios");
  if (!existsSync(iosRoot)) {
    throw new MissingGeneratedProjectError("apps/mobile/ios does not exist — run a prebuild first");
  }
  const candidates = readdirSync(iosRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".xcodeproj"))
    .filter((entry) => existsSync(join(iosRoot, entry.name, "Info.plist")));
  if (candidates.length !== 1) {
    throw new MissingGeneratedProjectError(
      `expected exactly one generated iOS app directory, found ${candidates.length}`,
    );
  }
  return join(iosRoot, candidates[0].name);
}

function iosProjectFile(mobileRoot: string): string {
  const iosRoot = join(mobileRoot, "ios");
  const projects = readdirSync(iosRoot).filter((name) => name.endsWith(".xcodeproj"));
  if (projects.length !== 1) {
    throw new MissingGeneratedProjectError(
      `expected exactly one .xcodeproj, found ${projects.length}`,
    );
  }
  return join(iosRoot, projects[0], "project.pbxproj");
}

/**
 * Resolves the `android:foregroundServiceType` that actually applies to Expo's
 * location service. The app manifest usually stays silent because the value is
 * contributed by `expo-location`'s own library manifest during the Gradle
 * merge, so both sources are consulted.
 */
export async function resolveLocationServiceForegroundType(
  appManifest: AndroidManifestLike,
  libraryManifestPaths: string[],
): Promise<string | undefined> {
  const fromApp = (appManifest.manifest.application ?? [])
    .flatMap((application) => application.service ?? [])
    .find((service) => EXPO_LOCATION_SERVICE_NAMES.includes(service.$["android:name"]));
  if (fromApp?.$["android:foregroundServiceType"]) {
    return fromApp.$["android:foregroundServiceType"];
  }

  for (const path of libraryManifestPaths) {
    if (!existsSync(path)) continue;
    const parsed = (await XML.readXMLAsync({ path })) as unknown as AndroidManifestLike;
    const service = (parsed.manifest.application ?? [])
      .flatMap((application) => application.service ?? [])
      // Library manifests use the relative `.services.LocationTaskService` form.
      .find((candidate) =>
        EXPO_LOCATION_SERVICE_NAMES.some((name) => name.endsWith(candidate.$["android:name"])),
      );
    if (service?.$["android:foregroundServiceType"]) {
      return service.$["android:foregroundServiceType"];
    }
  }
  return undefined;
}

export async function readGeneratedNativeSurface(
  mobileRoot: string,
  libraryManifestPaths: string[],
): Promise<GeneratedNativeSurface> {
  const appDirectory = iosAppDirectory(mobileRoot);
  const infoPlist = plist.parse(readText(join(appDirectory, "Info.plist"))) as Record<
    string,
    unknown
  >;
  const entitlementsPath = readdirSync(appDirectory).find((name) => name.endsWith(".entitlements"));
  const entitlements = entitlementsPath
    ? (plist.parse(readText(join(appDirectory, entitlementsPath))) as Record<string, unknown>)
    : {};

  const androidManifest = (await XML.readXMLAsync({
    path: join(mobileRoot, "android/app/src/main/AndroidManifest.xml"),
  })) as unknown as AndroidManifestLike;

  return {
    infoPlist,
    entitlements,
    pbxproj: readText(iosProjectFile(mobileRoot)),
    podfileProperties: JSON.parse(readText(join(mobileRoot, "ios/Podfile.properties.json"))),
    androidManifest,
    networkSecurityConfig: readText(
      join(mobileRoot, "android/app/src/main/res/xml/network_security_config.xml"),
    ),
    gradleProperties: readText(join(mobileRoot, "android/gradle.properties")),
    locationServiceForegroundType: await resolveLocationServiceForegroundType(
      androidManifest,
      libraryManifestPaths,
    ),
  };
}

/** Locates `expo-location`'s library manifest through normal module resolution. */
export function expoLocationManifestPaths(fromDirectory: string): string[] {
  try {
    const require = createRequire(join(fromDirectory, "package.json"));
    const packageJson = require.resolve("expo-location/package.json");
    return [join(packageJson, "../android/src/main/AndroidManifest.xml")];
  } catch {
    return [];
  }
}
