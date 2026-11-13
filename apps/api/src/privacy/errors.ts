import { ZodError } from "zod/v4";
import { AdminReauthenticationError } from "../account/admin-reauthentication.js";

/** A privacy-domain failure with a stable public code and its HTTP status. */
export class PrivacyRequestError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(code);
    this.name = "PrivacyRequestError";
  }
}

const UNAVAILABLE = { statusCode: 503, code: "PRIVACY_SERVICE_UNAVAILABLE" } as const;

/**
 * The one error mapping for every privacy route. Invalid input is 400. Domain
 * errors keep their declared status: an invalid transition and a missing or
 * spent reauthentication proof are 409. Missing legal configuration, outages
 * and anything unexpected are 503, so a caller never mistakes an operational
 * failure for a decision about the case.
 */
export function privacyErrorResponse(error: unknown): { statusCode: number; code: string } {
  if (error instanceof ZodError) return { statusCode: 400, code: "INVALID_REQUEST" };
  if (error instanceof PrivacyRequestError)
    return { statusCode: error.statusCode, code: error.code };
  if (error instanceof AdminReauthenticationError) return { statusCode: 409, code: error.code };
  return UNAVAILABLE;
}

export function privacyErrorReply(
  reply: { status(code: number): { send(payload: unknown): unknown } },
  error: unknown,
): unknown {
  const { statusCode, code } = privacyErrorResponse(error);
  return reply.status(statusCode).send({ code });
}
