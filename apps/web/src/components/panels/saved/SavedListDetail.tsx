"use client";

import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import DownloadIcon from "@mui/icons-material/Download";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import LockIcon from "@mui/icons-material/Lock";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import ShareIcon from "@mui/icons-material/Share";
import UploadFileIcon from "@mui/icons-material/UploadFile";
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
  isSystemSavedList,
  useDeleteList,
  useSavedListPlaces,
  useSavedLists,
  useSavedPlacesStore,
  useUpdateList,
  useUpdatePlace,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import type React from "react";
import { useRef, useState } from "react";
import { AttributionDetailsGroup } from "@/components/ui/AttributionDetailsGroup";
import { useMap } from "@/integration-api/map/MapContext";
import { BRAND, BRAND_LIGHT } from "@/integration-api/runtime/theme";
import { exportSavedList } from "@/lib/exportSavedList";
import { resolveListIcon } from "@/lib/listIcon";
import { openSavedPlace } from "@/lib/openSavedPlace";
import { ImportPlacesPicker } from "./ImportPlacesPicker";
import { SavedListRows } from "./SavedListRows";
import { ShareListDialog } from "./ShareListDialog";

export function SavedListDetail() {
  const importInput = useRef<HTMLInputElement>(null);
  const t = useTranslations("saved");
  const tCommon = useTranslations("common");

  const resolveListName = (name: string) => (isSystemSavedList(name) ? t(name.slice(1)) : name);

  const selectedListId = useSavedPlacesStore((s) => s.selectedListId);
  const clearSelectedList = useSavedPlacesStore((s) => s.clearSelectedList);
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
  // Each open or edit creates a new snapshot; a save may close only the snapshot it submitted.
  const [noteEdit, setNoteEdit] = useState<{ placeId: string; value: string } | null>(null);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState(tCommon("copied"));
  const [shareDialogOpen, setShareDialogOpen] = useState(false);

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

  const handlePlaceClick = (place: SavedPlace) => openSavedPlace(place, flyTo);

  const handleAddNoteClick = (e: React.MouseEvent, place: SavedPlace) => {
    e.stopPropagation();
    setNoteEdit({ placeId: place.id, value: place.note ?? "" });
  };

  const handleNoteSubmit = () => {
    if (!noteEdit) return;
    const submitted = noteEdit;
    const trimmed = submitted.value.trim();
    updatePlaceMutation.mutate(
      { id: submitted.placeId, note: trimmed || null },
      { onSuccess: () => setNoteEdit((current) => (current === submitted ? null : current)) },
    );
  };

  const handleNoteKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleNoteSubmit();
    } else if (e.key === "Escape") {
      setNoteEdit(null);
    }
  };

  if (!list) {
    return null;
  }

  const isDefault = isSystemSavedList(list.name);

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

  const handleShare = () => setShareDialogOpen(true);

  const handleExport = async (format: "gpx" | "geojson" | "kml") => {
    handleMenuClose();
    if (!list) return;
    const ext = format === "geojson" ? "geojson" : format;
    try {
      await exportSavedList(list.id, format, `${resolveListName(list.name)}.${ext}`);
    } catch {
      setSnackbarMessage(t("exportFailed"));
      setSnackbarOpen(true);
    }
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
              bgcolor: "action.hover",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: isDefault ? "default" : "pointer",
              flexShrink: 0,
              ...(!isDefault && { "&:hover": { bgcolor: "action.selected" } }),
            }}
          >
            {resolveListIcon(list.icon, 28)}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {isDefault ? (
              <Typography
                variant="h6"
                sx={{
                  fontWeight: 600,
                  py: 0.5,
                }}
              >
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
                    sx={{
                      color: "text.secondary",
                      mt: 0.25,
                      display: "block",
                      textAlign: "right",
                    }}
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
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
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
              bgcolor: BRAND_LIGHT,
              color: BRAND,
              textTransform: "none",
              fontWeight: 500,
              fontSize: 13,
              px: 2,
              py: 0.75,
              "&:hover": { bgcolor: BRAND_LIGHT, filter: "brightness(0.95)" },
            }}
          >
            {t("share")}
          </Button>
          <Button
            startIcon={<AddIcon sx={{ fontSize: 18 }} />}
            sx={{
              borderRadius: 24,
              bgcolor: BRAND_LIGHT,
              color: BRAND,
              textTransform: "none",
              fontWeight: 500,
              fontSize: 13,
              px: 2,
              py: 0.75,
              "&:hover": { bgcolor: BRAND_LIGHT, filter: "brightness(0.95)" },
            }}
          >
            {t("addPlace")}
          </Button>
        </Box>
      </Box>
      <Divider />
      {placesLoading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
          <CircularProgress size={28} sx={{ color: BRAND }} />
        </Box>
      ) : !places || places.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            textAlign: "center",
            py: 4,
          }}
        >
          {t("places", { count: 0 })}
        </Typography>
      ) : (
        <AttributionDetailsGroup placement="footer">
          <SavedListRows
            places={places}
            onSelect={handlePlaceClick}
            renderNote={(place) =>
              noteEdit?.placeId === place.id ? (
                <TextField
                  fullWidth
                  size="small"
                  placeholder={t("note")}
                  value={noteEdit.value}
                  onChange={(e) => {
                    const value = e.target.value;
                    setNoteEdit((current) => current && { ...current, value });
                  }}
                  onBlur={handleNoteSubmit}
                  onKeyDown={handleNoteKeyDown}
                  autoFocus
                  sx={{ mt: 0.5 }}
                />
              ) : place.note ? (
                <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5 }}>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      flex: 1,
                      minWidth: 0,
                      pt: 0.25,
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {place.note}
                  </Typography>
                  <IconButton
                    size="small"
                    aria-label={t("editNote")}
                    onClick={(e) => handleAddNoteClick(e, place)}
                    sx={{ p: 0.25, mr: -0.25 }}
                  >
                    <EditOutlinedIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Box>
              ) : (
                <Button
                  size="small"
                  onClick={(e) => handleAddNoteClick(e, place)}
                  sx={{
                    color: BRAND,
                    p: 0,
                    minWidth: 0,
                    fontSize: 12,
                    textTransform: "none",
                  }}
                >
                  + {t("note")}
                </Button>
              )
            }
          />
        </AttributionDetailsGroup>
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
        <MenuItem
          onClick={() => {
            handleMenuClose();
            importInput.current?.click();
          }}
        >
          <ListItemIcon>
            <UploadFileIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("importPlaces")}</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => handleExport("gpx")}>
          <ListItemIcon>
            <DownloadIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("exportAsGpx")}</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => handleExport("geojson")}>
          <ListItemIcon>
            <DownloadIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("exportAsGeoJson")}</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => handleExport("kml")}>
          <ListItemIcon>
            <DownloadIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("exportAsKml")}</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleDeleteStart}>
          <ListItemIcon>
            <DeleteIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("deleteList")}</ListItemText>
        </MenuItem>
      </Menu>
      <ImportPlacesPicker inputRef={importInput} targetListId={selectedListId || undefined} />
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
        message={snackbarMessage}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
      {selectedListId && (
        <ShareListDialog
          open={shareDialogOpen}
          listId={selectedListId}
          listName={resolveListName(list.name)}
          onClose={() => setShareDialogOpen(false)}
        />
      )}
    </Box>
  );
}
