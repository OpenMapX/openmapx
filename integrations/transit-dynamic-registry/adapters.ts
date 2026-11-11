import type { ProtocolAdapter, RegisteredProtocolAdapter } from "./adapter-types";
import { createOtpGraphQlAdapter } from "./otp-graphql";
import type { ProtocolType } from "./registry-types";
/** `hafas` is the setup generation's HAFAS adapter, which owns its library clients. */
export function getAdapter(
  protocol: ProtocolType,
  otp: Parameters<typeof createOtpGraphQlAdapter>[0],
  hafas: ProtocolAdapter,
): RegisteredProtocolAdapter | null {
  return protocol === "hafasMgate"
    ? hafas
    : protocol === "otpGraphQl"
      ? createOtpGraphQlAdapter(otp)
      : null;
}
