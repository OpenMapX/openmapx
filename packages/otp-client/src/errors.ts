export type OtpErrorKind =
  | "quota"
  | "unconfigured"
  | "configuration"
  | "input"
  | "http"
  | "payload"
  | "graphql"
  | "routing"
  | "unavailable"
  | "policy"
  | "cancelled"
  | "timeout";
const messages: Record<OtpErrorKind, string> = {
  quota: "OTP upstream cooldown",
  unconfigured: "OTP credentials required",
  configuration: "OTP invalid configuration",
  input: "OTP invalid request",
  http: "OTP HTTP request failed",
  payload: "OTP invalid response",
  graphql: "OTP GraphQL request failed",
  routing: "OTP routing request failed",
  unavailable: "OTP upstream unavailable",
  policy: "OTP source denied",
  cancelled: "OTP request cancelled",
  timeout: "OTP request timed out",
};
export class OtpError extends Error {
  constructor(readonly kind: OtpErrorKind) {
    super(messages[kind]);
    this.name = "OtpError";
  }
}
