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
  useCreateList,
  useIsSaved,
  useRemovePlace,
  useSavedLists,
  useSavePlace,
} from "@openmapx/core";
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

  const resolveListName = (name: string) => (name.startsWith("$") ? t(name.slice(1)) : name);

  const { data: lists, isLoading: listsLoading } = useSavedLists();
  const { data: savedInListIds } = useIsSaved(open ? place.id : null);

  const savePlaceMutation = useSavePlace();
  const removePlaceMutation = useRemovePlace();
  const createListMutation = useCreateList();

  const [checkedLists, setCheckedLists] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (savedInListIds) {
      setCheckedLists(new Set(savedInListIds));
    }
  }, [savedInListIds]);

  const handleToggle = useCallback(
    async (listId: string) => {
      const isCurrentlyChecked = checkedLists.has(listId);

      if (isCurrentlyChecked) {
        setCheckedLists((prev) => {
          const next = new Set(prev);
          next.delete(listId);
          return next;
        });

        try {
          const res = await apiClient.get<{ places: SavedPlace[] }>(
            `${API_ENDPOINTS.savedLists}/${listId}/places`,
          );
          const match = res.places.find((p) => p.placeId === place.id);
          if (match) {
            removePlaceMutation.mutate(match.id);
          }
        } catch {
          setCheckedLists((prev) => new Set([...prev, listId]));
        }
      } else {
        setCheckedLists((prev) => new Set([...prev, listId]));
        haptics.success();
        savePlaceMutation.mutate({
          listId,
          name: place.name,
          address: place.address || null,
          lat: place.coordinates[1],
          lng: place.coordinates[0],
          placeId: place.id,
        });
      }
    },
    [checkedLists, place, savePlaceMutation, removePlaceMutation],
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
          savePlaceMutation.mutate({
            listId: newList.id,
            name: place.name,
            address: place.address || null,
            lat: place.coordinates[1],
            lng: place.coordinates[0],
            placeId: place.id,
          });
          setCheckedLists((prev) => new Set([...prev, newList.id]));
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
