"use client";

import CloseIcon from "@mui/icons-material/Close";
import CollectionsIcon from "@mui/icons-material/Collections";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { isDisplayablePhoto, type PlacePhoto, proxyImageUrl } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useSearchBarClearance } from "../searchBarClearance";
import { PhotoAttribution } from "./PhotoAttribution";

interface Props {
  photos: PlacePhoto[];
  placeName: string;
  onClose?: () => void;
  onViewPhotos: () => void;
  /**
   * Called when the hero image fails to load (e.g. the proxy rejects a
   * non-allowlisted OSM `image=` host). The parent drops the URL so the layout
   * falls back to the no-photo arrangement rather than leaving an empty hero.
   */
  onPhotoError?: (url: string) => void;
}

export function PlacePhotoHero({ photos, placeName, onClose, onViewPhotos, onPhotoError }: Props) {
  const tc = useTranslations("common");
  const tp = useTranslations("photoGallery");
  const searchBarClearance = useSearchBarClearance();
  const photo = photos.find(isDisplayablePhoto);
  if (!photo) return null;

  const photoUrl = proxyImageUrl(photo.url);
  const isValid = photo.url.startsWith("https://") || photo.url.startsWith("http://");
  if (!isValid) return null;

  return (
    <Box
      data-testid="place-photo-hero"
      sx={{
        minHeight: 220,
        display: "grid",
        position: "relative",
        flexShrink: 0,
        overflow: "hidden",
        "&:hover .view-photos-pill, &:focus-within .view-photos-pill": { opacity: 1 },
        "@media (hover: none), (pointer: coarse)": {
          "& .view-photos-pill": { opacity: 1 },
        },
      }}
    >
      <ButtonBase
        onClick={onViewPhotos}
        sx={{
          gridArea: "1 / 1",
          width: "100%",
          minHeight: 220,
          height: "100%",
          display: "block",
          "&:focus-visible": {
            outline: "3px solid",
            outlineColor: "primary.main",
            outlineOffset: -3,
          },
        }}
        aria-label={tp("viewPhotosAccessible", { placeName })}
      >
        <Box
          component="img"
          src={photoUrl}
          alt={placeName}
          onError={() => onPhotoError?.(photo.url)}
          sx={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />

        <Box
          className="view-photos-pill"
          sx={{
            position: "absolute",
            top: searchBarClearance ?? 12,
            left: 12,
            maxWidth: "calc(100% - 76px)",
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            color: "#fff",
            bgcolor: "rgba(0,0,0,0.72)",
            borderRadius: 2,
            px: 1.5,
            py: 0.75,
            opacity: 0,
            transition: "opacity 0.2s ease",
            pointerEvents: "none",
          }}
        >
          <CollectionsIcon sx={{ fontSize: 18, flexShrink: 0 }} />
          <Typography
            variant="body2"
            noWrap
            sx={{
              fontWeight: 500,
              minWidth: 0,
            }}
          >
            {tp("viewPhotos")}
          </Typography>
        </Box>
      </ButtonBase>
      {/* Attribution badge */}
      <Box
        onClick={(e) => e.stopPropagation()}
        sx={{
          gridArea: "1 / 1",
          alignSelf: "end",
          justifySelf: "end",
          zIndex: 1,
          m: 0.75,
          bgcolor: "rgba(0,0,0,0.6)",
          borderRadius: 0.5,
          px: 0.5,
          py: 0.125,
          maxWidth: "calc(100% - 12px)",
          fontSize: "0.625rem",
          color: "#fff",
          lineHeight: 1.3,
          "& a": { fontSize: "inherit" },
        }}
      >
        <PhotoAttribution photo={photo} color="#fff" compact />
      </Box>
      {/* Close button */}
      {onClose && (
        <IconButton
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label={tc("close")}
          sx={{
            position: "absolute",
            top: 8,
            right: 8,
            bgcolor: "background.paper",
            borderRadius: "50%",
            boxShadow: 2,
            p: 0.75,
            // `action.hover` is translucent and would let the photo behind
            // show through. Use the opaque theme-aware chip hover.
            "&:hover": { bgcolor: "var(--omx-chip-hover)" },
          }}
        >
          <CloseIcon sx={{ fontSize: 24, color: "text.primary" }} />
        </IconButton>
      )}
    </Box>
  );
}
