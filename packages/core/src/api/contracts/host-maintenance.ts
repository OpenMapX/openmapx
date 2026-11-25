import type { AdminJobType } from "../../jobs/vocabulary";

/** Advisory UI/CLI exclusion list; server writer admission remains authoritative. */
export const HOST_MUTATING_JOB_TYPES = [
  "system.update",
  "platform.apply",
  "system.diagnostics.collect",
  "service.start",
  "service.stop",
  "service.restart",
  "service.apply",
  "service.batch.run",
  "data.operation.run",
  "backup.operation.run",
  "extension.install",
  "extension.remove",
] as const satisfies readonly AdminJobType[];
