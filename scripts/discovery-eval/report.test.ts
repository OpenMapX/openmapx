import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareReports, createReport, type EvalCase, type EvidenceMetadata } from "./report.js";
import { buildReviewedEvidence, readManifest } from "./reviewed.js";

const cases: EvalCase[] = [
  { id: "station", layer: "client-ranking", suite: "search.test.ts", assertions: ["station rank"] },
  { id: "offline-search", layer: "installed-device", unavailable: "Not implemented" },
];
const metadata: EvidenceMetadata = {
  appRevision: "a".repeat(40),
  workingTreeDirty: false,
  inputHashes: { "fixture/station.json": "1" },
  captureProvenance: { legacyFixtures: 1, adaptedApiCaptures: 0 },
};
function input(status = "passed", name = "station rank") {
  return {
    success: status === "passed",
    testResults: [
      {
        name: "/repo/search.test.ts",
        status: status === "failed" ? "failed" : "passed",
        assertionResults: [
          { fullName: name, status, failureMessages: ["potentially sensitive stack"] },
        ],
      },
    ],
  };
}

describe("versioned discovery evidence reports", () => {
  it("keeps unsupported capabilities unavailable and omits failure details", () => {
    const report = createReport(input(), cases, metadata, "/repo");
    expect(report.cases[0]).toMatchObject({ id: "station", status: "passed", passed: 1 });
    expect(report.cases[1]).toMatchObject({ id: "offline-search", status: "unavailable" });
    expect(JSON.stringify(report)).not.toContain("sensitive");
  });

  it.each(["skipped", "pending", "todo"])("does not turn %s assertions into success", (status) => {
    expect(createReport(input(status), cases, metadata, "/repo").cases[0].status).toBe(
      "unavailable",
    );
  });

  it("does not pass missing assertions or collection failures", () => {
    expect(
      createReport(input("passed", "other test"), cases, metadata, "/repo").cases[0].status,
    ).toBe("unavailable");
    const failedCollection = input();
    failedCollection.testResults[0].status = "failed";
    failedCollection.testResults[0].assertionResults = [];
    expect(createReport(failedCollection, cases, metadata, "/repo").cases[0].status).toBe("failed");
  });

  it("keeps an independently passing case intact when a different assertion fails", () => {
    const evidence = input();
    evidence.success = false;
    evidence.testResults[0].status = "failed";
    evidence.testResults[0].assertionResults.push({
      fullName: "different case",
      status: "failed",
      failureMessages: [],
    });
    const report = createReport(evidence, cases, metadata, "/repo");
    expect(report.cases[0].status).toBe("passed");
    expect(report.runSucceeded).toBe(false);
  });

  it("reports guarded known gaps separately from passing semantic expectations", () => {
    const report = createReport(
      input(),
      [{ ...cases[0], knownGap: "Expected station missing in recorded data" }],
      metadata,
      "/repo",
    );
    expect(report.cases[0]).toMatchObject({
      status: "known-gap",
      reason: "Expected station missing in recorded data",
    });
    expect(report.runSucceeded).toBe(true);
  });

  it("detects a failed expected result independently of changing input fingerprints", () => {
    const before = createReport(input(), cases, metadata, "/repo");
    const after = createReport(
      input("failed"),
      cases,
      { ...metadata, inputHashes: { "fixture/station.json": "2" } },
      "/repo",
    );
    expect(compareReports(before, after)).toMatchObject({
      regressions: ["station"],
      improvements: [],
      changedInputs: ["fixture/station.json"],
      appOnlyComparison: false,
    });
  });

  it("rejects omitted assertions even when a shortened suite passes", () => {
    const evidence = input();
    evidence.testResults[0].assertionResults.push({
      fullName: "GPS recovery",
      status: "passed",
      failureMessages: [],
    });
    const wholeSuite = [{ id: "navigation", layer: "synthetic", suite: "search.test.ts" }];
    const before = createReport(evidence, wholeSuite, metadata, "/repo");
    const after = createReport(input(), wholeSuite, metadata, "/repo");
    expect(() => compareReports(before, after)).toThrow("assertion inventory");
  });

  it.each([
    { passed: 0, failed: 7, unavailable: 0 },
    { passed: 0, failed: 0, unavailable: 0 },
    { passed: 1, failed: 0, unavailable: 1 },
  ])("rejects contradictory passing counts %j", (counts) => {
    const report = createReport(input(), cases, metadata, "/repo");
    const broken = { ...report, cases: [{ ...report.cases[0], ...counts }, report.cases[1]] };
    expect(() => compareReports(broken, report)).toThrow("report");
  });

  it("rejects malformed baseline reports and mismatched case sets", () => {
    const report = createReport(input(), cases, metadata, "/repo");
    expect(() => compareReports({} as typeof report, report)).toThrow("report");
    expect(() => compareReports({ ...report, cases: [] }, report)).toThrow("case set");
    expect(() =>
      compareReports({ ...report, cases: [report.cases[0], report.cases[0]] }, report),
    ).toThrow("report");
  });

  it("rejects comparisons across protocol, catalog or budget changes", () => {
    const before = createReport(input(), cases, metadata, "/repo");
    expect(() => compareReports(before, { ...before, protocolVersion: 3 })).toThrow("protocol");
    const changed = createReport(
      input(),
      [{ ...cases[0], assertions: ["different budget"] }],
      metadata,
      "/repo",
    );
    expect(() => compareReports(before, changed)).toThrow("catalog");
  });

  it.each([null, {}, { success: true, testResults: [{ name: "/repo/search.test.ts" }] }])(
    "rejects malformed test evidence %j",
    (evidence) => {
      expect(() => createReport(evidence, cases, metadata, "/repo")).toThrow("test evidence");
    },
  );
  it("retains layer-specific unavailable judgments in the generated report", () => {
    const report = createReport(input(), cases, metadata, "/repo");
    expect(report.reviewed.unavailable).toContainEqual({
      caseId: "business/edeka-alexa",
      layer: "provider",
    });
    expect(
      report.reviewed.definitions.find((entry) => entry.id === "business/edeka-alexa")?.entities[0]
        .label,
    ).toBe("EDEKA");
  });

  it("rejects tampered numerical evidence in a baseline", () => {
    const report = createReport(input(), cases, metadata, "/repo");
    const changed = {
      ...report,
      reviewed: { ...buildReviewedEvidence(null), results: [{ status: "passed" }] },
    };
    expect(() => compareReports(changed, report)).toThrow("report");
  });
  it("rejects array-valued status fields in supplied test evidence and baselines", () => {
    const evidence = input();
    expect(() =>
      createReport(
        { ...evidence, testResults: [{ ...evidence.testResults[0], status: ["passed"] }] },
        cases,
        metadata,
        "/repo",
      ),
    ).toThrow("test evidence");
    const report = createReport(input(), cases, metadata, "/repo");
    expect(() =>
      compareReports(
        { ...report, cases: [{ ...report.cases[0], status: ["passed"] }, report.cases[1]] },
        report,
      ),
    ).toThrow("report");
  });
  it("does not infer an application-only change from external recorded observations with unknown deployment", () => {
    const manifest = readManifest(
      JSON.parse(readFileSync(new URL("./examples/control-before.json", import.meta.url), "utf8")),
    );
    for (const entry of manifest.observations) entry.kind = "recorded";
    const report = createReport(input(), cases, metadata, "/repo", manifest);
    expect(compareReports(report, report).appOnlyComparison).toBe(false);
  });
});
