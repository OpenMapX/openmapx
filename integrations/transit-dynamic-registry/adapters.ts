import type { ProtocolAdapter } from "./adapter-types";
import { hafasMgateAdapter } from "./hafas-mgate";
import { otpGraphQlAdapter } from "./otp-graphql";
import type { ProtocolType } from "./registry-types";

const adapterMap: Partial<Record<ProtocolType, ProtocolAdapter>> = {
  hafasMgate: hafasMgateAdapter,
  otpGraphQl: otpGraphQlAdapter,
};

export function getAdapter(protocol: ProtocolType): ProtocolAdapter | null {
  return adapterMap[protocol] ?? null;
}
