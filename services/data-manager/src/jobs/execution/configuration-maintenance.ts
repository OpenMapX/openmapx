import {
  type ControlInstallation,
  createDataConfigurationFenceStore,
} from "@openmapx/core/build-artifacts";
import type postgres from "postgres";
import { z } from "zod";
/** The adapter keeps every guard check and mutation on the exact transaction's
 * connection. It exposes no HTTP lock or caller-provided ownership boolean. */
export function createDataConfigurationMaintenance(
  sql: postgres.Sql,
  installation: ControlInstallation,
) {
  return createDataConfigurationFenceStore(installation, {
    unsafe: (query, parameters) => sql.unsafe(query, parameters),
    async transaction(run) {
      const result = await sql.begin(async (tx) => ({
        value: await run({ unsafe: (query, parameters) => tx.unsafe(query, parameters) }),
      }));
      return result.value;
    },
    async reserveSettlementSession(sessionNonce) {
      z.uuid().parse(sessionNonce);
      const connection = await sql.reserve(),
        applicationName = `omx-config-settle:${sessionNonce}`;
      // This connection is NEVER returned following an uncertain transaction.
      // The fixed effect runner alone releases a conclusively finished one.
      await connection.unsafe("SELECT set_config('application_name',$1,false)", [applicationName]);
      const [row] = await connection.unsafe(
        "SELECT pid,backend_start::text AS backend_start,application_name FROM pg_stat_activity WHERE pid=pg_backend_pid()",
      );
      if (
        !row ||
        typeof row.pid !== "number" ||
        typeof row.backend_start !== "string" ||
        row.application_name !== applicationName
      )
        throw Error("Original reserved settlement SQL identity unavailable");
      return {
        identity: { pid: row.pid, backendStart: row.backend_start, sessionNonce },
        unsafe: (query, parameters) => connection.unsafe(query, parameters),
        releaseConclusive: () => connection.release(),
      };
    },
  });
}
export type DataConfigurationMaintenance = ReturnType<typeof createDataConfigurationMaintenance>;
