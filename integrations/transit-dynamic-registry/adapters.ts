import type { RegisteredProtocolAdapter } from "./adapter-types";
import { hafasMgateAdapter } from "./hafas-mgate";
import { createOtpGraphQlAdapter } from "./otp-graphql";
import type { ProtocolType } from "./registry-types";
export function getAdapter(
  protocol: ProtocolType,
  otp: Parameters<typeof createOtpGraphQlAdapter>[0],
): RegisteredProtocolAdapter | null {
  return protocol === "hafasMgate"
    ? hafasMgateAdapter
    : protocol === "otpGraphQl"
      ? createOtpGraphQlAdapter(otp)
      : null;
}
