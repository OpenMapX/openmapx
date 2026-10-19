export type EnturRequestErrorKind =
  | "config"
  | "source"
  | "policy"
  | "quota"
  | "cooldown"
  | "unavailable"
  | "http"
  | "graphql"
  | "response"
  | "abort"
  | "timeout";

/** Bounded classifications only: no URL, raw response, provider message or configuration. */
export class EnturRequestError extends Error {
  override readonly name = "EnturRequestError";
  constructor(
    readonly kind: EnturRequestErrorKind,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(
      kind === "config"
        ? "Invalid Entur configuration"
        : `Entur request failed (${kind}${status === undefined ? "" : `, HTTP ${status}`})`,
      options,
    );
  }
}

export function isEnturRequestError(error: unknown): error is EnturRequestError {
  return error instanceof EnturRequestError;
}
