/** The detached configuration helper. The agent recorded its lease child before
 * it started it; the ids come from its environment. Its exit code and its
 * progress file are what the restarted agent reads. */
import { isAbsolute, join } from "node:path";
import {
  closeControlInstallation,
  leaseStoreDirectory,
  openControlInstallation,
  openLeaseStore,
} from "@openmapx/core/build-artifacts";
import { z } from "zod";
import { createConfigurationHandoffHost } from "./configuration-handoff-application";
import { runConfigurationHandoff } from "./handoff-helper";

async function main(): Promise<number> {
  const rootDir = process.env.OPENMAPX_ROOT_DIR ?? "";
  if (!isAbsolute(rootDir)) return 2;
  const handoffId = z.uuid().parse(process.env.OPS_CONFIGURATION_HANDOFF_ID),
    maintenanceId = z.uuid().parse(process.env.OPENMAPX_MAINTENANCE_ID),
    leaseId = z.uuid().parse(process.env.OPENMAPX_LEASE_ID),
    leaseChild = z.uuid().parse(process.env.OPENMAPX_LEASE_CHILD),
    infraDir = join(rootDir, "infra/docker"),
    controller = new AbortController(),
    stop = () => controller.abort(Error("Configuration helper stopping"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const installation = openControlInstallation({ infraDir, role: "ops-agent" });
  try {
    const outcome = await runConfigurationHandoff({
      installation,
      store: openLeaseStore({
        directory: leaseStoreDirectory(infraDir),
        purpose: "configuration helper",
      }),
      host: await createConfigurationHandoffHost({ installation, rootDir }),
      maintenanceId,
      handoffId,
      leaseId,
      leaseChild,
      signal: controller.signal,
    });
    process.stdout.write(`configuration_handoff_${outcome}\n`);
    return outcome === "applied" ? 0 : 1;
  } finally {
    closeControlInstallation(installation);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // Paths, Docker diagnostics and environment values stay private; the agent
    // reads the outcome from the progress file and the exit code.
    process.stderr.write("configuration_handoff_failed\n");
    process.exitCode = 1;
  },
);
