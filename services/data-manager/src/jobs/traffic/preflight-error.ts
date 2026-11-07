/** Only the read-only graph inspection may report this no-writer failure. */
export class TrafficMaintenancePreflightError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Traffic inspection unavailable", { cause });
    this.name = "TrafficMaintenancePreflightError";
  }
}
