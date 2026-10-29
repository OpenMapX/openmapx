import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AuditWorkspace = "root" | "docs";
type AuditSeverity = "info" | "low" | "moderate" | "high" | "critical";

export interface ProductionAuditAllowance {
  advisoryId: string;
  packageName: string;
  severity: "high" | "critical";
  workspace: AuditWorkspace;
  versions: string[];
  expiresOn: string;
  reason: string;
}

export interface ProductionAuditPolicy {
  schemaVersion: 1;
  allowances: ProductionAuditAllowance[];
}

export interface AuditCommandResult {
  status: number | null;
  stdout: string;
}

export interface ProductionAuditOutcome {
  errors: string[];
  notices: string[];
  warnings: string[];
}

interface AuditAdvisory {
  advisoryId: string;
  packageName: string;
  severity: AuditSeverity;
  versions: string[];
  patchedVersions: string | null;
  patchedVersionsUnpublished: boolean;
}

const WORKSPACES = ["root", "docs"] as const;
const SEVERITIES = new Set<AuditSeverity>(["info", "low", "moderate", "high", "critical"]);
const POLICY_KEYS = new Set(["allowances", "schemaVersion"]);
const ALLOWANCE_KEYS = new Set([
  "advisoryId",
  "expiresOn",
  "packageName",
  "reason",
  "severity",
  "versions",
  "workspace",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function expirationTimestamp(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const timestamp = Date.parse(`${value}T23:59:59.999Z`);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : undefined;
}

function parsePolicy(value: unknown): ProductionAuditPolicy | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, POLICY_KEYS) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.allowances)
  ) {
    return undefined;
  }

  const allowances: ProductionAuditAllowance[] = [];
  const keys = new Set<string>();
  for (const candidate of value.allowances) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ALLOWANCE_KEYS)) return undefined;
    const { advisoryId, expiresOn, packageName, reason, severity, versions, workspace } = candidate;
    if (
      typeof advisoryId !== "string" ||
      !/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/.test(advisoryId) ||
      typeof packageName !== "string" ||
      packageName.length === 0 ||
      (severity !== "high" && severity !== "critical") ||
      (workspace !== "root" && workspace !== "docs") ||
      !Array.isArray(versions) ||
      versions.length === 0 ||
      versions.some((version) => typeof version !== "string" || version.length === 0) ||
      typeof expiresOn !== "string" ||
      expirationTimestamp(expiresOn) === undefined ||
      typeof reason !== "string" ||
      reason.trim().length === 0
    ) {
      return undefined;
    }

    const normalizedVersions = [...new Set(versions)].sort();
    const key = `${workspace}\0${advisoryId}\0${packageName}`;
    if (keys.has(key)) return undefined;
    keys.add(key);
    allowances.push({
      advisoryId,
      packageName,
      severity,
      workspace,
      versions: normalizedVersions,
      expiresOn,
      reason,
    });
  }

  return { schemaVersion: 1, allowances };
}

function parseAdvisory(value: unknown): AuditAdvisory | undefined {
  if (!isRecord(value)) return undefined;
  const {
    findings,
    github_advisory_id: advisoryId,
    module_name: packageName,
    patched_versions: patchedVersions,
    patched_versions_unpublished: patchedVersionsUnpublished,
    severity,
  } = value;
  if (
    typeof advisoryId !== "string" ||
    !/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/.test(advisoryId) ||
    typeof packageName !== "string" ||
    packageName.length === 0 ||
    typeof severity !== "string" ||
    !SEVERITIES.has(severity as AuditSeverity) ||
    (patchedVersions !== null && typeof patchedVersions !== "string") ||
    (patchedVersionsUnpublished !== undefined && typeof patchedVersionsUnpublished !== "boolean") ||
    !Array.isArray(findings) ||
    findings.length === 0
  ) {
    return undefined;
  }

  const versions = new Set<string>();
  for (const finding of findings) {
    if (!isRecord(finding) || typeof finding.version !== "string" || finding.version.length === 0) {
      return undefined;
    }
    versions.add(finding.version);
  }

  return {
    advisoryId,
    packageName,
    severity: severity as AuditSeverity,
    versions: [...versions].sort(),
    patchedVersions,
    // The registry's report may leave the flag out; then no patched range means none is published.
    patchedVersionsUnpublished: patchedVersionsUnpublished ?? patchedVersions === null,
  };
}

