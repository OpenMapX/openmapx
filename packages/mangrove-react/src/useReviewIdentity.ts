import { useMangroveSigner } from "./signerProvider";
import { useUserKeypair } from "./useKeypair";
export function useReviewIdentity() {
  const signer = useMangroveSigner();
  const local = useUserKeypair();
  if (signer.mode === "local")
    return {
      mode: "local" as const,
      publicPem: local.publicPem,
      canSign: !!local.keypair,
      needsConnection: false,
      needsSetup: local.needsSetup,
      needsUnlock: local.needsUnlock,
      isLoading: local.isLoading,
    };
  return {
    mode: "signer" as const,
    publicPem: signer.account?.publicPem ?? null,
    canSign:
      !!signer.account &&
      !!signer.config?.configured &&
      (signer.status === "connected" || signer.status === "error"),
    needsConnection: !signer.account || !signer.config?.configured,
    needsSetup: false,
    needsUnlock: false,
    isLoading: signer.status === "restoring",
  };
}
