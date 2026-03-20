import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { LabeledPlace, SavedList, SavedPlace } from "../types/saved";

export function useSavedLists() {
  return useQuery({
    queryKey: ["savedLists"],
    queryFn: () =>
      apiClient.get<{ lists: SavedList[] }>(API_ENDPOINTS.savedLists).then((r) => r.lists),
    staleTime: 60_000,
  });
}

export function useSavedListPlaces(listId: string | null) {
  return useQuery({
    queryKey: ["savedListPlaces", listId],
    queryFn: () =>
      apiClient
        .get<{ places: SavedPlace[] }>(`${API_ENDPOINTS.savedLists}/${listId}/places`)
        .then((r) => r.places),
    enabled: listId !== null,
    staleTime: 30_000,
  });
}

export function useLabeledPlaces() {
  return useQuery({
    queryKey: ["labeledPlaces"],
    queryFn: () =>
      apiClient.get<{ labels: LabeledPlace[] }>(API_ENDPOINTS.savedLabels).then((r) => r.labels),
    staleTime: 60_000,
  });
}

export function useIsSaved(placeId: string | null) {
  return useQuery({
    queryKey: ["savedCheck", placeId],
    queryFn: () =>
      apiClient
        .get<{ listIds: string[] }>(API_ENDPOINTS.savedCheck, { placeId: placeId as string })
        .then((r) => r.listIds),
    enabled: placeId !== null,
    staleTime: 30_000,
  });
}

export function useCreateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; icon?: string; isPrivate?: boolean }) =>
      apiClient.post<SavedList>(API_ENDPOINTS.savedLists, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["savedLists"] });
    },
  });
}

export function useUpdateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: string;
      name?: string;
      icon?: string | null;
      isPrivate?: boolean;
    }) => apiClient.patch<SavedList>(`${API_ENDPOINTS.savedLists}/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["savedLists"] });
    },
  });
}

export function useDeleteList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`${API_ENDPOINTS.savedLists}/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["savedLists"] });
    },
  });
}

export function useSavePlace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      listId,
      ...data
    }: {
      listId: string;
      name: string;
      address?: string | null;
      lat: number;
      lng: number;
      placeId?: string | null;
      note?: string | null;
    }) => apiClient.post<SavedPlace>(`${API_ENDPOINTS.savedLists}/${listId}/places`, data),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["savedLists"] });
      queryClient.invalidateQueries({ queryKey: ["savedListPlaces", vars.listId] });
      queryClient.invalidateQueries({ queryKey: ["savedCheck"] });
    },
  });
}

export function useRemovePlace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`${API_ENDPOINTS.savedPlaces}/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["savedLists"] });
      queryClient.invalidateQueries({ queryKey: ["savedListPlaces"] });
      queryClient.invalidateQueries({ queryKey: ["savedCheck"] });
    },
  });
}

export function useUpdatePlace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; note?: string | null; sortOrder?: number }) =>
      apiClient.patch<SavedPlace>(`${API_ENDPOINTS.savedPlaces}/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["savedListPlaces"] });
    },
  });
}

export function useUpdateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      label,
      ...data
    }: {
      label: string;
      icon?: string | null;
      name: string;
      address?: string | null;
      lat: number;
      lng: number;
      placeId?: string | null;
    }) =>
      apiClient.put<LabeledPlace>(
        `${API_ENDPOINTS.savedLabels}/${encodeURIComponent(label)}`,
        data,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labeledPlaces"] });
    },
  });
}

export function useDeleteLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: string) =>
      apiClient.delete(`${API_ENDPOINTS.savedLabels}/${encodeURIComponent(label)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labeledPlaces"] });
    },
  });
}
