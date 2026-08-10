import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blocksPublicRollout,
  HARDWARE_RISKS,
  parseLocationDriverDecision,
} from "./locationDriverDecision";

const PROVISIONAL = {
  decision: "expo-location-provisional",
  selectedDriver: "expo",
  evidenceLevel: "automated-and-simulated",
  decidedAt: "2026-08-10T12:00:00.000Z",
  decisionSource: "maintainer-approved-assumption",
  runbookPath: "docs/docs/developer/mobile-feasibility.md",
  automatedCommands: [
    "pnpm mobile:verify",
    "pnpm mobile:prebuild:check",
    "pnpm mobile:bundle:check",
  ],
  virtualBuilds: {
    iosSimulatorBuildId: "local-ios-release-1",
    androidEmulatorBuildId: "local-android-release-1",
  },
  unverifiedRisks: [...HARDWARE_RISKS],
  publicRolloutBlockedUntil: "volunteer-beta-device-matrix",
};

const BETA_QUALIFIED = {
  decision: "beta-qualified",
  selectedDriver: "expo",
  evidenceLevel: "physical-volunteer-beta",
  decidedAt: "2026-08-10T12:00:00.000Z",
  qualifiedAt: "2026-09-01T12:00:00.000Z",
  runbookPath: "docs/docs/developer/mobile-feasibility.md",
  evidenceReports: {
    ios: "apps/mobile/qa/results/beta/1.0.0-ios.json",
    pixel: "apps/mobile/qa/results/beta/1.0.0-pixel.json",
    samsung: "apps/mobile/qa/results/beta/1.0.0-samsung.json",
  },
  resolvedRisks: [...HARDWARE_RISKS],
  unverifiedRisks: [],
  publicRolloutBlockedUntil: null,
};

const withProvisional = (patch: Record<string, unknown>) => ({ ...PROVISIONAL, ...patch });
const withBeta = (patch: Record<string, unknown>) => ({ ...BETA_QUALIFIED, ...patch });

describe("the provisional decision", () => {
  it("accepts the honest initial state", () => {
    const decision = parseLocationDriverDecision(PROVISIONAL);
    expect(decision.decision).toBe("expo-location-provisional");
    expect(blocksPublicRollout(decision)).toBe(true);
  });

  it("rejects an empty risk list", () => {
    expect(() => parseLocationDriverDecision(withProvisional({ unverifiedRisks: [] }))).toThrow();
  });

  it("rejects a shortened risk list", () => {
    expect(() =>
      parseLocationDriverDecision(withProvisional({ unverifiedRisks: HARDWARE_RISKS.slice(1) })),
    ).toThrow();
  });

  it("rejects a duplicated risk padding the list to full length", () => {
    const padded = [...HARDWARE_RISKS.slice(1), HARDWARE_RISKS[1]];
    expect(() =>
      parseLocationDriverDecision(withProvisional({ unverifiedRisks: padded })),
    ).toThrow();
  });

  it("rejects an invented risk name", () => {
    expect(() =>
      parseLocationDriverDecision(
        withProvisional({ unverifiedRisks: [...HARDWARE_RISKS.slice(1), "everything-is-fine"] }),
      ),
    ).toThrow();
  });

  it.each(["verified", "physical-volunteer-beta", "device-tested"])(
    "rejects the evidence level %s, which the automated gate cannot establish",
    (evidenceLevel) => {
      expect(() => parseLocationDriverDecision(withProvisional({ evidenceLevel }))).toThrow();
    },
  );

  it("rejects a native driver before any beta evidence exists", () => {
    expect(() =>
      parseLocationDriverDecision(withProvisional({ selectedDriver: "native" })),
    ).toThrow();
  });

  it("rejects an unblocked public rollout", () => {
    expect(() =>
      parseLocationDriverDecision(withProvisional({ publicRolloutBlockedUntil: null })),
    ).toThrow();
  });

  it("requires the committed runbook path, not an ignored plan document", () => {
    expect(() =>
      parseLocationDriverDecision(
        withProvisional({ runbookPath: "docs/superpowers/plans/2026-08-09-expo-cng-mobile-00.md" }),
      ),
    ).toThrow();
  });

  it("requires at least three automated commands", () => {
    expect(() =>
      parseLocationDriverDecision(withProvisional({ automatedCommands: ["pnpm mobile:verify"] })),
    ).toThrow();
  });

  it("requires both virtual build identifiers", () => {
    expect(() =>
      parseLocationDriverDecision(
        withProvisional({ virtualBuilds: { iosSimulatorBuildId: "local-ios-release-1" } }),
      ),
    ).toThrow();
  });

  it("rejects an unknown extra field", () => {
    expect(() =>
      parseLocationDriverDecision(withProvisional({ physicallyVerified: true })),
    ).toThrow();
  });

  it.each(["not-a-date", "2026-08-10", 1_700_000_000_000])(
    "rejects the malformed timestamp %p",
    (decidedAt) => {
      expect(() => parseLocationDriverDecision(withProvisional({ decidedAt }))).toThrow();
    },
  );
});

