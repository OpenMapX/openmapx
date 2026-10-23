import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as sdk from "../api/sharing-sdk";
import type { CreateShareInput } from "../types/share";

export function useShares(enabled = true) {
  return useQuery({
    queryKey: ["shares"],
    queryFn: ({ signal }) =>
      sdk
        .listOwnerShares({ signal })
        .then(sdk.unwrapSharingResponse)
        .then((r) => r.shares),
    enabled,
    staleTime: 30_000,
  });
}

/** Retire pre-mutation reads before acquiring the authoritative post-mutation list. */
function useRefreshShares() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.cancelQueries({ queryKey: ["shares"] });
    await queryClient.invalidateQueries({ queryKey: ["shares"] });
  };
}

export function useCreateShare() {
  const refresh = useRefreshShares();
  return useMutation({
    mutationFn: (input: CreateShareInput) => sdk.createShare(input).then(sdk.unwrapSharingResponse),
    onSuccess: refresh,
  });
}

export function useRotateShare() {
  const refresh = useRefreshShares();
  return useMutation({
    mutationFn: (id: string) => sdk.rotateShareToken(id).then(sdk.unwrapSharingResponse),
    onSuccess: refresh,
  });
}

export function useRevokeShare() {
  const refresh = useRefreshShares();
  return useMutation({
    mutationFn: (id: string) => sdk.revokeShare(id).then(sdk.unwrapSharingResponse),
    onSuccess: refresh,
  });
}
