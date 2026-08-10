import { describe, expect, it } from "vitest";
import {
  decideDoctorOutcome,
  isReleaseAgeBlockedUpgrade,
  parseDoctorFindings,
  parseOutOfDatePackages,
  type ReleaseAgeContext,
  SDK_VERSION_CHECK,
} from "./doctorPolicy";

const NOW = new Date("2026-08-10T18:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const SDK_DETAIL = `
🔧 Patch version mismatches
package             expected   found
expo-location       ~57.0.9    57.0.8
expo-task-manager   ~57.0.9    57.0.8

2 packages out of date.
Advice:
Use 'npx expo install --check' to review and upgrade your dependencies.`;

const sdkFinding = (detail = SDK_DETAIL) => ({ title: SDK_VERSION_CHECK, detail });

function context(overrides: Partial<ReleaseAgeContext> = {}): ReleaseAgeContext {
  return {
    // Both published three hours ago: inside the 24-hour window.
    publishedAt: new Map([
      ["expo-location", new Date("2026-08-10T15:00:00.000Z")],
      ["expo-task-manager", new Date("2026-08-10T15:00:00.000Z")],
    ]),
    minimumReleaseAgeMs: DAY_MS,
    now: NOW,
    ...overrides,
  };
}

const output = (blocks: string[]) =>
  ["Running 20 checks on your project...", ...blocks, "1 check failed."].join("\n");

describe("parseDoctorFindings", () => {
  it("finds nothing in a clean run", () => {
    expect(parseDoctorFindings("Running 20 checks...\nAll checks passed")).toEqual([]);
  });

  it("captures a failure and its detail", () => {
    const findings = parseDoctorFindings(output([`✖ ${SDK_VERSION_CHECK}\n${SDK_DETAIL}`]));
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe(SDK_VERSION_CHECK);
    expect(findings[0].detail).toContain("expo-location");
  });

  it("separates several failures", () => {
    const findings = parseDoctorFindings(
      output([
        `✖ ${SDK_VERSION_CHECK}\n${SDK_DETAIL}`,
        "✖ Check for issues with Metro config\n- bad",
      ]),
    );
    expect(findings.map((f) => f.title)).toEqual([
      SDK_VERSION_CHECK,
      "Check for issues with Metro config",
    ]);
  });
});

describe("parseOutOfDatePackages", () => {
  it("reads the version table", () => {
    expect(parseOutOfDatePackages(SDK_DETAIL)).toEqual([
      { name: "expo-location", expected: "~57.0.9", found: "57.0.8" },
      { name: "expo-task-manager", expected: "~57.0.9", found: "57.0.8" },
    ]);
  });

  it("skips the header row and prose", () => {
    expect(parseOutOfDatePackages("package expected found\nAdvice: do something")).toEqual([]);
  });

  it("handles scoped package names", () => {
    expect(parseOutOfDatePackages("@types/react   19.2.18   19.2.0")).toEqual([
      { name: "@types/react", expected: "19.2.18", found: "19.2.0" },
    ]);
  });
});

describe("the release-age tolerance", () => {
  it("tolerates upgrades the workspace policy currently forbids", () => {
    expect(isReleaseAgeBlockedUpgrade(sdkFinding(), context())).toBe(true);
  });

  it("refuses once the newer version is installable", () => {
    // Same finding, but the releases are now two days old.
    const older = new Map([
      ["expo-location", new Date("2026-08-08T15:00:00.000Z")],
      ["expo-task-manager", new Date("2026-08-08T15:00:00.000Z")],
    ]);
    expect(isReleaseAgeBlockedUpgrade(sdkFinding(), context({ publishedAt: older }))).toBe(false);
  });

  it("refuses when even one listed package is genuinely stale", () => {
    const mixed = new Map([
      ["expo-location", new Date("2026-08-10T15:00:00.000Z")],
      ["expo-task-manager", new Date("2026-06-01T00:00:00.000Z")],
    ]);
    expect(isReleaseAgeBlockedUpgrade(sdkFinding(), context({ publishedAt: mixed }))).toBe(false);
  });

  it("refuses when a publish date could not be determined", () => {
    const unknown = new Map([
      ["expo-location", new Date("2026-08-10T15:00:00.000Z")],
      ["expo-task-manager", null],
    ]);
    expect(isReleaseAgeBlockedUpgrade(sdkFinding(), context({ publishedAt: unknown }))).toBe(false);
  });

  it("refuses a finding with no parsable package table", () => {
    expect(isReleaseAgeBlockedUpgrade(sdkFinding("something went wrong"), context())).toBe(false);
  });

  it("never tolerates a different check, whatever its detail", () => {
    expect(
      isReleaseAgeBlockedUpgrade(
        { title: "Check for issues with Metro config", detail: SDK_DETAIL },
        context(),
      ),
    ).toBe(false);
  });

  it.each([
    "Check that no duplicate dependencies are installed",
    "Check Expo config for common issues",
    "Check for app config fields that may not be synced in a non-CNG project",
  ])("never tolerates the %s finding", (title) => {
    expect(isReleaseAgeBlockedUpgrade({ title, detail: SDK_DETAIL }, context())).toBe(false);
  });
});

describe("decideDoctorOutcome", () => {
  it("passes a clean run", () => {
    expect(decideDoctorOutcome("All checks passed", context())).toEqual({
      ok: true,
      blocking: [],
      tolerated: [],
    });
  });

  it("passes when the only failure is a release-age-blocked upgrade", () => {
    const decision = decideDoctorOutcome(
      output([`✖ ${SDK_VERSION_CHECK}\n${SDK_DETAIL}`]),
      context(),
    );
    expect(decision.ok).toBe(true);
    expect(decision.tolerated).toHaveLength(1);
  });

  it("fails on any other finding alongside it", () => {
    const decision = decideDoctorOutcome(
      output([
        `✖ ${SDK_VERSION_CHECK}\n${SDK_DETAIL}`,
        "✖ Check Expo config for common issues\n- stray app.json",
      ]),
      context(),
    );
    expect(decision.ok).toBe(false);
    expect(decision.blocking.map((f) => f.title)).toEqual(["Check Expo config for common issues"]);
  });

  it("fails when the upgrade is genuinely overdue", () => {
    const stale = new Map([
      ["expo-location", new Date("2026-01-01T00:00:00.000Z")],
      ["expo-task-manager", new Date("2026-01-01T00:00:00.000Z")],
    ]);
    const decision = decideDoctorOutcome(
      output([`✖ ${SDK_VERSION_CHECK}\n${SDK_DETAIL}`]),
      context({ publishedAt: stale }),
    );
    expect(decision.ok).toBe(false);
  });
});
