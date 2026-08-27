import { describe, expect, it } from "vitest";
import { loadOpsAgentConfig } from "./config";

describe("ops-agent configuration", () => {
  it("requires caller token file paths and never accepts raw bearer environment values", () => {
    expect(
      loadOpsAgentConfig({
        OPS_AGENT_API_TOKEN_FILE: "/run/secrets/ops-agent-api-token",
        OPS_AGENT_DATA_MANAGER_TOKEN_FILE: "/run/secrets/ops-agent-data-manager-token",
        OPENMAPX_ROOT_DIR: "/srv/openmapx",
        OPS_TRUSTED_CONFIG_DIR: "/var/lib/openmapx/trusted-config",
      }),
    ).toEqual({
      apiTokenFile: "/run/secrets/ops-agent-api-token",
      dataManagerTokenFile: "/run/secrets/ops-agent-data-manager-token",
      rootDir: "/srv/openmapx",
      journalFile: "/srv/openmapx/infra/docker/data/ops-agent/jobs-v1.json",
      trustedConfigDirectory: "/var/lib/openmapx/trusted-config",
      host: "0.0.0.0",
      port: 4300,
    });
    expect(() =>
      loadOpsAgentConfig({
        OPS_AGENT_API_TOKEN: "raw-secret",
        OPS_AGENT_DATA_MANAGER_TOKEN: "raw-secret",
        OPENMAPX_ROOT_DIR: "/srv/openmapx",
        OPS_TRUSTED_CONFIG_DIR: "/var/lib/openmapx/trusted-config",
      }),
    ).toThrow("token file path");
  });
});
