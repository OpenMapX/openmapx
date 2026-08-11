import { describe, expect, it } from "vitest";
import {
  type BuildManifestInput,
  buildReleaseManifest,
  findSecretsInManifest,
  inputsMatch,
  sha256,
} from "./release-manifest";

const INPUT: BuildManifestInput = {
  nowMs: 1_700_000_000_000,
  git: { commit: "abc123def456", tag: "mobile-v1.0.0", dirty: false },
  version: {
    marketingVersion: "1.0.0",
    iosBuildNumber: "1",
    androidVersionCode: 1,
    protocol: { min: 1, max: 2 },
    channel: "beta",
  },
  identity: { appId: "org.openmapx.app", scheme: "openmapx", origin: "https://openmapx.com" },
  toolchains: { node: "24.5.0", xcode: "26.4" },
  locks: [{ path: "native-locks/ios/Podfile.lock", sha256: "a".repeat(64), bytes: 100 }],
  generatedNativeHash: "71267f0fc2bd7ddd",
  permissionsSource: "permissions",
  dataPracticesSource: "practices",
  publicSigning: { appleTeamId: "ABCDE12345", playAppSigningSha256: "AA:BB" },
  artifacts: [{ path: "dist/mobile/1.0.0/app-release.aab", sha256: "b".repeat(64), bytes: 1000 }],
};

describe("buildReleaseManifest", () => {
  it("records the commit that describes what was built", () => {
    expect(buildReleaseManifest(INPUT).git.commit).toBe("abc123def456");
  });

  it("hashes the surfaces rather than embedding them", () => {
    const manifest = buildReleaseManifest(INPUT);

    expect(manifest.surfaces.permissionsSha256).toBe(sha256("permissions"));
    expect(manifest.surfaces.dataPracticesSha256).toBe(sha256("practices"));
  });

  it("records artifact hashes", () => {
    expect(buildReleaseManifest(INPUT).artifacts[0].sha256).toBe("b".repeat(64));
  });
});

describe("findSecretsInManifest", () => {
  it("passes a clean manifest", () => {
    expect(findSecretsInManifest(buildReleaseManifest(INPUT))).toEqual([]);
  });

  it.each([
    { label: "a keystore path in an artifact", field: "artifacts" },
    { label: "a keystore path in a toolchain string", field: "toolchains" },
  ])("catches $label", ({ field }) => {
    const contaminated = buildReleaseManifest(
      field === "artifacts"
        ? {
            ...INPUT,
            artifacts: [
              { path: "/Users/me/openmapx-upload.jks", sha256: "c".repeat(64), bytes: 1 },
            ],
          }
        : { ...INPUT, toolchains: { ...INPUT.toolchains, signing: "/secrets/dist.p12" } },
    );

    // The mistake is a path arriving inside a field nobody thought to check.
    expect(findSecretsInManifest(contaminated).length).toBeGreaterThan(0);
  });

  it("catches private key material", () => {
    const contaminated = buildReleaseManifest({
      ...INPUT,
      git: { ...INPUT.git, tag: "-----BEGIN PRIVATE KEY-----" },
    });

    expect(findSecretsInManifest(contaminated)).toContain("BEGIN PRIVATE KEY");
  });

  it("catches a signing password field", () => {
    const contaminated = buildReleaseManifest({
      ...INPUT,
      toolchains: { ...INPUT.toolchains, storePassword: "hunter2" },
    });

    expect(findSecretsInManifest(contaminated)).toContain("storePassword");
  });
});

describe("inputsMatch", () => {
  it("treats two builds from identical inputs as equivalent", () => {
    const first = buildReleaseManifest(INPUT);
    const second = buildReleaseManifest({
      ...INPUT,
      nowMs: INPUT.nowMs + 60_000,
      // A signed archive differs between runs; expecting otherwise would make
      // this check permanently red.
      artifacts: [{ path: INPUT.artifacts[0].path, sha256: "d".repeat(64), bytes: 1001 }],
    });

    expect(inputsMatch(first, second)).toBe(true);
  });

  it("notices a different commit", () => {
    const other = buildReleaseManifest({ ...INPUT, git: { ...INPUT.git, commit: "999999999999" } });

    expect(inputsMatch(buildReleaseManifest(INPUT), other)).toBe(false);
  });

  it("notices a changed native surface", () => {
    const other = buildReleaseManifest({ ...INPUT, generatedNativeHash: "different" });

    expect(inputsMatch(buildReleaseManifest(INPUT), other)).toBe(false);
  });

  it("notices a changed permission surface", () => {
    const other = buildReleaseManifest({ ...INPUT, permissionsSource: "permissions + camera" });

    expect(inputsMatch(buildReleaseManifest(INPUT), other)).toBe(false);
  });

  it("notices a changed dependency lock", () => {
    const other = buildReleaseManifest({
      ...INPUT,
      locks: [{ path: INPUT.locks[0].path, sha256: "e".repeat(64), bytes: 100 }],
    });

    expect(inputsMatch(buildReleaseManifest(INPUT), other)).toBe(false);
  });
});
