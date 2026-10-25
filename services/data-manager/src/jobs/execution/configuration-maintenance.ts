import {
  type ControlInstallation,
  createDataConfigurationFenceStore,
} from "@openmapx/core/build-artifacts";
import type postgres from "postgres";
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
  });
}
export type DataConfigurationMaintenance = ReturnType<typeof createDataConfigurationMaintenance>;
