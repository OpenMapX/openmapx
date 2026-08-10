import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateFeasibilityReport } from "./validateReport";

const VALID = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/feasibility-report.valid.json"), "utf8"),
);

type Report = Record<string, unknown>;

const withReport = (mutate: (report: Report) => void): Report => {
  const report = structuredClone(VALID) as Report;
  mutate(report);
  return report;
};

describe("valid evidence", () => {
  it("accepts the committed simulator fixture", () => {
    expect(validateFeasibilityReport(VALID)).toEqual({ ok: true, errors: [] });
  });

  it("accepts a physical report that claims a physical pass", () => {
    const report = withReport((value) => {
      value.evidenceSource = "physical";
      value.conclusion = "physical-pass";
      value.runtime = { platform: "android", osVersion: "16", deviceFamily: "Pixel 9" };
      value.hardwareObservations = Object.fromEntries(
        Object.keys(VALID.hardwareObservations).map((key) => [key, "pass"]),
      );
    });
    expect(validateFeasibilityReport(report).ok).toBe(true);
  });
});

describe("evidence source honesty", () => {
  it.each(["simulator", "emulator"])(
    "refuses a physical-pass conclusion from a %s run",
    (evidenceSource) => {
      const result = validateFeasibilityReport(
        withReport((value) => {
          value.evidenceSource = evidenceSource;
          value.conclusion = "physical-pass";
        }),
      );
      expect(result.ok).toBe(false);
    },
  );

  it.each(["pass", "fail"])(
    "refuses a virtual run that reports a hardware-only observation as %s",
    (observation) => {
      const result = validateFeasibilityReport(
        withReport((value) => {
          (value.hardwareObservations as Report).lockedScreenDelivery = observation;
        }),
      );
      expect(result.ok).toBe(false);
    },
  );

  it("allows a virtual run to record recovery outcomes it really did observe", () => {
    const result = validateFeasibilityReport(
      withReport((value) => {
        (value.recovery as Report).webViewReload = "pass";
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("requires every hardware observation to be present", () => {
    const result = validateFeasibilityReport(
      withReport((value) => {
        delete (value.hardwareObservations as Report).batteryDrain;
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("closed shape", () => {
  it.each([
    ["a top-level extra field", (value: Report) => (value.route = "A to B")],
    [
      "a coordinate smuggled into runtime",
      (value: Report) => ((value.runtime as Report).latitude = 52.52),
    ],
    [
      "a nested extra field",
      (value: Report) => ((value.callbacks as Report).rawFixes = [[13.4, 52.5]]),
    ],
  ])("rejects %s", (_label, mutate) => {
    expect(validateFeasibilityReport(withReport(mutate)).ok).toBe(false);
  });

  it.each([
    ["coordinates", { coords: [13.4, 52.5] }],
    ["geometry", { geometry: "abc" }],
    ["a refresh token", { refreshToken: "secret" }],
    ["a cookie", { cookie: "session=1" }],
  ])("rejects a report carrying %s", (_label, extra) => {
    expect(validateFeasibilityReport({ ...VALID, ...extra }).ok).toBe(false);
  });

  it("rejects a tester identifier that looks like an account", () => {
    const result = validateFeasibilityReport(
      withReport((value) => {
        value.notes = "reported by tester@example.com";
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("forbidden content");
  });
});

describe("field bounds", () => {
  it.each([
    ["a malformed report id", (value: Report) => (value.reportId = "Has Spaces")],
    ["a non-semver app version", (value: Report) => ((value.build as Report).appVersion = "1.0")],
    ["an unknown platform", (value: Report) => ((value.runtime as Report).platform = "web")],
    ["an unknown driver", (value: Report) => (value.driver = "corelocation")],
    ["an unknown trace kind", (value: Report) => ((value.trace as Report).kind = "flight")],
    [
      "a negative callback count",
      (value: Report) => ((value.callbacks as Report).deliveredCount = -1),
    ],
    [
      "an implausible trace duration",
      (value: Report) => ((value.trace as Report).durationSeconds = 999_999),
    ],
    ["a wrong schema version", (value: Report) => (value.schemaVersion = 2)],
    ["an unknown conclusion", (value: Report) => (value.conclusion = "looks-fine")],
  ])("rejects %s", (_label, mutate) => {
    expect(validateFeasibilityReport(withReport(mutate)).ok).toBe(false);
  });

  it("reports every problem at once rather than only the first", () => {
    const result = validateFeasibilityReport(
      withReport((value) => {
        value.reportId = "Has Spaces";
        value.driver = "corelocation";
      }),
    );
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects a value that is not an object at all", () => {
    for (const value of [null, undefined, 42, "report", []]) {
      expect(validateFeasibilityReport(value).ok).toBe(false);
    }
  });
});
