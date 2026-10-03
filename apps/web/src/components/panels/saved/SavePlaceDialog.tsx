"use client";

import AddIcon from "@mui/icons-material/Add";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { Place, SavedPlace } from "@openmapx/core";
import {
  API_ENDPOINTS,
  apiClient,
  isSystemSavedList,
  useCreateList,
  useIsSaved,
  useRemovePlace,
  useSavedLists,
  useSavePlace,
} from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { BRAND, BRAND_LIGHT } from "@/integration-api/runtime/theme";
import { haptics } from "@/lib/haptics";
import { resolveListIcon } from "@/lib/listIcon";

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

  const savePlaceMutation = useSavePlace();
  const removePlaceMutation = useRemovePlace();
  const createListMutation = useCreateList();

  const [checkedLists, setCheckedLists] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
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
                });
                current.savedId = saved.id;
                current.present = true;
              } else {
                if (!current.savedId) {
                  const response = await apiClient.get<{ places: SavedPlace[] }>(
                    `${API_ENDPOINTS.savedLists}/${listId}/places`,
                  );
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
            break;
          }
        } catch {
          operations.current.delete(key);
          updateCheckbox(current.present);
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
    createListMutation.mutate(
      { name: trimmed },
      {
        onSuccess: (newList) => {
          setCreating(false);
          setMembership(newList.id, true);
        },
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