describe("the beta-qualified decision", () => {
  it("accepts a fully evidenced resolution", () => {
    const decision = parseLocationDriverDecision(BETA_QUALIFIED);
    expect(decision.decision).toBe("beta-qualified");
    expect(blocksPublicRollout(decision)).toBe(false);
  });

  it("accepts the native driver once beta evidence justifies it", () => {
    expect(() => parseLocationDriverDecision(withBeta({ selectedDriver: "native" }))).not.toThrow();
  });

  it.each(["ios", "pixel", "samsung"])("requires the %s family report", (family) => {
    const reports = { ...BETA_QUALIFIED.evidenceReports } as Record<string, string>;
    delete reports[family];
    expect(() => parseLocationDriverDecision(withBeta({ evidenceReports: reports }))).toThrow();
  });

  it("rejects a report path outside the sanitized beta results directory", () => {
    expect(() =>
      parseLocationDriverDecision(
        withBeta({
          evidenceReports: { ...BETA_QUALIFIED.evidenceReports, ios: "/tmp/whatever.json" },
        }),
      ),
    ).toThrow();
  });

  it("rejects a report path without a concrete marketing version", () => {
    expect(() =>
      parseLocationDriverDecision(
        withBeta({
          evidenceReports: {
            ...BETA_QUALIFIED.evidenceReports,
            pixel: "apps/mobile/qa/results/beta/latest-pixel.json",
          },
        }),
      ),
    ).toThrow();
  });

  it("rejects a leftover unverified risk", () => {
    expect(() =>
      parseLocationDriverDecision(withBeta({ unverifiedRisks: ["battery-drain"] })),
    ).toThrow();
  });

  it("rejects an incomplete resolved-risk list", () => {
    expect(() =>
      parseLocationDriverDecision(withBeta({ resolvedRisks: HARDWARE_RISKS.slice(2) })),
    ).toThrow();
  });

  it("rejects a rollout that is still blocked", () => {
    expect(() =>
      parseLocationDriverDecision(
        withBeta({ publicRolloutBlockedUntil: "volunteer-beta-device-matrix" }),
      ),
    ).toThrow();
  });

  it("rejects simulator evidence dressed as a beta qualification", () => {
    expect(() =>
      parseLocationDriverDecision(withBeta({ evidenceLevel: "automated-and-simulated" })),
    ).toThrow();
  });
});

describe("malformed input", () => {
  it.each([null, undefined, 42, "provisional", [], {}])("rejects %p", (value) => {
    expect(() => parseLocationDriverDecision(value)).toThrow();
  });

  it("rejects an unknown decision discriminant", () => {
    expect(() =>
      parseLocationDriverDecision(withProvisional({ decision: "looks-fine" })),
    ).toThrow();
  });
});

describe("the committed record", () => {
  it("parses and still blocks public rollout", () => {
    const committed = JSON.parse(
      readFileSync(join(import.meta.dirname, "assumptions/location-driver.json"), "utf8"),
    );
    const decision = parseLocationDriverDecision(committed);
    expect(decision.decision).toBe("expo-location-provisional");
    expect(blocksPublicRollout(decision)).toBe(true);
  });
});
