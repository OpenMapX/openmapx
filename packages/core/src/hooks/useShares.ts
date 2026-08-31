import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { CreateShareInput, OwnerShare } from "../types/share";

export function useShares(enabled = true) {
  return useQuery({
    queryKey: ["shares"],
    queryFn: () =>
      apiClient.get<{ shares: OwnerShare[] }>(API_ENDPOINTS.shares).then((r) => r.shares),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateShareInput) =>
      apiClient.post<{ id: string; token: string; share: OwnerShare }>(API_ENDPOINTS.shares, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shares"] });
    },
  });
}

export function useRotateShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ token: string }>(`${API_ENDPOINTS.shares}/${id}/rotate`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shares"] });
    },
  });
}

export function useRevokeShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`${API_ENDPOINTS.shares}/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shares"] });
    },
  });
}
