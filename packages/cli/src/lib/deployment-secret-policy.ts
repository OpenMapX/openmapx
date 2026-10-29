import {
  assertApplicationDeploymentSecret,
  assertPostgresDeploymentSecret,
  DeploymentSecretPolicyError,
  deploymentSecretIssue,
  POSTGRES_DEPLOYMENT_SECRET_MIN_LENGTH,
} from "@openmapx/core/deployment-secret-policy";

export {
  APPLICATION_DEPLOYMENT_SECRET_MIN_LENGTH,
  assertApplicationDeploymentSecret,
  assertPostgresDeploymentSecret,
  assertProductionApplicationSecret,
  assertProductionDatabaseUrlSecret,
  type DeploymentSecretIssue,
  DeploymentSecretPolicyError,
  deploymentSecretIssue,
  POSTGRES_DEPLOYMENT_SECRET_MIN_LENGTH,
} from "@openmapx/core/deployment-secret-policy";

/** Validate deployment credentials already loaded from infra/docker/.env. */
export function assertCliDeploymentSecrets(env: NodeJS.ProcessEnv = process.env): void {
  assertPostgresDeploymentSecret(env.POSTGRES_PASSWORD, env.POSTGRES_USER ?? "postgres");
  assertApplicationDeploymentSecret("BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET);
  assertApplicationDeploymentSecret("DATA_MANAGER_AUTH_TOKEN", env.DATA_MANAGER_AUTH_TOKEN);
  // Only Martin needs it, and Martin's own manifest refuses to render without it.
  if (env.MARTIN_DB_PASSWORD) {
    const issue = deploymentSecretIssue(env.MARTIN_DB_PASSWORD, {
      username: "openmapx_tiles",
      minLength: POSTGRES_DEPLOYMENT_SECRET_MIN_LENGTH,
      urlEncoded: false,
    });
    if (issue)
      throw new DeploymentSecretPolicyError(issue, { credentialName: "MARTIN_DB_PASSWORD" });
  }
}
