import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, INPUT_FILES } from "./catalog.js";
import { compareReports, createReport, type EvalReport } from "./report.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function options(args: string[]) {
  const result = { out: join(root, ".superpowers/eval-reports/latest"), baseline: "" };
  for (let i = 0; i < args.length; i += 2) {
    if (!["--out", "--baseline"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error("Usage: pnpm discovery-eval [--out DIRECTORY] [--baseline REPORT.json]");
    result[args[i] === "--out" ? "out" : "baseline"] = resolve(args[i + 1]);
  }
  return result;
}
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
    "This is offline recorded/synthetic/contract evidence. Manual and installed-device results are unavailable. Assertion counts can overlap between cases; they are not independent observations or production performance metrics.",
    `Search capture provenance: ${report.metadata.captureProvenance.legacyFixtures} legacy fixtures with unknown provenance; ${report.metadata.captureProvenance.adaptedApiCaptures} explicitly adapted API captures. Exact deployed source generations are unknown here.`,
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
  ].join("\n");
}
function main() {
  const config = options(process.argv.slice(2));
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
      comparison?.runRegression
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
