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

/** Standalone acquisition inputs are public metadata; ownership and request MACs are not. */
export function publicAdminJobPayload(type: string, payload: unknown): unknown {
  if (
    !["standalone.preview", "standalone.install", "standalone.adopt", "standalone.remove"].includes(
      type,
    )
  ) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
    return Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== "_maintenanceRequest"),
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const fields =
    type === "standalone.preview"
      ? ["source"]
      : type === "standalone.install"
        ? ["inspectionId", "expectedContentDigest", "operationId"]
        : ["integrationId", "expectedContentDigest", "operationId"];
  return Object.fromEntries(Object.entries(payload).filter(([key]) => fields.includes(key)));
}
