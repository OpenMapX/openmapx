import { ApiClientError } from "@openmapx/core";
import { adminErrorMessage } from "@openmapx/core/api-admin-sdk";

/**
 * A failure whose message is written for the reader: catalogue copy that a
 * component raised, such as "Preview expired. Request a fresh one." Every
 * other error carries an English diagnostic and shows the caller's fallback.
 */
export class AdminDisplayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AdminDisplayError";
  }
}

/**
 * A failed admin request. `detail` is the server's own message, when it sent
 * one. `unconfirmed` means the request ended before the host confirmed a
 * result, so work may still be running. Everything else is worded by the
 * component that shows the failure, in the reader's language.
 */
export class AdminRequestError extends Error {
  /** Declared for types only; installed as non-enumerable own properties, like the message. */
  readonly detail!: string | null;
  readonly unconfirmed!: boolean;
  constructor(
    detail: string | null,
    { unconfirmed = false, cause }: { unconfirmed?: boolean; cause?: unknown } = {},
  ) {
    super(detail ?? (unconfirmed ? "ADMIN_REQUEST_UNCONFIRMED" : "ADMIN_REQUEST_FAILED"), {
      cause,
    });
    this.name = "AdminRequestError";
    Object.defineProperties(this, {
      detail: { value: detail, enumerable: false },
      unconfirmed: { value: unconfirmed, enumerable: false },
    });
  }
}

/**
 * Text for a failed admin action: the server's message, the message of an
 * `AdminDisplayError`, or the caller's fallback. Transport, contract and
 * other errors carry English diagnostics, so they show the fallback.
 */
export function adminErrorText(error: unknown, fallback: string): string {
  if (error instanceof AdminRequestError) return error.detail ?? fallback;
  if (error instanceof ApiClientError) return adminErrorMessage(error, fallback);
  if (error instanceof AdminDisplayError && error.message) return error.message;
  return fallback;
}
