import type { ProtocolType } from "../registry/types";
import { hafasMgateAdapter } from "./hafas-mgate";
import { otpGraphQlAdapter } from "./otp-graphql";
import type { ProtocolAdapter } from "./types";

const adapterMap: Partial<Record<ProtocolType, ProtocolAdapter>> = {
  hafasMgate: hafasMgateAdapter,
  otpGraphQl: otpGraphQlAdapter,
};

export function getAdapter(protocol: ProtocolType): ProtocolAdapter | null {
  return adapterMap[protocol] ?? null;
}
