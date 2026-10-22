import { OtpError } from "./errors";
import { operationBindings } from "./generated/bindings";
import { getSdk } from "./generated/sdk";
import { createRequester, type OtpTransportOptions } from "./transport";

export type { OtpErrorKind } from "./errors";
export { OtpError } from "./errors";
export type {
  OtpPlanQuery,
  OtpPlanQueryVariables,
  PlanModesInput,
  TransitMode,
} from "./generated/sdk";

export function createOtpClient(options: OtpTransportOptions) {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new OtpError("configuration");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new OtpError("configuration");
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/otp/gtfs/v1`;
  const requester = createRequester({ ...options, endpoint: endpoint.href }, operationBindings);
  return {
    sdk: getSdk<AbortSignal | undefined>(requester.request),
    assertAvailable: requester.assertAvailable,
  };
}
export type OtpClient = ReturnType<typeof createOtpClient>;

export * from "./dynamic";
export type { OtpTransportOptions } from "./transport";
