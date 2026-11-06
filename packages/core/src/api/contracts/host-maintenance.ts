/** Advisory UI/CLI exclusion list; server writer admission remains authoritative. */
export const HOST_MUTATING_JOB_TYPES = [
  "system.update",
  "platform.apply",
  "system.diagnostics",
  "service.start",
  "service.stop",
  "service.restart",
  "service.apply",
  "service.bulk",
  "data.operation",
  "backup.operation",
  "extension.install",
  "extension.remove",
] as const;
