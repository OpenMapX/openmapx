/**
 * Validating the release inputs before anything is built.
 *
 * A release has exactly one source of version numbers, and it is a committed
 * file rather than the clock, the branch name, or a CI counter. That choice is
 * what makes the interesting check possible: comparing this release against the
 * last one and refusing a rollback. A version derived from the current time
 * always looks newer than the last, so it can never catch anything.
 *
 * The rules below are the ones a store enforces anyway, discovered locally in a
 * second instead of an hour into an upload.
 */

export interface ProtocolRange {
  min: number;
  max: number;
}

export interface ReleaseVersion {
  marketingVersion: string;
  iosBuildNumber: string;
  androidVersionCode: number;
  androidVersionName: string;
  protocol: ProtocolRange;
  minimumWebBuild: string | null;
  channel: "beta" | "production";
}

export interface ToolchainPins {
  node: string;
  pnpm: string;
  expoSdk: string;
  reactNative: string;
  ios: { xcode: string; deploymentTarget: string };
  android: { javaMajor: number[]; minSdk: number; compileSdk: number; targetSdk: number };
}

export interface ValidationIssue {
  field: string;
  message: string;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Checks one release descriptor in isolation. */
export function validateReleaseVersion(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!value || typeof value !== "object") {
    return [{ field: "version.json", message: "is not an object" }];
  }
  const version = value as Partial<ReleaseVersion>;

  if (typeof version.marketingVersion !== "string" || !SEMVER.test(version.marketingVersion)) {
    issues.push({ field: "marketingVersion", message: "must be a plain SemVer x.y.z" });
  }

  const iosBuild = Number(version.iosBuildNumber);
  if (typeof version.iosBuildNumber !== "string" || !Number.isInteger(iosBuild) || iosBuild <= 0) {
    issues.push({
      field: "iosBuildNumber",
      message: "must be a positive whole number as a string",
    });
  }

  if (!Number.isInteger(version.androidVersionCode) || (version.androidVersionCode ?? 0) <= 0) {
    issues.push({ field: "androidVersionCode", message: "must be a positive integer" });
  }
  // Play caps this, and hitting the cap is unrecoverable for the listing.
  if ((version.androidVersionCode ?? 0) > 2_100_000_000) {
    issues.push({ field: "androidVersionCode", message: "exceeds the value Play accepts" });
  }

  if (version.androidVersionName !== version.marketingVersion) {
    issues.push({
      field: "androidVersionName",
      message: "must equal marketingVersion, so the two stores show the same number",
    });
  }

  const protocol = version.protocol;
  if (!protocol || !Number.isInteger(protocol.min) || !Number.isInteger(protocol.max)) {
    issues.push({ field: "protocol", message: "needs integer min and max" });
  } else if (protocol.min > protocol.max) {
    issues.push({ field: "protocol", message: "min is above max, so nothing can negotiate" });
  } else if (protocol.min < 1) {
    issues.push({ field: "protocol", message: "min must be at least 1" });
  }

  if (version.channel !== "beta" && version.channel !== "production") {
    issues.push({ field: "channel", message: 'must be "beta" or "production"' });
  }

  if (version.minimumWebBuild !== null && typeof version.minimumWebBuild !== "string") {
    issues.push({ field: "minimumWebBuild", message: "must be a build id or null" });
  }

  return issues;
}

/**
 * Checks this release against the last one that shipped.
 *
 * Every rule here exists because the store enforces it and reports it late. A
 * duplicate Android version code is rejected at upload; a lower iOS build number
 * is rejected at processing, after the archive has been made and transferred.
 */
export function compareWithPrevious(
  next: ReleaseVersion,
  previous: ReleaseVersion | null,
): ValidationIssue[] {
  if (!previous) return [];
  const issues: ValidationIssue[] = [];

  if (next.androidVersionCode <= previous.androidVersionCode) {
    issues.push({
      field: "androidVersionCode",
      message: `must exceed the previous ${previous.androidVersionCode}; Play refuses a duplicate or lower code`,
    });
  }

  if (Number(next.iosBuildNumber) <= Number(previous.iosBuildNumber)) {
    issues.push({
      field: "iosBuildNumber",
      message: `must exceed the previous ${previous.iosBuildNumber} for the same marketing version`,
    });
  }

  if (compareSemver(next.marketingVersion, previous.marketingVersion) < 0) {
    issues.push({
      field: "marketingVersion",
      message: `is below the previous ${previous.marketingVersion}; a rollback needs a new higher version, not an old one`,
    });
  }

  // Dropping support for a protocol version a deployed web build may still be
  // speaking strands every user who has not yet updated.
  if (next.protocol.min > previous.protocol.min) {
    issues.push({
      field: "protocol.min",
      message: `raises the minimum from ${previous.protocol.min}; deployed web builds speaking ${previous.protocol.min} would stop working`,
    });
  }

  return issues;
}

export function compareSemver(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0);
  }
  return 0;
}

export interface Environment {
  nodeMajor: number;
  javaMajor: number | null;
  origin: string;
  appId: string;
  dirtyTrackedFiles: string[];
}

/**
 * Checks the machine and the working tree.
 *
 * The dirty-tree rule is the one that matters most: a build made from
 * uncommitted changes cannot be reproduced, and the provenance manifest would
 * record a commit that does not describe what was built.
 */
export function validateEnvironment(
  environment: Environment,
  toolchains: ToolchainPins,
  version: ReleaseVersion,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const nodeFloor = Number(toolchains.node.replace(/[^\d.]/g, "").split(".")[0]);
  if (environment.nodeMajor < nodeFloor) {
    issues.push({ field: "node", message: `needs Node ${nodeFloor} or newer` });
  }

  if (
    environment.javaMajor !== null &&
    !toolchains.android.javaMajor.includes(environment.javaMajor)
  ) {
    issues.push({
      field: "java",
      message: `JDK ${environment.javaMajor} cannot build this project; use ${toolchains.android.javaMajor.join(" or ")}`,
    });
  }

  if (environment.dirtyTrackedFiles.length > 0) {
    issues.push({
      field: "worktree",
      message: `${environment.dirtyTrackedFiles.length} tracked file(s) modified; a release built from uncommitted changes cannot be reproduced`,
    });
  }

  if (!environment.origin.startsWith("https://")) {
    issues.push({ field: "origin", message: "a release must be built against an HTTPS origin" });
  }
  if (environment.origin.includes("localhost") || environment.origin.includes("127.0.0.1")) {
    issues.push({ field: "origin", message: "a release cannot be built against a local origin" });
  }
  if (environment.appId.endsWith(".dev") || environment.appId.includes("Dev")) {
    issues.push({
      field: "appId",
      message: `${environment.appId} is a development identifier; a release uses the official one`,
    });
  }

  if (version.channel === "production" && version.marketingVersion.startsWith("0.")) {
    issues.push({
      field: "channel",
      message: "a 0.x version is not a production release",
    });
  }

  return issues;
}
