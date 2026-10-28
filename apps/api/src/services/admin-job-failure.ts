/** A settled failure whose safe evidence must survive both DB and live publication. */
export class AdminJobFailure extends Error {
  constructor(
    message: string,
    readonly result: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AdminJobFailure";
  }
}

/** A fixed observed prerequisite, never publication or cleanup authority. */
export class ConfigurationPrerequisiteFailure extends AdminJobFailure {
  readonly statusCode = 409;
  constructor() {
    super("Apply or update Data Manager before changing instance configuration.", {
      errorCode: "configuration_prerequisite",
      configuration: {
        outcome: "not_committed",
        reason: "conflict",
        cleanupFailed: false,
        publisherCleanupFailed: false,
        registryUpdateFailed: false,
      },
    });
    this.name = "ConfigurationPrerequisiteFailure";
  }
}

/** Internal admission bodies, ownership and proofs never cross the activity boundary. */
export function publicAdminJobResult<T>(result: T): T {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return Object.fromEntries(
    Object.entries(result).filter(([key]) => !key.startsWith("_") && key !== "opsProjection"),
  ) as T;
}

export class JobObservationPending extends Error {
  constructor(
    readonly reason: "transport" | "recovery_required" | "invalid_identity" | "receipt_delivery",
  ) {
    super("Administrative job observation is pending");
  }
}
