"use client";

import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import LockIcon from "@mui/icons-material/Lock";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import ShareIcon from "@mui/icons-material/Share";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Popover from "@mui/material/Popover";
import Snackbar from "@mui/material/Snackbar";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { SavedPlace } from "@openmapx/core";
import {
  createPlace,
  idsFromPrimary,
  PANEL,
  useDeleteList,
  usePlaceStore,
  useSavedListPlaces,
  useSavedLists,
  useSavedPlacesStore,
  useSidebarStore,
  useUpdateList,
  useUpdatePlace,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import type React from "react";
import { useState } from "react";
import { shareCurrentUrl } from "@/lib/deepLink";
import { resolveListIcon } from "@/lib/listIcon";
import { useMap } from "@/lib/MapContext";
import { TEAL, TEAL_LIGHT } from "@/lib/theme";
import { PlaceThumbnail } from "./PlaceThumbnail";

export function SavedListDetail() {
  const t = useTranslations("saved");
  const tCommon = useTranslations("common");

  const resolveListName = (name: string) => (name.startsWith("$") ? t(name.slice(1)) : name);

  const selectedListId = useSavedPlacesStore((s) => s.selectedListId);
  const clearSelectedList = useSavedPlacesStore((s) => s.clearSelectedList);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const { flyTo } = useMap();

  const { data: lists } = useSavedLists();
  const { data: places, isLoading: placesLoading } = useSavedListPlaces(selectedListId);

  const updateListMutation = useUpdateList();
  const deleteListMutation = useDeleteList();
  const updatePlaceMutation = useUpdatePlace();

  const list = lists?.find((l) => l.id === selectedListId);

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(list ? resolveListName(list.name) : "");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [iconAnchor, setIconAnchor] = useState<HTMLElement | null>(null);
  const [noteEditId, setNoteEditId] = useState<string | null>(null);
  const [noteValue, setNoteValue] = useState("");
  const [snackbarOpen, setSnackbarOpen] = useState(false);

  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>) => {
    setMenuAnchor(e.currentTarget);
  };

  const handleMenuClose = () => {
    setMenuAnchor(null);
  };

  const NAME_MAX = 40;

  const handleNameFocus = () => {
    setNameValue(list ? resolveListName(list.name) : "");
    setEditingName(true);
  };

  const handleNameBlur = () => {
    if (!selectedListId || !list) return;
    const trimmed = nameValue.trim();
    const currentDisplay = resolveListName(list.name);
    if (trimmed && trimmed !== currentDisplay) {
      updateListMutation.mutate({ id: selectedListId, name: trimmed });
    }
    setEditingName(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
  };

  const handleDeleteStart = () => {
    setDeleteDialogOpen(true);
    handleMenuClose();
  };

  const handleDeleteConfirm = () => {
    if (selectedListId) {
      deleteListMutation.mutate(selectedListId, { onSuccess: () => clearSelectedList() });
    }
    setDeleteDialogOpen(false);
  };

  const handlePlaceClick = (place: SavedPlace) => {
    const identity = (place.placeId ? idsFromPrimary(place.placeId) : null) ?? {
      primaryScheme: "saved",
      ids: { saved: place.id },
    };
    setSelectedPlace(
      createPlace({
        ...identity,
        name: place.name,
        address: place.address ?? "",
        coordinates: [place.lng, place.lat],
      }),
    );
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    flyTo([place.lng, place.lat], 15);
  };

  const handleAddNoteClick = (e: React.MouseEvent, place: SavedPlace) => {
    e.stopPropagation();
    setNoteEditId(place.id);
    setNoteValue(place.note ?? "");
  };

  const handleNoteSubmit = () => {
    if (!noteEditId) return;
    const trimmed = noteValue.trim();
    updatePlaceMutation.mutate(
      { id: noteEditId, note: trimmed || null },
      { onSuccess: () => setNoteEditId(null) },
    );
  };

  const handleNoteKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleNoteSubmit();
    } else if (e.key === "Escape") {
      setNoteEditId(null);
    }
  };

  if (!list) {
    return null;
  }

  const isDefault = list.name.startsWith("$");

  const handleIconSelect = (emoji: string) => {
    if (!selectedListId) return;
    updateListMutation.mutate({ id: selectedListId, icon: emoji });
    setIconAnchor(null);
  };

  const handleIconClear = () => {
    if (!selectedListId) return;
    updateListMutation.mutate({ id: selectedListId, icon: null });
    setIconAnchor(null);
  };

  const handleShare = async () => {
    const result = await shareCurrentUrl({ title: resolveListName(list.name) });
    if (result === "copied") setSnackbarOpen(true);
  };

  return (
    <Box>
      <Box sx={{ px: 2, pb: 2 }}>
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.5 }}>
          <Box
            onClick={isDefault ? undefined : (e) => setIconAnchor(e.currentTarget)}
            sx={{
              mt: 0.5,
              width: 40,
              height: 40,
              borderRadius: 1,
              bgcolor: "grey.100",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: isDefault ? "default" : "pointer",
              flexShrink: 0,
              ...(!isDefault && { "&:hover": { bgcolor: "grey.200" } }),
            }}
          >
            {resolveListIcon(list.icon, 28)}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {isDefault ? (
              <Typography variant="h6" fontWeight={600} sx={{ py: 0.5 }}>
                {resolveListName(list.name)}
              </Typography>
            ) : (
              <>
                <TextField
                  fullWidth
                  variant="standard"
                  value={editingName ? nameValue : resolveListName(list.name)}
                  onChange={(e) => {
                    if (e.target.value.length <= NAME_MAX) setNameValue(e.target.value);
                  }}
                  onFocus={handleNameFocus}
                  onBlur={handleNameBlur}
                  onKeyDown={handleNameKeyDown}
                  slotProps={{
                    input: {
                      disableUnderline: true,
                      sx: {
                        fontSize: "1.25rem",
                        fontWeight: 600,
                        lineHeight: 1.4,
                        px: 1,
                        py: 0.5,
                        borderRadius: 1,
                        "&:hover": { bgcolor: "action.hover" },
                        "&.Mui-focused": { bgcolor: "action.hover" },
                      },
                    },
                  }}
                />
                {editingName && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mt: 0.25, display: "block", textAlign: "right" }}
                  >
                    {nameValue.length}/{NAME_MAX}
                  </Typography>
                )}
              </>
            )}
          </Box>
          <IconButton size="small" onClick={handleMenuOpen} sx={{ mt: 0.5 }}>
            <MoreVertIcon />
          </IconButton>
        </Box>

        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.5 }}>
          {list.isPrivate && <LockIcon sx={{ fontSize: 14, color: "text.secondary" }} />}
          <Typography variant="caption" color="text.secondary">
            {list.isPrivate ? t("private") : t("shared")}
            {" \u00b7 "}
            {t("places", { count: list.placeCount })}
          </Typography>
        </Box>

        <Box sx={{ display: "flex", gap: 1, mt: 1.5 }}>
          <Button
            startIcon={<ShareIcon sx={{ fontSize: 18 }} />}
            onClick={handleShare}
            sx={{
              borderRadius: 24,
              bgcolor: TEAL_LIGHT,
              color: TEAL,
              textTransform: "none",
              fontWeight: 500,
              fontSize: 13,
              px: 2,
              py: 0.75,
              "&:hover": { bgcolor: TEAL_LIGHT, filter: "brightness(0.95)" },
            }}
          >
            {t("share")}
          </Button>
          <Button
            startIcon={<AddIcon sx={{ fontSize: 18 }} />}
            sx={{
              borderRadius: 24,
              bgcolor: TEAL_LIGHT,
              color: TEAL,
              textTransform: "none",
              fontWeight: 500,
              fontSize: 13,
              px: 2,
              py: 0.75,
              "&:hover": { bgcolor: TEAL_LIGHT, filter: "brightness(0.95)" },
            }}
          >
            {t("addPlace")}
          </Button>
        </Box>
      </Box>

      <Divider />

      {placesLoading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
          <CircularProgress size={28} sx={{ color: TEAL }} />
        </Box>
      ) : !places || places.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: "center", py: 4 }}>
          {t("places", { count: 0 })}
        </Typography>
      ) : (
        <Box>
          {places.map((place) => (
            <Box
              key={place.id}
              onClick={() => handlePlaceClick(place)}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                px: 2,
                py: 1.5,
                cursor: "pointer",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <PlaceThumbnail
                lat={place.lat}
                lng={place.lng}
                name={place.name}
                placeId={place.placeId}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" fontWeight={500} noWrap>
                  {place.name}
                </Typography>
                {place.address && (
                  <Typography variant="caption" color="text.secondary" noWrap display="block">
                    {place.address}
                  </Typography>
                )}
                {noteEditId === place.id ? (
                  <TextField
                    fullWidth
                    size="small"
                    placeholder={t("note")}
                    value={noteValue}
                    onChange={(e) => setNoteValue(e.target.value)}
                    onBlur={handleNoteSubmit}
                    onKeyDown={handleNoteKeyDown}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                    sx={{ mt: 0.5 }}
                  />
                ) : place.note ? (
                  <Typography
                    variant="caption"
                    onClick={(e) => handleAddNoteClick(e, place)}
                    sx={{
                      color: TEAL,
                      display: "block",
                      mt: 0.25,
                      cursor: "pointer",
                      "&:hover": { textDecoration: "underline" },
                    }}
                  >
                    {place.note}
                  </Typography>
                ) : null}
              </Box>
              {noteEditId !== place.id && !place.note && (
                <Typography
                  variant="caption"
                  onClick={(e) => handleAddNoteClick(e, place)}
                  sx={{
                    color: TEAL,
                    cursor: "pointer",
                    flexShrink: 0,
                    ml: 1,
                    whiteSpace: "nowrap",
                    "&:hover": { textDecoration: "underline" },
                  }}
                >
                  + {t("note")}
                </Typography>
              )}
            </Box>
          ))}
        </Box>
      )}

      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={handleMenuClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {!isDefault && list.icon && list.icon.charCodeAt(0) > 127 && (
          <MenuItem
            onClick={() => {
              handleIconClear();
              handleMenuClose();
            }}
          >
            <ListItemText>{t("removeIcon")}</ListItemText>
          </MenuItem>
        )}
        <MenuItem onClick={handleDeleteStart}>
          <ListItemIcon>
            <DeleteIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("deleteList")}</ListItemText>
        </MenuItem>
      </Menu>

      <Popover
        open={Boolean(iconAnchor)}
        anchorEl={iconAnchor}
        onClose={() => setIconAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        disableAutoFocus
        disableEnforceFocus
        disableRestoreFocus
        slotProps={{ paper: { sx: { borderRadius: 3, overflow: "hidden" } } }}
      >
        <Picker
          data={data}
          onEmojiSelect={(emoji: { native: string }) => handleIconSelect(emoji.native)}
          theme="light"
          previewPosition="none"
          skinTonePosition="search"
        />
      </Popover>

      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>{t("delete")}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t("deleteListConfirm")}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>{tCommon("cancel")}</Button>
          <Button onClick={handleDeleteConfirm} color="error" variant="contained">
            {t("delete")}
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={2500}
        onClose={() => setSnackbarOpen(false)}
        message={tCommon("copied")}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Box>
  );
}
