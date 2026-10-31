/** Native API producer process. No service/DB/authority replacement. The parent
 * test controls only HTTP transport and kills this process at an actual reply. */
import { sql } from "../../../db";
import { initServiceRegistry } from "../../service-registry";
import { applyTrustedConfiguration } from "../../trusted-config-operations";

let text = "";
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text) as {
  operationKey: string;
  action?:
    | "maintenance"
    | "ordinary-service-config"
    | "ordinary-service-secret"
    | "maintenance-ensure-running"
    | "reconcile";
};
if (!/^opk1_[A-Za-z0-9_-]{16,64}$/.test(input.operationKey)) throw Error("Invalid fixture key");
if (
  input.action !== undefined &&
  ![
    "maintenance",
    "ordinary-service-config",
    "ordinary-service-secret",
    "maintenance-ensure-running",
    "reconcile",
  ].includes(input.action)
)
  throw Error("Invalid fixture action");
let exit = 0,
  phase = "registry";
try {
  await initServiceRegistry({ strict: true });
  if (input.action === "reconcile") {
    phase = "reconcile";
    await (await import("../../job-runner")).jobRunner.reconcile({ limit: 1 });
    const rows =
      await sql`SELECT status FROM admin_job WHERE payload->>'operationKey'=${input.operationKey} LIMIT 2`;
    if (rows.length !== 1 || rows[0]!.status !== "success") exit = 2;
    process.stdout.write(
      JSON.stringify({ event: "result", state: "observed", status: rows[0]?.status ?? "missing" }) +
        "\n",
    );
    // Let the runner's already-scheduled empty-queue pump enter its SQL call;
    // sql.end then joins that owned call before closing this fixture process.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } else {
    phase = "apply";
    const credentialService = input.action === "ordinary-service-secret" ? "motis" : "data-manager",
      coordinatorMode =
        input.action === "ordinary-service-secret" || input.action === "maintenance-ensure-running"
          ? ("ensure-running" as const)
          : ("require-running" as const);
    const value = await applyTrustedConfiguration(
      input.action === "ordinary-service-config"
        ? {
            kind: "serviceConfig.apply",
            serviceId: "motis",
            actorId: "loopback-admin",
            operationKey: input.operationKey,
            coordinatorMode: "ensure-running",
            overlay: {
              purpose: "service-config",
              coordinatorMode: "ensure-running",
              changes: [
                { kind: "service-config", serviceId: "motis", set: { WORKERS: 7 }, unset: [] },
              ],
            },
          }
        : {
            kind: "vault.apply",
            serviceId: credentialService,
            actorId: "loopback-admin",
            operationKey: input.operationKey,
            coordinatorMode,
            followUp: "service-apply",
            overlay: {
              purpose: "service-secret",
              coordinatorMode,
              changes: [
                {
                  kind: "service-secret",
                  serviceId: credentialService,
                  key: "TOKEN",
                  action: "set",
                  value: "synthetic-native-api-credential",
                },
              ],
            },
          },
    );
    process.stdout.write(
      JSON.stringify({ event: "result", state: "applied", revisionId: value.revisionId }) + "\n",
    );
  }
} catch (error) {
  // Driver/HTTP errors can include private material. Only the fixed class is
  // returned to the parent; neither stderr nor error messages are evidence.
  process.stdout.write(
    JSON.stringify({
      event: "result",
      state: "refused",
      phase,
      errorClass: error instanceof Error ? error.name : "unknown",
    }) + "\n",
  );
  exit = 2;
} finally {
  await sql.end({ timeout: 2 });
}
process.exit(exit);
