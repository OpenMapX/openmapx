import { isAbsolute, join } from "node:path";

export interface OpsAgentConfig {
  apiTokenFile: string;
  dataManagerTokenFile: string;
  rootDir: string;
  journalFile: string;
  trustedConfigDirectory: string;
  host: string;
  port: number;
}

function absolutePath(env: NodeJS.ProcessEnv, name: string, label: string): string {
  const value = env[name]?.trim();
  if (!value || !isAbsolute(value)) throw new Error(`Missing or invalid ${label}`);
  return value;
}

export function loadOpsAgentConfig(env: NodeJS.ProcessEnv = process.env): OpsAgentConfig {
  const rawPort = env.PORT?.trim() || "4300";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid ops-agent port");
  }
  const rootDir = absolutePath(env, "OPENMAPX_ROOT_DIR", "repository root path");
  return {
    apiTokenFile: absolutePath(env, "OPS_AGENT_API_TOKEN_FILE", "API token file path"),
    dataManagerTokenFile: absolutePath(
      env,
      "OPS_AGENT_DATA_MANAGER_TOKEN_FILE",
      "data-manager token file path",
    ),
    rootDir,
    journalFile: join(rootDir, "infra", "docker", "data", "ops-agent", "jobs-v1.json"),
    trustedConfigDirectory: absolutePath(
      env,
      "OPS_TRUSTED_CONFIG_DIR",
      "trusted configuration directory",
    ),
    host: env.HOST?.trim() || "0.0.0.0",
    port,
  };
}
