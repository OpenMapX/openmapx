/** Native, synthetic acceptance driver. Input and output contain opaque identities only. */
import { sql } from "../../../db";
import { jobRunner } from "../../job-runner";
import { initServiceRegistry } from "../../service-registry";

let bytes = "";
for await (const chunk of process.stdin) bytes += chunk;
const input = JSON.parse(bytes) as {
  actorId: string;
  previewId: string;
  intentFingerprint: string;
  operationKey: string;
  reconcile?: boolean;
};
let exit = 0;
try {
  await initServiceRegistry({ strict: true });
  if (input.reconcile) await jobRunner.reconcile({ limit: 1 });
  else await jobRunner.applyImmediateTransitCredentials(input);
  const rows =
    await sql`SELECT status FROM admin_job WHERE payload->>'operationKey'=${input.operationKey}`;
  if (rows.length !== 1 || rows[0]!.status !== "success") exit = 2;
  process.stdout.write(JSON.stringify({ status: rows[0]?.status ?? "missing" }) + "\n");
} catch {
  exit = 2;
  process.stdout.write(JSON.stringify({ status: "unresolved" }) + "\n");
} finally {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await sql.end({ timeout: 2 });
  process.exit(exit);
}
