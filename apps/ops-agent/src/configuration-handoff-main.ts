/** Detached fixed helper entrypoint. Only the original signed child can open
 * the retained target tree. Failures keep the original fence for observation. */
import { isAbsolute } from "node:path";
import { executionRefSchema } from "@openmapx/core/ops";
import { z } from "zod";
import { runConfigurationHandoffApplication } from "./configuration-handoff-application";
import {
  closeConfigurationHandoffChild,
  openConfigurationHandoffChild,
  reconcileCompletedConfigurationHandoff,
} from "./configuration-handoff-control";

let stage: "input" | "adoption" | "application" = "input";
async function main(): Promise<number> {
  const rootDir = process.env.OPENMAPX_ROOT_DIR ?? "";
  if (!isAbsolute(rootDir)) return 2;
  const handoffId = z.uuid().parse(process.env.OPS_CONFIGURATION_HANDOFF_ID),
    assertion = z.string().min(1).max(4096).parse(process.env.OPENMAPX_CONTROL_DELEGATION),
    execution = executionRefSchema.parse(
      JSON.parse(process.env.OPENMAPX_CONTROL_EXECUTION ?? "null"),
    ),
    controller = new AbortController(),
    stop = () => controller.abort(Error("Configuration helper stopping"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  stage = "adoption";
  if (await reconcileCompletedConfigurationHandoff({ rootDir, handoffId, assertion, execution })) {
    process.stdout.write("configuration_handoff_applied\n");
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    return 0;
  }
  const child = await openConfigurationHandoffChild({ rootDir, handoffId, assertion, execution });
  try {
    stage = "application";
    await runConfigurationHandoffApplication({ child, rootDir, signal: controller.signal });
    process.stdout.write("configuration_handoff_applied\n");
    return 0;
  } finally {
    closeConfigurationHandoffChild(child);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // Paths, Docker diagnostics, environment values and control assertions stay
    // private. The authenticated journal supplies the safe operator status.
    process.stderr.write(`configuration_handoff_recovery_required:${stage}\n`);
    process.exitCode = 1;
  },
);