function parseAuditReport(stdout: string): AuditAdvisory[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value.advisories)) return undefined;

  const advisories: AuditAdvisory[] = [];
  for (const rawAdvisory of Object.values(value.advisories)) {
    const advisory = parseAdvisory(rawAdvisory);
    if (!advisory) return undefined;
    advisories.push(advisory);
  }
  return advisories;
}

function sameVersions(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((version, index) => version === right[index]);
}

export function checkProductionAuditResults(
  results: Record<AuditWorkspace, AuditCommandResult>,
  rawPolicy: unknown,
  now = new Date(),
): ProductionAuditOutcome {
  const outcome: ProductionAuditOutcome = { errors: [], notices: [], warnings: [] };
  const policy = parsePolicy(rawPolicy);
  if (!policy) {
    outcome.errors.push("invalid production audit policy");
    return outcome;
  }

  for (const allowance of policy.allowances) {
    const expiry = expirationTimestamp(allowance.expiresOn);
    if (expiry !== undefined && now.getTime() > expiry) {
      outcome.errors.push(
        `[${allowance.workspace}] allowance for ${allowance.advisoryId} and ${allowance.packageName} expired on ${allowance.expiresOn}; re-audit before renewing it`,
      );
    }
  }
  if (outcome.errors.length > 0) return outcome;

  for (const workspace of WORKSPACES) {
    const command = results[workspace];
    if (command.status !== 0 && command.status !== 1) {
      outcome.errors.push(`[${workspace}] production audit command failed`);
      continue;
    }

    const advisories = parseAuditReport(command.stdout);
    if (!advisories) {
      outcome.errors.push(
        command.stdout.trim().startsWith("{")
          ? `[${workspace}] malformed audit report`
          : `[${workspace}] invalid audit JSON`,
      );
      continue;
    }
    if (command.status === 1 && advisories.length === 0) {
      outcome.errors.push(`[${workspace}] malformed audit report`);
      continue;
    }

    for (const advisory of advisories) {
      const versionLabel = advisory.versions.join(",");
      if (advisory.severity !== "high" && advisory.severity !== "critical") {
        outcome.warnings.push(
          `[${workspace}] observed ${advisory.severity} advisory ${advisory.advisoryId} for ${advisory.packageName}@${versionLabel} (non-blocking)`,
        );
        continue;
      }

      const allowance = policy.allowances.find(
        (candidate) =>
          candidate.workspace === workspace &&
          candidate.advisoryId === advisory.advisoryId &&
          candidate.packageName === advisory.packageName &&
          candidate.severity === advisory.severity &&
          sameVersions(candidate.versions, advisory.versions),
      );
      if (!allowance) {
        outcome.errors.push(
          `[${workspace}] blocking ${advisory.severity} advisory ${advisory.advisoryId} for ${advisory.packageName}@${versionLabel}`,
        );
        continue;
      }

      if (advisory.patchedVersions !== null || !advisory.patchedVersionsUnpublished) {
        outcome.errors.push(
          `[${workspace}] ${advisory.advisoryId} for ${advisory.packageName} now has a published patch; remove the allowance and upgrade`,
        );
        continue;
      }

      outcome.notices.push(
        `[${workspace}] acknowledged ${advisory.severity} advisory ${advisory.advisoryId} for ${advisory.packageName}@${versionLabel} until ${allowance.expiresOn}`,
      );
    }
  }

  return outcome;
}

function runAudit(repositoryRoot: string, workspace: AuditWorkspace): AuditCommandResult {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, ["audit", "--prod", "--json"], {
    cwd: workspace === "root" ? repositoryRoot : resolve(repositoryRoot, "docs"),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let rawPolicy: unknown;
  try {
    rawPolicy = JSON.parse(
      readFileSync(resolve(repositoryRoot, "scripts/production-audit-allowances.json"), "utf8"),
    );
  } catch {
    rawPolicy = undefined;
  }

  const outcome = checkProductionAuditResults(
    {
      root: runAudit(repositoryRoot, "root"),
      docs: runAudit(repositoryRoot, "docs"),
    },
    rawPolicy,
  );
  for (const notice of outcome.notices) console.log(notice);
  for (const warning of outcome.warnings) console.warn(warning);
  for (const error of outcome.errors) console.error(error);
  if (outcome.errors.length > 0) process.exitCode = 1;
}
