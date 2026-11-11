import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as sdk from "../api/sharing-sdk";
import type { CreateShareInput } from "../types/share";
import type { MutationHookOptions } from "./mutationErrorDisplay";

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

export function useCreateShare(options: MutationHookOptions = {}) {
  const refresh = useRefreshShares();
  return useMutation({
    ...options,
    mutationFn: (input: CreateShareInput) => sdk.createShare(input).then(sdk.unwrapSharingResponse),
    onSuccess: refresh,
  });
}

export function useRotateShare(options: MutationHookOptions = {}) {
  const refresh = useRefreshShares();
  return useMutation({
    ...options,
    mutationFn: (id: string) => sdk.rotateShareToken(id).then(sdk.unwrapSharingResponse),
    onSuccess: refresh,
  });
}

export function useRevokeShare(options: MutationHookOptions = {}) {
  const refresh = useRefreshShares();
  return useMutation({
    ...options,
    mutationFn: (id: string) => sdk.revokeShare(id).then(sdk.unwrapSharingResponse),
    onSuccess: refresh,
  });
}
