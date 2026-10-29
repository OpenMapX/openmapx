import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as sdk from "../api/saved-sdk";
import { useSession } from "../auth/useSession";

export type { ImportPlacesInput, ImportPlacesResult } from "../api/contracts/saved";

import type { ImportPlacesInput } from "../api/contracts/saved";

/**
 * Saved data lives on the server per account, so a signed-out visitor has none
 * to fetch. Cached data (the offline mirror seeds it) is still served while the
 * queries are disabled.
 */
function useSignedIn(): boolean {
  const { data: session } = useSession();
  return Boolean(session?.user);
}

export function useSavedLists() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ["savedLists"],
    queryFn: ({ signal }) =>
      sdk
        .listSavedLists({ signal })
        .then(sdk.unwrapSavedResponse)
        .then((r) => r.lists),
    enabled: signedIn,
    staleTime: 60_000,
  });
}

export function useSavedListPlaces(listId: string | null) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ["savedListPlaces", listId],
    queryFn: ({ signal }) =>
      sdk
        .listSavedListPlaces(listId ?? "", { signal })
        .then(sdk.unwrapSavedResponse)
        .then((r) => r.places),
    enabled: signedIn && listId !== null,
    staleTime: 30_000,
  });
}

export function useLabeledPlaces() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ["labeledPlaces"],
    queryFn: ({ signal }) =>
      sdk
        .listSavedLabels({ signal })
        .then(sdk.unwrapSavedResponse)
        .then((r) => r.labels),
    enabled: signedIn,
    staleTime: 60_000,
  });
}

export function useIsSaved(placeId: string | null) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ["savedCheck", placeId],
    queryFn: ({ signal }) =>
      sdk
        .checkSavedPlace({ placeId: placeId ?? "" }, { signal })
        .then(sdk.unwrapSavedResponse)
        .then((r) => r.listIds),
    enabled: signedIn && placeId !== null,
    staleTime: 30_000,
  });
}

export function useCreateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: sdk.CreateSavedListInput) =>
      sdk.createSavedList(data).then(sdk.unwrapSavedResponse),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["savedLists"] });
    },
  });
}

export function useImportPlaces() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ImportPlacesInput) =>
      sdk.importSavedPlaces(data).then(sdk.unwrapSavedResponse),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["savedLists"] });
      void queryClient.invalidateQueries({ queryKey: ["savedListPlaces", result.listId] });
      void queryClient.invalidateQueries({ queryKey: ["savedCheck"] });
    },
  });
}

export function useUpdateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: sdk.UpdateSavedListInput & { id: string }) =>
      sdk.updateSavedList(id, data).then(sdk.unwrapSavedResponse),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["savedLists"] });
    },
  });
}

export function useDeleteList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sdk.deleteSavedList(id).then(sdk.unwrapSavedResponse),
    onSuccess: async (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["savedLists"] });
      queryClient.removeQueries({ queryKey: ["savedListPlaces", id], exact: true });
      // Invalidation can reuse an initial fetch with no cached data. Discard
      // that pre-deletion response before starting the membership refresh.
      await queryClient.cancelQueries({ queryKey: ["savedCheck"] });
      void queryClient.invalidateQueries({ queryKey: ["savedCheck"] });
    },
  });
}

export function useSavePlace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, ...data }: sdk.CreateSavedPlaceInput & { listId: string }) =>
      sdk.createSavedPlace(listId, data).then(sdk.unwrapSavedResponse),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["savedLists"] });
      void queryClient.invalidateQueries({ queryKey: ["savedListPlaces", vars.listId] });
      void queryClient.invalidateQueries({ queryKey: ["savedCheck"] });
    },
  });
}

export function useRemovePlace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sdk.deleteSavedPlace(id).then(sdk.unwrapSavedResponse),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["savedLists"] });
      void queryClient.invalidateQueries({ queryKey: ["savedListPlaces"] });
      void queryClient.invalidateQueries({ queryKey: ["savedCheck"] });
    },
  });
}

export function useUpdatePlace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: sdk.UpdateSavedPlaceInput & { id: string }) =>
      sdk.updateSavedPlace(id, data).then(sdk.unwrapSavedResponse),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["savedListPlaces"] });
    },
  });
}

export function useUpdateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ label, ...data }: sdk.WriteSavedLabelInput & { label: string }) =>
      sdk.writeSavedLabel(label, data).then(sdk.unwrapSavedResponse),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["labeledPlaces"] });
    },
  });
}

export function useDeleteLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => sdk.deleteSavedLabel(label).then(sdk.unwrapSavedResponse),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["labeledPlaces"] });
    },
  });
}
