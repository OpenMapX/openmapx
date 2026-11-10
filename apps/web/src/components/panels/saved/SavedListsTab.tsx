"use client";

import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import LockIcon from "@mui/icons-material/Lock";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import type { SavedList } from "@openmapx/core";
import {
  CALLER_SHOWS_ERRORS,
  isSystemSavedList,
  useCreateList,
  useDeleteList,
  useSavedLists,
  useSavedPlacesStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import type React from "react";
import { useRef, useState } from "react";
import { ClickableRow } from "@/components/ui/ClickableRow";
import Dialog from "@/components/ui/Dialog";
import Menu from "@/components/ui/Menu";
import { BRAND, BRAND_LIGHT } from "@/integration-api/runtime/theme";
import { resolveListIcon } from "@/lib/listIcon";
import { type SavedWriteError, savedWriteError } from "@/lib/savedWriteError";

import { ImportPlacesPicker } from "./ImportPlacesPicker";

export function SavedListsTab() {
  const importInput = useRef<HTMLInputElement>(null);
  const t = useTranslations("saved");
  const tCommon = useTranslations("common");

  const resolveListName = (name: string) => (isSystemSavedList(name) ? t(name.slice(1)) : name);

  const { data: lists, isLoading } = useSavedLists();
  const selectList = useSavedPlacesStore((s) => s.selectList);

  const createListMutation = useCreateList(CALLER_SHOWS_ERRORS);
  const deleteListMutation = useDeleteList();

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [menuList, setMenuList] = useState<SavedList | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SavedList | null>(null);

  const [createError, setCreateError] = useState<SavedWriteError | null>(null);

  const handleCreate = () => {
    setCreateError(null);
    // List names are unique per account, so a second unnamed list gets a number.
    const taken = new Set(lists?.map((list) => list.name));
    const base = t("untitledList");
    let name = base;
    for (let suffix = 2; taken.has(name); suffix++) name = `${base} (${suffix})`;
    createListMutation.mutate(
      { name },
      {
        onSuccess: (created) => {
          selectList(created.id);
        },
        onError: (error) => setCreateError(savedWriteError(error)),
      },
    );
  };

  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>, list: SavedList) => {
    e.stopPropagation();
    setMenuAnchor(e.currentTarget);
    setMenuList(list);
  };

  const handleMenuClose = () => {
    setMenuAnchor(null);
    setMenuList(null);
  };

  const handleDeleteStart = () => {
    setDeleteTarget(menuList);
    setDeleteDialogOpen(true);
    handleMenuClose();
  };

  const handleDeleteConfirm = () => {
    if (deleteTarget) {
      deleteListMutation.mutate(deleteTarget.id);
    }
    setDeleteDialogOpen(false);
    setDeleteTarget(null);
  };

  if (isLoading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress size={28} sx={{ color: BRAND }} />
      </Box>
    );
  }

  return (
    <Box sx={{ px: 2, py: 1.5 }}>
      <Button
        fullWidth
        startIcon={<AddIcon />}
        onClick={handleCreate}
        disabled={createListMutation.isPending}
        sx={{
          borderRadius: 24,
          bgcolor: BRAND_LIGHT,
          color: BRAND,
          textTransform: "none",
          fontWeight: 500,
          mb: 1.5,
          "&:hover": { bgcolor: BRAND_LIGHT, filter: "brightness(0.95)" },
        }}
      >
        {t("newList")}
      </Button>
      <Button
        fullWidth
        startIcon={<UploadFileIcon />}
        onClick={() => importInput.current?.click()}
        sx={{
          borderRadius: 24,
          bgcolor: BRAND_LIGHT,
          color: BRAND,
          textTransform: "none",
          fontWeight: 500,
          mb: 1.5,
        }}
      >
        {t("import")}
      </Button>
      <ImportPlacesPicker inputRef={importInput} />
      {createError && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setCreateError(null)}>
          {t(createError.key, createError.values)}
        </Alert>
      )}
      {lists?.map((list) => (
        <Box
          key={list.id}
          sx={{
            display: "flex",
            alignItems: "center",
            borderRadius: 1,
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <ClickableRow
            onClick={() => selectList(list.id)}
            sx={{ flex: 1, gap: 1.5, py: 1.5, px: 1 }}
          >
            <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
              {resolveListIcon(list.icon)}
            </Box>

            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="body2"
                noWrap
                sx={{
                  fontWeight: 500,
                }}
              >
                {resolveListName(list.name)}
              </Typography>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
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
            </Box>
          </ClickableRow>
          <IconButton
            size="small"
            aria-label={t("itemOptions", { name: resolveListName(list.name) })}
            onClick={(e) => handleMenuOpen(e, list)}
            sx={{ flexShrink: 0 }}
          >
            <MoreVertIcon fontSize="small" />
          </IconButton>
        </Box>
      ))}
      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={handleMenuClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <MenuItem onClick={handleDeleteStart}>
          <ListItemIcon>
            <DeleteIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("deleteList")}</ListItemText>
        </MenuItem>
      </Menu>
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
    </Box>
  );
}
