import { assertPostgresDeploymentSecret } from "@openmapx/core/deployment-secret-policy";

export {
  assertPostgresDeploymentSecret,
  assertProductionDatabaseUrlSecret,
  type DeploymentSecretIssue,
  DeploymentSecretPolicyError,
  deploymentSecretIssue,
  POSTGRES_DEPLOYMENT_SECRET_MIN_LENGTH,
} from "@openmapx/core/deployment-secret-policy";

/** Validate the Compose credential already loaded from infra/docker/.env. */
export function assertCliDeploymentSecret(env: NodeJS.ProcessEnv = process.env): void {
  assertPostgresDeploymentSecret(env.POSTGRES_PASSWORD, env.POSTGRES_USER ?? "postgres");
}
