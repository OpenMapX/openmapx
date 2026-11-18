import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { bindControlChildPhase, restoreAdmittedControlExecution } from "../execution-record";
import { closeControlInstallation, openControlInstallation } from "../private-records";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const input = JSON.parse(line);
  let installation: ReturnType<typeof openControlInstallation> | undefined;
  try {
    installation = openControlInstallation({
      infraDir: input.root,
      role: "data-manager",
      serviceIds: ["motis", "motis-staging"],
    });
    const authority = restoreAdmittedControlExecution(installation, input.execution);
    const child = await bindControlChildPhase(authority, { phase: "stop-primary", ordinal: 0 });
    writeSync(1, JSON.stringify({ ok: true, child }) + "\n");
  } catch (error) {
    writeSync(1, JSON.stringify({ ok: false, error: String(error) }) + "\n");
  } finally {
    if (installation) closeControlInstallation(installation);
  }
  break;
}
lines.close();
