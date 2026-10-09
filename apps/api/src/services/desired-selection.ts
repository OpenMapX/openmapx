import type { OpsResultFor } from "@openmapx/core/ops";
import { createApiOpsClient } from "./ops-client";

/** The selection a render applies, as the ops-agent reads it from the deployment. */
export async function readDesiredSelection(): Promise<OpsResultFor<"serviceSelection.inspect">> {
  const submitted = await createApiOpsClient().execute({ kind: "serviceSelection.inspect" }, {});
  if (submitted.execution !== "sync") throw new Error("Service selection unavailable");
  return submitted.value;
}
