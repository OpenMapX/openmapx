export type OpaqueCursorErrorCode =
  | "CURSOR_INVALID"
  | "CURSOR_EXPIRED"
  | "CURSOR_PURPOSE_MISMATCH"
  | "CURSOR_TOO_LARGE";

export class OpaqueCursorError extends Error {
  constructor(
    readonly code: OpaqueCursorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpaqueCursorError";
  }
}

export interface OpaqueCursorCodec {
  encode<T>(purpose: string, value: T, ttlMs: number): string;
  decode<T>(token: string, purpose: string): T;
}
