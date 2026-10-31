import { randomUUID } from "node:crypto";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "../ops-client";
/** Typed source ownership inspection never reads host credential values. */
export const migrationSources = () =>
  executeAndWait(
    createApiOpsClient(),
    { kind: "configuration.sources.inspect" },
    createDurableOpsKey("migration.sources", randomUUID()),
  );
