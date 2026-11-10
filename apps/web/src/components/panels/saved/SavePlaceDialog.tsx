"use client";

import AddIcon from "@mui/icons-material/Add";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import {
  CALLER_SHOWS_ERRORS,
  isSystemSavedList,
  useCreateList,
  useIsSaved,
  useRemovePlace,
  useSavedLists,
  useSavePlace,
} from "@openmapx/core";
import { captureSavedPlaceContributors } from "@openmapx/core/saved-place-contributors";
import { listSavedListPlaces, unwrapSavedResponse } from "@openmapx/core/saved-places-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { BRAND, BRAND_LIGHT } from "@/integration-api/runtime/theme";
import { haptics } from "@/lib/haptics";
import { resolveListIcon } from "@/lib/listIcon";
import { type SavedWriteError, savedWriteError } from "@/lib/savedWriteError";

interface Props {
  open: boolean;
  onClose: () => void;
  place: Place;
}

export function SavePlaceDialog({ open, onClose, place }: Props) {
  const t = useTranslations("saved");

  const resolveListName = (name: string) => (isSystemSavedList(name) ? t(name.slice(1)) : name);

  const { data: lists, isLoading: listsLoading } = useSavedLists();
  const { data: savedInListIds } = useIsSaved(open ? place.id : null);

  const savePlaceMutation = useSavePlace(CALLER_SHOWS_ERRORS);
  const removePlaceMutation = useRemovePlace(CALLER_SHOWS_ERRORS);
  const createListMutation = useCreateList(CALLER_SHOWS_ERRORS);

  const [checkedLists, setCheckedLists] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [writeError, setWriteError] = useState<SavedWriteError | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  const queryClient = useQueryClient();
  const operations = useRef(
    new Map<
      string,
      {
        placeId: string;
        listId: string;
        desired: boolean;
        present: boolean;
        savedId: string | null;
        running: boolean;
      }
    >(),
  );
  const displayedPlace = useRef(place.id);
  displayedPlace.current = place.id;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const checked = new Set(savedInListIds ?? []);
    for (const [key, operation] of operations.current) {
      if (operation.placeId !== place.id) continue;
      if (!operation.running && checked.has(operation.listId) === operation.desired) {
        operations.current.delete(key);
      } else if (operation.desired) checked.add(operation.listId);
      else checked.delete(operation.listId);
    }
    setCheckedLists(checked);
  }, [savedInListIds, place.id]);

  const setMembership = useCallback(
    (listId: string, desired: boolean) => {
      const capturedPlace = place;
      const key = JSON.stringify([place.id, listId]);
      let operation = operations.current.get(key);
      if (!operation) {
        operation = {
          placeId: place.id,
          listId,
          desired,
          present: checkedLists.has(listId),
          savedId: null,
          running: false,
        };
        operations.current.set(key, operation);
      }
      operation.desired = desired;
      const updateCheckbox = (checked: boolean) => {
        if (!mounted.current || displayedPlace.current !== capturedPlace.id) return;
        setCheckedLists((previous) => {
          const next = new Set(previous);
          if (checked) next.add(listId);
          else next.delete(listId);
          return next;
        });
      };
      updateCheckbox(desired);
      if (operation.running) return;
      operation.running = true;
      const current = operation;
      void (async () => {
        try {
          while (true) {
            while (current.present !== current.desired) {
              if (current.desired) {
                const saved = await savePlaceMutation.mutateAsync({
                  listId,
                  name: capturedPlace.name,
                  address: capturedPlace.address || null,
                  lat: capturedPlace.coordinates[1],
                  lng: capturedPlace.coordinates[0],
                  placeId: capturedPlace.id,
                  fieldContributors: captureSavedPlaceContributors(capturedPlace),
                });
                current.savedId = saved.id;
                current.present = true;
              } else {
                if (!current.savedId) {
                  const response = unwrapSavedResponse(await listSavedListPlaces(listId));
                  current.savedId =
                    response.places.find((p) => p.placeId === capturedPlace.id)?.id ?? null;
                  if (!current.savedId) {
                    current.present = false;
                    continue;
                  }
                  // A reselect while resolving an existing row needs no deletion.
                  if (current.desired) continue;
                }
                await removePlaceMutation.mutateAsync(current.savedId);
                current.savedId = null;
                current.present = false;
              }
            }
            // Discard any membership response captured between the serialized writes.
            await queryClient.cancelQueries({
              queryKey: ["savedCheck", capturedPlace.id],
              exact: true,
            });
            if (current.present !== current.desired) continue;
            queryClient.setQueryData<string[]>(["savedCheck", capturedPlace.id], (previous) => {
              const next = new Set(previous ?? []);
              if (current.present) next.add(listId);
              else next.delete(listId);
              return [...next];
            });
            // Retire intent explicitly: structural sharing can suppress the
            // membership effect when the final server result is unchanged.
            operations.current.delete(key);
            break;
          }
        } catch (error) {
          operations.current.delete(key);
          updateCheckbox(current.present);
          if (mounted.current && displayedPlace.current === capturedPlace.id)
            setWriteError(savedWriteError(error));
        } finally {
          current.running = false;
          void queryClient.invalidateQueries({
            queryKey: ["savedCheck", capturedPlace.id],
            exact: true,
          });
        }
      })();
    },
    [checkedLists, place, queryClient, savePlaceMutation, removePlaceMutation],
  );

  const handleToggle = useCallback(
    (listId: string) => {
      const pending = operations.current.get(JSON.stringify([place.id, listId]));
      const desired = !(pending?.desired ?? checkedLists.has(listId));
      setWriteError(null);
      if (desired) haptics.success();
      setMembership(listId, desired);
    },
    [place.id, checkedLists, setMembership],
  );

  const handleCreateStart = () => {
    setCreating(true);
    setNewName("");
    setTimeout(() => createInputRef.current?.focus(), 50);
  };

  const handleCreateSubmit = () => {
    const trimmed = newName.trim();
    if (!trimmed) {
      setCreating(false);
      return;
    }
    setWriteError(null);
    createListMutation.mutate(
      { name: trimmed },
      {
        onSuccess: (newList) => {
          setCreating(false);
          setMembership(newList.id, true);
        },
        onError: (error) => setWriteError(savedWriteError(error)),
      },
    );
  };

  const handleCreateKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleCreateSubmit();
    } else if (e.key === "Escape") {
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      slotProps={{
        paper: { sx: { borderRadius: "12px" } },
      }}
    >
      <DialogTitle sx={{ fontWeight: 600, pb: 1 }}>{t("saveTo")}</DialogTitle>
      <DialogContent sx={{ px: 3, pb: 3 }}>
        {listsLoading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
            <CircularProgress size={28} sx={{ color: BRAND }} />
          </Box>
        ) : (
          <>
            {lists?.map((list) => (
              <Box
                key={list.id}
                onClick={() => handleToggle(list.id)}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  py: 0.75,
                  cursor: "pointer",
                  borderRadius: 1,
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                <Checkbox
                  checked={checkedLists.has(list.id)}
                  sx={{
                    color: "text.secondary",
                    "&.Mui-checked": { color: BRAND },
                  }}
                  size="small"
                  tabIndex={-1}
                />
                {resolveListIcon(list.icon, 20)}
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 500,
                  }}
                >
                  {resolveListName(list.name)}
                </Typography>
              </Box>
            ))}

            {creating ? (
              <TextField
                inputRef={createInputRef}
                fullWidth
                size="small"
                placeholder={t("enterListName")}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onBlur={handleCreateSubmit}
                onKeyDown={handleCreateKeyDown}
                sx={{ mt: 1.5 }}
              />
            ) : (
              <Button
                fullWidth
                startIcon={<AddIcon />}
                onClick={handleCreateStart}
                sx={{
                  mt: 1.5,
                  borderRadius: 24,
                  bgcolor: BRAND_LIGHT,
                  color: BRAND,
                  textTransform: "none",
                  fontWeight: 500,
                  "&:hover": { bgcolor: BRAND_LIGHT, filter: "brightness(0.95)" },
                }}
              >
                {t("createNewList")}
              </Button>
            )}
            {writeError && (
              <Alert severity="error" sx={{ mt: 1.5 }} onClose={() => setWriteError(null)}>
                {t(writeError.key, writeError.values)}
              </Alert>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
