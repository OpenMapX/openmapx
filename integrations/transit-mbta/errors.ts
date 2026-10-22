export type MbtaFailure =
  | "unconfigured"
  | "input"
  | "policy"
  | "cancelled"
  | "timeout"
  | "unavailable"
  | "quota"
  | "auth"
  | "not_found"
  | "upstream"
  | "payload";
/** Never retain provider bodies, URLs or credentials in public errors. */
export class MbtaError extends Error {
  constructor(readonly kind: MbtaFailure) {
    super(`MBTA request failed (${kind})`);
    this.name = "MbtaError";
  }
}
