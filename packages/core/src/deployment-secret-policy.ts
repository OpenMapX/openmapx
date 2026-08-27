export type DeploymentSecretIssue =
  | "missing"
  | "known-placeholder"
  | "too-short"
  | "matches-username";

export const POSTGRES_DEPLOYMENT_SECRET_MIN_LENGTH = 24;

const KNOWN_PLACEHOLDERS = new Set([
  "change-me",
  "changeme",
  "replace-me",
  "password",
  "postgres",
  "openmapx",
]);

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed percent escape is not silently rewritten. The database
    // driver remains authoritative for URL syntax; the policy still evaluates
    // the exact supplied string without ever exposing it.
    return value;
  }
}

/**
 * Pure deployment-secret policy shared by the CLI and production database
 * bootstraps. Database URLs percent-encode credentials, so both the candidate
 * and username are evaluated after URL decoding.
 */
export function deploymentSecretIssue(
  value: string | undefined,
  options: { username?: string; minLength: number },
): DeploymentSecretIssue | null {
  if (value === undefined) return "missing";
  const normalized = decoded(value).trim();
  if (normalized.length === 0) return "missing";
  if (KNOWN_PLACEHOLDERS.has(normalized.toLowerCase())) return "known-placeholder";

  const username = options.username === undefined ? undefined : decoded(options.username).trim();
  if (username && normalized === username) return "matches-username";
  if (normalized.length < options.minLength) return "too-short";
  return null;
}

export class DeploymentSecretPolicyError extends Error {
  readonly issue: DeploymentSecretIssue | "invalid-database-url";

  constructor(issue: DeploymentSecretIssue | "invalid-database-url") {
    super(
      `PostgreSQL deployment credential rejected by policy (${issue}); configure a unique value of at least ${POSTGRES_DEPLOYMENT_SECRET_MIN_LENGTH} characters`,
    );
    this.name = "DeploymentSecretPolicyError";
    this.issue = issue;
  }
}

export function assertPostgresDeploymentSecret(
  value: string | undefined,
  username = "postgres",
): void {
  const issue = deploymentSecretIssue(value, {
    username,
    minLength: POSTGRES_DEPLOYMENT_SECRET_MIN_LENGTH,
  });
  if (issue) throw new DeploymentSecretPolicyError(issue);
}

/** Fail closed at database bootstrap only for production runtime processes. */
export function assertProductionDatabaseUrlSecret(
  databaseUrl: string,
  nodeEnv: string | undefined,
): void {
  if (nodeEnv !== "production") return;

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new DeploymentSecretPolicyError("invalid-database-url");
  }
  assertPostgresDeploymentSecret(parsed.password, parsed.username);
}
