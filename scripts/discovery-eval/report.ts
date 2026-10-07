import { createHash } from "node:crypto";
import { relative } from "node:path";
import {
  buildReviewedEvidence,
  compareReviewedEvidence,
  type Manifest,
  type ReviewedEvidence,
  readManifest,
  validReviewedEvidence,
} from "./reviewed.js";

export interface EvalCase {
  id: string;
  layer: string;
  suite?: string;
  assertions?: string[];
  unavailable?: string;
  fixtures?: string[];
  expected?: unknown;
  note?: string;
  knownGap?: string;
}
export interface EvidenceMetadata {
  appRevision: string;
  workingTreeDirty: boolean;
  inputHashes: Record<string, string>;
  captureProvenance: { legacyFixtures: number; adaptedApiCaptures: number };
}
export interface EvalReport {
  protocolVersion: number;
  catalogHash: string;
  runSucceeded: boolean;
  metadata: EvidenceMetadata;
  reviewed: ReviewedEvidence;
  cases: Array<{
    id: string;
    layer: string;
    status: "passed" | "failed" | "unavailable" | "known-gap";
    passed: number;
    failed: number;
    unavailable: number;
    reason?: string;
    assertionInventory: string[];
  }>;
}
interface Assertion {
  fullName: string;
  status: string;
}
interface TestFile {
  name: string;
  status: string;
  assertionResults: Assertion[];
}
const STATUSES = new Set(["passed", "failed", "skipped", "pending", "todo"]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function testEvidence(input: unknown): { success: boolean; testResults: TestFile[] } {
  if (!record(input) || typeof input.success !== "boolean" || !Array.isArray(input.testResults)) {
    throw new Error("Invalid test evidence");
  }
  const files = input.testResults.map((file) => {
    if (
      !record(file) ||
      typeof file.name !== "string" ||
      typeof file.status !== "string" ||
      !["passed", "failed"].includes(file.status) ||
      !Array.isArray(file.assertionResults)
    ) {
      throw new Error("Invalid test evidence");
    }
    const assertions = file.assertionResults.map((assertion) => {
      if (
        !record(assertion) ||
        typeof assertion.fullName !== "string" ||
        typeof assertion.status !== "string" ||
        !STATUSES.has(assertion.status)
      ) {
        throw new Error("Invalid test evidence");
      }
      // Intentionally exclude errors, stacks, URLs, meta and test payloads.
      return { fullName: assertion.fullName, status: assertion.status };
    });
    return { name: file.name, status: String(file.status), assertionResults: assertions };
  });
  return { success: input.success, testResults: files };
}

export function createReport(
  input: unknown,
  catalog: EvalCase[],
  metadata: EvidenceMetadata,
  root: string,
  manifest: Manifest | null = null,
): EvalReport {
  const evidence = testEvidence(input);
  if (new Set(catalog.map((entry) => entry.id)).size !== catalog.length) {
    throw new Error("Duplicate evaluation catalog ID");
  }
  const cases = catalog.map((entry): EvalReport["cases"][number] => {
    const base = {
      id: entry.id,
      layer: entry.layer,
      passed: 0,
      failed: 0,
      unavailable: 0,
      assertionInventory: [] as string[],
    };
    if (!entry.suite)
      return {
        ...base,
        status: "unavailable",
        reason: entry.unavailable ?? "Manual evidence required",
      };
    const files = evidence.testResults.filter(
      (file) => relative(root, file.name).replaceAll("\\", "/") === entry.suite,
    );
    const all = files.flatMap((file) => file.assertionResults);
    const selected = entry.assertions?.length
      ? all.filter((assertion) =>
          entry.assertions?.some((selector) => assertion.fullName.includes(selector)),
        )
      : all;
    const missing =
      !files.length ||
      !selected.length ||
      entry.assertions?.some(
        (selector) => !all.some((assertion) => assertion.fullName.includes(selector)),
      );
    const passed = selected.filter((assertion) => assertion.status === "passed").length;
    const failed = selected.filter((assertion) => assertion.status === "failed").length;
    const unavailable = selected.length - passed - failed;
    const status =
      failed || files.some((file) => file.status === "failed" && file.assertionResults.length === 0)
        ? "failed"
        : missing || unavailable
          ? "unavailable"
          : entry.knownGap
            ? "known-gap"
            : "passed";
    return {
      ...base,
      // Names can contain test parameters; retain identity without saving their contents.
      assertionInventory: selected
        .map((assertion) => createHash("sha256").update(assertion.fullName).digest("hex"))
        .sort(),
      status,
      passed,
      failed,
      unavailable,
      ...(entry.knownGap && status === "known-gap" ? { reason: entry.knownGap } : {}),
      ...(missing
        ? { reason: "Required suite or assertion missing" }
        : unavailable
          ? { reason: "Required assertions skipped, pending or todo" }
          : {}),
    };
  });
  const reviewed = buildReviewedEvidence(manifest ? readManifest(manifest) : null);
  return {
    protocolVersion: 2,
    reviewed,
    catalogHash: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
    runSucceeded:
      evidence.success &&
      reviewed.results.every((entry) => entry.status !== "failed") &&
      cases.every(
        (entry, index) => !catalog[index].suite || ["passed", "known-gap"].includes(entry.status),
      ),
    metadata,
    cases,
  };
}

function validReport(value: unknown): value is EvalReport {
  if (
    !record(value) ||
    value.protocolVersion !== 2 ||
    typeof value.catalogHash !== "string" ||
    typeof value.runSucceeded !== "boolean" ||
    !record(value.metadata) ||
    typeof value.metadata.appRevision !== "string" ||
    typeof value.metadata.workingTreeDirty !== "boolean" ||
    !record(value.metadata.inputHashes) ||
    !Object.values(value.metadata.inputHashes).every((hash) => typeof hash === "string") ||
    !record(value.metadata.captureProvenance) ||
    ![
      value.metadata.captureProvenance.legacyFixtures,
      value.metadata.captureProvenance.adaptedApiCaptures,
    ].every((n) => Number.isInteger(n) && (n as number) >= 0) ||
    !validReviewedEvidence(value.reviewed) ||
    !Array.isArray(value.cases)
  )
    return false;
  return (
    value.cases.every(
      (entry) =>
        record(entry) &&
        typeof entry.id === "string" &&
        typeof entry.layer === "string" &&
        typeof entry.status === "string" &&
        ["passed", "failed", "unavailable", "known-gap"].includes(entry.status) &&
        [entry.passed, entry.failed, entry.unavailable].every(
          (n) => Number.isInteger(n) && (n as number) >= 0,
        ) &&
        Array.isArray(entry.assertionInventory) &&
        entry.assertionInventory.every(
          (id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id),
        ) &&
        entry.assertionInventory.length ===
          (entry.passed as number) + (entry.failed as number) + (entry.unavailable as number) &&
        (entry.reason === undefined || typeof entry.reason === "string") &&
        (!["passed", "known-gap"].includes(String(entry.status)) ||
          ((entry.passed as number) > 0 && entry.failed === 0 && entry.unavailable === 0)),
    ) && new Set(value.cases.map((entry) => entry.id)).size === value.cases.length
  );
}

export function compareReports(before: unknown, after: unknown) {
  if (
    !record(before) ||
    !record(after) ||
    typeof before.protocolVersion !== "number" ||
    typeof after.protocolVersion !== "number"
  )
    throw new Error("Invalid evaluation report");
  if (before.protocolVersion !== after.protocolVersion)
    throw new Error("Incompatible evaluation protocol versions");
  if (!validReport(before) || !validReport(after)) throw new Error("Invalid evaluation report");
  if (before.catalogHash !== after.catalogHash)
    throw new Error("Incompatible evaluation catalog or budgets");
  if (
    before.cases.length !== after.cases.length ||
    before.cases.some((entry) => !after.cases.some((other) => entry.id === other.id))
  )
    throw new Error("Incompatible evaluation case set");
  const previous = new Map(before.cases.map((entry) => [entry.id, entry]));
  if (
    after.cases.some(
      (entry) =>
        JSON.stringify(entry.assertionInventory) !==
        JSON.stringify(previous.get(entry.id)?.assertionInventory),
    )
  )
    throw new Error("Incompatible evaluation assertion inventory; required evidence changed");
  const keys = new Set([
    ...Object.keys(before.metadata.inputHashes),
    ...Object.keys(after.metadata.inputHashes),
  ]);
  const changedInputs = [...keys]
    .filter((key) => before.metadata.inputHashes[key] !== after.metadata.inputHashes[key])
    .sort();
  const reviewed = compareReviewedEvidence(before.reviewed, after.reviewed);
  const hasOperatorObservations = [before, after].some(
    (report) => (report.reviewed.manifest?.observations.length ?? 0) > 0,
  );
  return {
    reviewed,
    regressions: after.cases
      .filter((entry) => previous.get(entry.id)?.status === "passed" && entry.status !== "passed")
      .map((entry) => entry.id),
    improvements: after.cases
      .filter((entry) => previous.get(entry.id)?.status !== "passed" && entry.status === "passed")
      .map((entry) => entry.id),
    changedInputs,
    appOnlyComparison:
      changedInputs.length === 0 &&
      !hasOperatorObservations &&
      !reviewed.contextChanged &&
      !reviewed.captureConditionsChanged &&
      !reviewed.changedProviderInputs.length &&
      !before.metadata.workingTreeDirty &&
      !after.metadata.workingTreeDirty,
    runRegression: before.runSucceeded && !after.runSucceeded,
  };
}
