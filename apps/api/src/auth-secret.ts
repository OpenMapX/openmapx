import { assertProductionApplicationSecret } from "@openmapx/core/deployment-secret-policy";

export function resolveBetterAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET env var is required");
  assertProductionApplicationSecret("BETTER_AUTH_SECRET", secret, env.NODE_ENV);
  return secret;
}
