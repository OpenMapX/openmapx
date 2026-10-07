import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, INPUT_FILES } from "./catalog.js";
import { parseOptions } from "./options.js";
import { compareReports, createReport, type EvalReport } from "./report.js";
import { readManifest } from "./reviewed.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function markdown(report: EvalReport, comparison: ReturnType<typeof compareReports> | null) {
  const counts = report.cases.reduce<Record<string, number>>((all, entry) => {
    all[entry.status] = (all[entry.status] ?? 0) + 1;
    return all;
  }, {});
  return [
    "# Discovery evaluation report",
    "",
    `Protocol: ${report.protocolVersion}; catalog: ${report.catalogHash}`,
    `Application: ${report.metadata.appRevision}; working tree dirty: ${report.metadata.workingTreeDirty}`,
    `Run succeeded: ${report.runSucceeded}; case counts: ${JSON.stringify(counts)}`,
    "",
    "Automated cases are offline recorded/synthetic/contract evidence. Optional reviewed observations retain their own live/recorded/synthetic provenance; absent layers and installed-device cases are unavailable. Assertion counts can overlap between cases; they are not independent observations or production performance metrics.",
    `Search capture provenance: ${report.metadata.captureProvenance.legacyFixtures} legacy fixtures with unknown provenance; ${report.metadata.captureProvenance.adaptedApiCaptures} explicitly adapted API captures. Legacy fixture deployment/source generations are unknown; optional operator context follows.`,
    "",
    ...(comparison
      ? [
          "## Comparison",
          "",
          `\`\`\`json\n${JSON.stringify(comparison, null, 2)}\n\`\`\``,
          "",
          "Changed inputs and dirty trees prevent an application-only comparison; comparisons do not establish causality.",
          "",
        ]
      : []),
    "| Case | Evidence layer | Status | Passed / failed / unavailable assertions | Reason |",
    "| --- | --- | --- | --- | --- |",
    ...report.cases.map(
      (entry) =>
        `| ${entry.id} | ${entry.layer} | ${entry.status} | ${entry.passed} / ${entry.failed} / ${entry.unavailable} | ${entry.reason ?? ""} |`,
    ),
    "",
    "## Independently reviewed observations",
    "",
    `Definitions and frozen pilot budgets: ${report.reviewed.definitionHash}; ${report.reviewed.unavailable.length} case/layer observations unavailable.`,
    "Raw upstream belongs to provider; adapted API/client ranking belongs to normalization; final readable UI belongs to presentation. A missing layer is not an inferred success.",
    "",
    `\`\`\`json\n${JSON.stringify(report.reviewed.manifest?.context ?? { unavailable: "No operator manifest supplied" }, null, 2)}\n\`\`\``,
    "",
    "| Case | Layer / stage | Provenance / cache | Status | Measured metrics |",
    "| --- | --- | --- | --- | --- |",
    ...report.reviewed.results.map(
      (entry) =>
        `| ${entry.caseId} | ${entry.layer} / ${entry.stage} | ${entry.kind} / ${entry.cache} | ${entry.status} | ${JSON.stringify(entry.metrics)} |`,
    ),
    "",
    "Absent layers (listed individually in report.json):",
    "",
    ...report.reviewed.unavailable.map((entry) => `- ${entry.caseId}: ${entry.layer}`),
    "",
  ].join("\n");
}
function main() {
  const config = parseOptions(process.argv.slice(2), root);
  const manifest = config.evidence
    ? readManifest(JSON.parse(readFileSync(config.evidence, "utf8")))
    : null;
  // Snapshot before output writes; reports cannot mark their own capture as dirty.
  const appRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const workingTreeDirty =
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "";
  const inputHashes = Object.fromEntries(
    INPUT_FILES.map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex"),
    ]),
  );
  const captureProvenance = { legacyFixtures: 0, adaptedApiCaptures: 0 };
  for (const path of INPUT_FILES.filter(
    (path) => path.includes("search-eval/fixtures/") && !path.endsWith("_shared.json"),
  )) {
    const fixture = JSON.parse(readFileSync(join(root, path), "utf8"));
    if (fixture.capture?.protocolVersion === 1 && fixture.capture?.layer === "adapted-api")
      captureProvenance.adaptedApiCaptures++;
    else captureProvenance.legacyFixtures++;
  }
  const temp = mkdtempSync(join(tmpdir(), "openmapx-discovery-"));
  try {
    const output = join(temp, "vitest.json");
    const suites = [...new Set(CATALOG.flatMap((entry) => (entry.suite ? [entry.suite] : [])))];
    const test = spawnSync(
      "pnpm",
      ["exec", "vitest", "run", ...suites, "--reporter=json", `--outputFile=${output}`],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? "4" },
      },
    );
    if (test.error) throw new Error("Could not start evaluation tests");
    const report = createReport(
      JSON.parse(readFileSync(output, "utf8")),
      CATALOG,
      { appRevision, workingTreeDirty, inputHashes, captureProvenance },
      root,
      manifest,
    );
    const comparison = config.baseline
      ? compareReports(JSON.parse(readFileSync(config.baseline, "utf8")), report)
      : null;
    mkdirSync(config.out, { recursive: true });
    writeFileSync(
      join(config.out, "report.json"),
      `${JSON.stringify({ ...report, ...(comparison ? { comparison } : {}) }, null, 2)}\n`,
    );
    writeFileSync(join(config.out, "report.md"), markdown(report, comparison));
    console.log(`Evaluation report: ${join(config.out, "report.md")}`);
    if (
      test.status !== 0 ||
      !report.runSucceeded ||
      comparison?.regressions.length ||
      comparison?.runRegression ||
      comparison?.reviewed.regressions.length
    )
      process.exitCode = 1;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
try {
  main();
} catch {
  // Inputs/exception payloads may contain secrets; no raw stacks or reporter details.
  console.error(
    "Evaluation failed: check arguments, readable input files and compatible baseline. No successful report is implied.",
  );
  process.exitCode = 1;
}
