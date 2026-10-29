import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function list(value: string | undefined): string[] {
  if (!value || value === "none") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function containsKey(value: unknown, keys: ReadonlySet<string>): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === "string" && child.trim()) return true;
    if (containsKey(child, keys)) return true;
  }
  return false;
}

function validateFixture(path: string, label: string, errors: string[]): void {
  if (!existsSync(path)) {
    errors.push(`${label}: fixture metadata does not exist: ${path}`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    errors.push(`${label}: fixture metadata is not valid JSON: ${path}`);
    return;
  }
  if (
    !containsKey(
      parsed,
      new Set([
        "sha256",
        "checksum",
        "snapshotChecksum",
        "transcriptionChecksum",
        "artifactSha256",
      ]),
    )
  )
    errors.push(`${label}: fixture metadata has no snapshot checksum`);
  if (!containsKey(parsed, new Set(["reviewer", "reviewedBy"])))
    errors.push(`${label}: fixture metadata has no reviewer`);
}

const REQUIRED_FIELDS = [
  "air_quality_component",
  "status",
  "code_path",
  "manifest_paths",
  "manifest_source_ids",
  "standard_revision",
  "terms_record",
  "fixture_metadata",
  "focused_test",
  "live_smoke_date",
  "legal_approval",
  "blocker",
] as const;

export function checkAirQualityReleaseGates(repositoryRoot: string, now = new Date()): string[] {
  const errors: string[] = [];
  const statusPath = resolve(repositoryRoot, "scripts/air-quality-release-status.json");
  if (!existsSync(statusPath)) return [`release status data does not exist: ${statusPath}`];
  let records: Record<string, string>[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(statusPath, "utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every(
        (record) =>
          record !== null &&
          typeof record === "object" &&
          !Array.isArray(record) &&
          Object.values(record).every((value) => typeof value === "string"),
      )
    )
      return ["release status data must contain a non-empty array of string-valued records"];
    records = parsed;
  } catch {
    return [`release status data is not valid JSON: ${statusPath}`];
  }
  const componentIds = new Set<string>();

  for (const record of records) {
    const label = record.air_quality_component || "unknown";
    for (const field of REQUIRED_FIELDS) {
      if (!record[field]?.trim()) errors.push(`${label}: missing ${field}`);
    }
    if (componentIds.has(label)) errors.push(`${label}: duplicate component record`);
    componentIds.add(label);
    if (!["shipped", "blocked", "deferred"].includes(record.status ?? ""))
      errors.push(`${label}: invalid status ${record.status ?? "missing"}`);

    const reviewed = Date.parse(`${record.live_smoke_date ?? ""}T00:00:00Z`);
    const ageDays = (now.getTime() - reviewed) / 86_400_000;
    if (!Number.isFinite(reviewed)) errors.push(`${label}: live_smoke_date is not YYYY-MM-DD`);
    else if (ageDays < -1) errors.push(`${label}: contract review date is in the future`);
    else if (ageDays > 120)
      errors.push(`${label}: contract review is stale (${Math.floor(ageDays)} days)`);

    if (record.status === "shipped") {
      const codePaths = list(record.code_path);
      if (codePaths.length === 0) errors.push(`${label}: shipped record has no code path`);
      for (const path of codePaths) {
        if (!existsSync(resolve(repositoryRoot, path)))
          errors.push(`${label}: code path does not exist: ${path}`);
      }
      const manifestPaths = list(record.manifest_paths);
      const sourceIds = new Set<string>();
      for (const path of manifestPaths) {
        const absolute = resolve(repositoryRoot, path);
        if (!existsSync(absolute)) {
          errors.push(`${label}: manifest does not exist: ${path}`);
          continue;
        }
        try {
          const manifest = JSON.parse(readFileSync(absolute, "utf8")) as {
            dataSources?: Array<{ sourceId?: string }>;
          };
          for (const source of manifest.dataSources ?? []) {
            if (source.sourceId) sourceIds.add(source.sourceId);
          }
        } catch {
          errors.push(`${label}: manifest is not valid JSON: ${path}`);
        }
      }
      for (const sourceId of list(record.manifest_source_ids)) {
        if (!sourceIds.has(sourceId))
          errors.push(`${label}: unknown manifest source ID: ${sourceId}`);
      }
      if (!record.legal_approval || !["approved", "not-required"].includes(record.legal_approval))
        errors.push(`${label}: legal_approval must be approved or not-required when shipped`);
      for (const path of list(record.fixture_metadata))
        validateFixture(resolve(repositoryRoot, path), label, errors);
      if (list(record.fixture_metadata).length === 0)
        errors.push(`${label}: shipped record has no fixture metadata`);
      if (record.blocker !== "none")
        errors.push(`${label}: shipped record must declare blocker as none`);
    } else {
      if (record.code_path !== "none")
        errors.push(`${label}: ${record.status} optional provider must not claim a code path`);
      if (!record.blocker || record.blocker === "none")
        errors.push(`${label}: ${record.status} record must state its blocker`);
    }
  }

  return errors;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const errors = checkAirQualityReleaseGates(repositoryRoot);
  if (errors.length > 0) {
    for (const error of errors) console.error(`air-quality release gate: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("Air-quality release gates are internally consistent.");
  }
}
