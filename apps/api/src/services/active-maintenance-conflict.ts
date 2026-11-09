import { ACTIVE_SYSTEM_MAINTENANCE_INDEX } from "../db/admin-job-schema";

/** A system update or diagnostics job is already queued or running. */
export class ActiveMaintenanceConflict extends Error {
  constructor() {
    super("A maintenance operation is already active");
  }
}

/** Recognizes the unique violation raised by the active-maintenance index. */
export function isActiveMaintenanceViolation(error: unknown): boolean {
  const source = error as {
    code?: unknown;
    constraint_name?: unknown;
    cause?: { code?: unknown; constraint_name?: unknown };
  } | null;
  const code = source?.code ?? source?.cause?.code;
  const constraint = source?.constraint_name ?? source?.cause?.constraint_name;
  return code === "23505" && constraint === ACTIVE_SYSTEM_MAINTENANCE_INDEX;
}
