"use client";

import CloseIcon from "@mui/icons-material/Close";
import CollectionsIcon from "@mui/icons-material/Collections";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { type PlacePhoto, proxyImageUrl } from "@openmapx/core";
import { useTranslations } from "next-intl";
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
  const photo = photos[0];
  if (!photo) return null;

  const photoUrl = proxyImageUrl(photo.url);
  const isValid = photo.url.startsWith("https://") || photo.url.startsWith("http://");
  if (!isValid) return null;

  const totalCount = photos.length;

  return (
    <Box
      data-testid="place-photo-hero"
      sx={{
        height: 220,
        position: "relative",
        flexShrink: 0,
        overflow: "hidden",
        // Show "View photos" pill only on hover
        "&:hover .view-photos-pill": { opacity: 1 },
      }}
    >
      <ButtonBase
        onClick={onViewPhotos}
        sx={{ width: "100%", height: "100%", display: "block" }}
        aria-label={`View ${totalCount} photos of ${placeName}`}
      >
        <Box
          component="img"
          src={photoUrl}
          alt={placeName}
          onError={() => onPhotoError?.(photo.url)}
          sx={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />

        {/* "View photos" pill — hover-only, semi-transparent black */}
        {totalCount > 0 && (
          <Box
            className="view-photos-pill"
            sx={{
              position: "absolute",
              bottom: 12,
              left: 12,
              display: "flex",
              alignItems: "center",
              gap: 0.75,
              color: "#fff",
              bgcolor: "rgba(0,0,0,0.6)",
              borderRadius: 2,
              px: 1.5,
              py: 0.75,
              opacity: 0,
              transition: "opacity 0.2s ease",
              pointerEvents: "none",
            }}
          >
            <CollectionsIcon sx={{ fontSize: 18 }} />
            <Typography
              variant="body2"
              sx={{
                fontWeight: 500,
              }}
            >
              {tp("viewPhotos")}
            </Typography>
          </Box>
        )}
      </ButtonBase>
      {/* Attribution badge */}
      <Box
        onClick={(e) => e.stopPropagation()}
        sx={{
          position: "absolute",
          bottom: 4,
          right: 6,
          bgcolor: "rgba(0,0,0,0.35)",
          borderRadius: 0.5,
          px: 0.75,
          py: 0.25,
          fontSize: 10,
          color: "rgba(255,255,255,0.85)",
          lineHeight: 1,
          "& a": { fontSize: "inherit" },
        }}
      >
        <PhotoAttribution photo={photo} color="rgba(255,255,255,0.85)" />
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
