import { isAbsolute, join } from "node:path";
import { services } from "@openmapx/core/server";

export interface OpsAgentConfig {
  apiTokenFile: string;
  dataManagerTokenFile: string;
  rootDir: string;
  journalFile: string;
  trustedConfigDirectory: string;
  host: string;
  port: number;
  privacyBackupCapabilityKeyFile?: string;
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
    journalFile: services.agentStatePaths(join(rootDir, "infra", "docker")).journal,
    // Opened through the checkout, not the container's own mount: an agent
    // recreated from an earlier generation still mounts the old location, and
    // when the data directory is a filesystem of its own that is no longer
    // the directory app-api uses. OPS_TRUSTED_CONFIG_DIR stays set for agents
    // of earlier releases.
    trustedConfigDirectory: services.agentStatePaths(join(rootDir, "infra", "docker"))
      .trustedConfig,
    host: env.HOST?.trim() || "0.0.0.0",
    port,
    ...(env.OPS_PRIVACY_BACKUP_CAPABILITY_KEY_FILE?.trim()
      ? {
          privacyBackupCapabilityKeyFile: absolutePath(
            env,
            "OPS_PRIVACY_BACKUP_CAPABILITY_KEY_FILE",
            "privacy backup capability key file path",
          ),
        }
      : {}),
  };
}
