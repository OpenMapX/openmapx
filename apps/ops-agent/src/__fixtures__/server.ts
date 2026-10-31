import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
} from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { buildOpsAgentServer, type BuildOpsAgentServerOptions } from "../server";

/** Stable retry identity with an actual protocol-v2 root expiry. */
export function controlTestKey(label: string, notAfter: number): string {
  return createControlRootOperationKey({
    notAfter,
    nonce: createHash("sha256").update(label).digest().subarray(0, 16),
  });
}

/** Exercise the server's real certified admission and retained control files. */
export async function buildControlTestServer(options: BuildOpsAgentServerOptions) {
  if (options.controlInstallation) return buildOpsAgentServer(options);
  const root = mkdtempSync(join(tmpdir(), "openmapx-server-control-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlInstallation(root);
  const installation = openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["redis", "motis", "osrm", "valhalla", "postgis", "app-api", "traefik", "data-manager", "alpha"],
  });
  const app = buildOpsAgentServer({ ...options, controlInstallation: installation });
  app.addHook("onClose", async () => {
    closeControlInstallation(installation);
    rmSync(root, { recursive: true, force: true });
  });
  return app;
}
